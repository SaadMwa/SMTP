"use strict";

const crypto = require("crypto");
const { simpleParser } = require("mailparser");
const { ClassificationCache } = require("./cache");
const { CircuitBreaker } = require("./circuit-breaker");
const { LlmClient } = require("./llm-client");
const { MetricsServer } = require("./metrics");

const envInt = (name, fallback) => {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) ? value : fallback;
};

exports.register = function register() {
  this.name = "classify";
  this.cache = new ClassificationCache({
    ttlMs: envInt("CLASSIFIER_CACHE_TTL_MS", 3600000),
  });
  this.circuitBreaker = new CircuitBreaker({
    failureThreshold: envInt("CIRCUIT_FAILURE_THRESHOLD", 3),
    windowMs: envInt("CIRCUIT_WINDOW_MS", 30000),
    cooldownMs: envInt("CIRCUIT_COOLDOWN_MS", 30000),
  });
  this.llm = new LlmClient({
    baseUrl: process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST || "http://ollama:11434",
    primaryModel: process.env.OLLAMA_PRIMARY_MODEL || process.env.OLLAMA_MODEL || "tinyllama",
    fallbackModel: process.env.OLLAMA_FALLBACK_MODEL || "phi",
    timeoutMs: envInt("CLASSIFIER_TIMEOUT_MS", 3000),
    retries: envInt("CLASSIFIER_RETRIES", 1),
  });
  this.rateLimit = {
    maxPerSecond: envInt("RATE_LIMIT_EMAILS_PER_SECOND", 10),
    buckets: new WeakMap(),
  };
  this.metrics = new MetricsServer({
    port: envInt("METRICS_PORT", 9090),
    cache: this.cache,
    circuitBreaker: this.circuitBreaker,
    warmup: () => this.llm.warmup(),
    logger: (level, event, fields) => structuredLog(this, level, event, fields),
  });

  this.register_hook("connect", "hook_connect");
  this.register_hook("data_post", "hook_data_post");
  this.metrics.start();

  process.on("SIGHUP", () => {
    reloadRuntimeConfig(this);
    structuredLog(this, "info", "runtime_config_reloaded", { signal: "SIGHUP" });
  });
};

/**
 * Rate limit mail transactions per connection before DATA.
 * @param {Function} next
 * @param {object} connection
 * @returns {void}
 */
exports.hook_connect = function hookConnect(next, connection) {
  this.rateLimit.buckets.set(connection, { count: 0, resetAt: Date.now() + 1000 });
  next();
};

/**
 * Classifies the finalized message after DATA has been accepted.
 *
 * WHY data_post:
 * - rcpt_to only sees envelope recipients; the MIME body is not available.
 * - data hooks stream chunks but require careful buffering and MIME boundary handling.
 * - queue_outbound runs after queueing decisions, making classification headers harder to
 *   reason about before relay plugins persist or forward the message.
 * - data_post gives us a complete transaction.message_stream while still allowing header
 *   mutation before queue/smtp_forward relays to MailHog or a production upstream.
 *
 * @param {Function} next
 * @param {object} connection
 * @returns {Promise<void>}
 */
exports.hook_data_post = async function hookDataPost(next, connection) {
  const started = process.hrtime.bigint();
  const transaction = connection.transaction;
  const correlationId = getOrCreateCorrelationId(transaction);

  try {
    reloadRuntimeConfig(this);
    if (!consumeRateLimit(this, connection)) {
      addHeader(transaction, "X-Classification", "other");
      addHeader(transaction, "X-Classification-Confidence", "0.00");
      addHeader(transaction, "X-Classification-Error", "rate_limited");
      structuredLog(this, "warn", "classification_rate_limited", { correlation_id: correlationId });
      next();
      return;
    }

    const body = await extractBodyText(transaction);
    const cacheKey = this.cache.key(body);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      applyClassification(transaction, correlationId, cached, "cache");
      this.metrics.success.inc({ model: cached.model || "cache", source: "cache" });
      this.metrics.duration.observe({ result: "success", model: cached.model || "cache" }, elapsedSeconds(started));
      structuredLog(this, "info", "classification_cache_hit", {
        correlation_id: correlationId,
        classification: cached.classification,
        confidence: cached.confidence,
      });
      next();
      return;
    }

    if (!this.circuitBreaker.canCall()) {
      addHeader(transaction, "X-Classification", "other");
      addHeader(transaction, "X-Classification-Confidence", "0.00");
      addHeader(transaction, "X-Classification-Error", "llm_circuit_open");
      this.metrics.failure.inc({ reason: "circuit_open" });
      structuredLog(this, "error", "classification_skipped_circuit_open", { correlation_id: correlationId });
      next();
      return;
    }

    const result = await this.llm.classify(body, correlationId);
    this.circuitBreaker.recordSuccess();
    this.cache.set(cacheKey, result);
    applyClassification(transaction, correlationId, result, "llm");
    this.metrics.success.inc({ model: result.model, source: "llm" });
    this.metrics.duration.observe({ result: "success", model: result.model }, elapsedSeconds(started));
    structuredLog(this, "info", "classification_completed", {
      correlation_id: correlationId,
      classification: result.classification,
      confidence: result.confidence,
      model_used: result.model,
      duration_ms: Math.round(elapsedSeconds(started) * 1000),
    });
    next();
  } catch (err) {
    this.circuitBreaker.recordFailure();
    addHeader(transaction, "X-Classification", "other");
    addHeader(transaction, "X-Classification-Confidence", "0.00");
    addHeader(transaction, "X-Classification-Error", sanitizeHeader(err.message));
    this.metrics.failure.inc({ reason: "llm_error" });
    this.metrics.duration.observe({ result: "failure", model: "none" }, elapsedSeconds(started));
    structuredLog(this, "error", "classification_failed", {
      correlation_id: correlationId,
      error: err.message,
      duration_ms: Math.round(elapsedSeconds(started) * 1000),
    });
    next();
  }
};

/**
 * Extracts human-readable text from multipart, quoted-printable, and base64 messages.
 * @param {object} transaction
 * @returns {Promise<string>}
 */
async function extractBodyText(transaction) {
  const chunks = [];
  await new Promise((resolve, reject) => {
    transaction.message_stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    transaction.message_stream.on("end", resolve);
    transaction.message_stream.on("error", reject);
  });
  const raw = Buffer.concat(chunks);
  const parsed = await simpleParser(raw, { skipImageLinks: true });
  const text = parsed.text || htmlToText(parsed.html || "") || raw.toString("utf8");
  return text.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim();
}

/**
 * Re-reads env-backed runtime knobs. Docker env itself is process scoped, but this
 * keeps the plugin dependency-injection friendly and lets Haraka supervisors or
 * tests mutate process.env and trigger SIGHUP without rebuilding the service.
 * @param {object} plugin
 * @returns {void}
 */
function reloadRuntimeConfig(plugin) {
  plugin.cache.ttlMs = envInt("CLASSIFIER_CACHE_TTL_MS", plugin.cache.ttlMs);
  plugin.circuitBreaker.failureThreshold = envInt("CIRCUIT_FAILURE_THRESHOLD", plugin.circuitBreaker.failureThreshold);
  plugin.circuitBreaker.windowMs = envInt("CIRCUIT_WINDOW_MS", plugin.circuitBreaker.windowMs);
  plugin.circuitBreaker.cooldownMs = envInt("CIRCUIT_COOLDOWN_MS", plugin.circuitBreaker.cooldownMs);
  plugin.llm.baseUrl = (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST || plugin.llm.baseUrl).replace(/\/$/, "");
  plugin.llm.primaryModel = process.env.OLLAMA_PRIMARY_MODEL || process.env.OLLAMA_MODEL || plugin.llm.primaryModel;
  plugin.llm.fallbackModel = process.env.OLLAMA_FALLBACK_MODEL || plugin.llm.fallbackModel;
  plugin.llm.timeoutMs = envInt("CLASSIFIER_TIMEOUT_MS", plugin.llm.timeoutMs);
  plugin.llm.retries = envInt("CLASSIFIER_RETRIES", plugin.llm.retries);
  plugin.rateLimit.maxPerSecond = envInt("RATE_LIMIT_EMAILS_PER_SECOND", plugin.rateLimit.maxPerSecond);
}

/**
 * @param {object} transaction
 * @returns {string}
 */
function getOrCreateCorrelationId(transaction) {
  const existing = transaction.header.get("X-Correlation-ID");
  const id = existing || crypto.randomUUID();
  addHeader(transaction, "X-Correlation-ID", id);
  return id;
}

/**
 * @param {object} transaction
 * @param {string} correlationId
 * @param {{ classification: string, confidence: number, model: string }} result
 * @param {string} source
 * @returns {void}
 */
function applyClassification(transaction, correlationId, result, source) {
  addHeader(transaction, "X-Correlation-ID", correlationId);
  addHeader(transaction, "X-Classification", result.classification);
  addHeader(transaction, "X-Classification-Confidence", result.confidence.toFixed(2));
  addHeader(transaction, "X-Classification-Model", result.model || source);
  addHeader(transaction, "X-Classification-Source", source);
}

/**
 * @param {object} transaction
 * @param {string} key
 * @param {string} value
 * @returns {void}
 */
function addHeader(transaction, key, value) {
  transaction.add_header(key, sanitizeHeader(String(value)));
}

/**
 * @param {string} value
 * @returns {string}
 */
function sanitizeHeader(value) {
  return value.replace(/[\r\n]/g, " ").slice(0, 240);
}

/**
 * @param {string | false} html
 * @returns {string}
 */
function htmlToText(html) {
  if (!html) return "";
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {bigint} started
 * @returns {number}
 */
function elapsedSeconds(started) {
  return Number(process.hrtime.bigint() - started) / 1e9;
}

/**
 * @param {object} plugin
 * @param {object} connection
 * @returns {boolean}
 */
function consumeRateLimit(plugin, connection) {
  const bucket = plugin.rateLimit.buckets.get(connection) || { count: 0, resetAt: Date.now() + 1000 };
  const now = Date.now();
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + 1000;
  }
  bucket.count += 1;
  plugin.rateLimit.buckets.set(connection, bucket);
  return bucket.count <= plugin.rateLimit.maxPerSecond;
}

/**
 * Emits JSON logs while still flowing through Haraka's logger.
 * @param {object} plugin
 * @param {"debug" | "info" | "warn" | "error"} level
 * @param {string} event
 * @param {object} fields
 * @returns {void}
 */
function structuredLog(plugin, level, event, fields) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    service: "smtp-classifier",
    ...fields,
  });
  const method = level === "error" ? "logerror" : level === "warn" ? "logwarn" : level === "debug" ? "logdebug" : "loginfo";
  if (plugin && typeof plugin[method] === "function") plugin[method](line);
  else console.log(line);
}
