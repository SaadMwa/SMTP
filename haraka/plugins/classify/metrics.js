"use strict";

const http = require("http");
const prom = require("prom-client");

class MetricsServer {
  /**
   * @param {{ port: number, cache: { hitRatio: () => number }, circuitBreaker: { gaugeValue: () => number }, logger: Function, warmup: Function }} options
   */
  constructor(options) {
    this.port = options.port;
    this.cache = options.cache;
    this.circuitBreaker = options.circuitBreaker;
    this.logger = options.logger;
    this.warmup = options.warmup;
    this.registry = new prom.Registry();
    prom.collectDefaultMetrics({ register: this.registry });

    this.duration = new prom.Histogram({
      name: "classification_duration_seconds",
      help: "Time spent classifying an email.",
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5],
      labelNames: ["result", "model"],
      registers: [this.registry],
    });
    this.success = new prom.Counter({
      name: "classification_success_total",
      help: "Successful classifications by model and source.",
      labelNames: ["model", "source"],
      registers: [this.registry],
    });
    this.failure = new prom.Counter({
      name: "classification_failure_total",
      help: "Failed classifications by reason.",
      labelNames: ["reason"],
      registers: [this.registry],
    });
    this.circuitState = new prom.Gauge({
      name: "circuit_breaker_state",
      help: "Circuit breaker state: 0 closed, 0.5 half-open, 1 open.",
      registers: [this.registry],
      collect: () => this.circuitState.set(this.circuitBreaker.gaugeValue()),
    });
    this.cacheHitRatio = new prom.Gauge({
      name: "cache_hit_ratio",
      help: "In-memory body hash cache hit ratio.",
      registers: [this.registry],
      collect: () => this.cacheHitRatio.set(this.cache.hitRatio()),
    });
  }

  /**
   * @returns {void}
   */
  start() {
    this.server = http.createServer(async (req, res) => {
      if (req.url === "/metrics") {
        res.setHeader("Content-Type", this.registry.contentType);
        res.end(await this.registry.metrics());
        return;
      }
      if (req.url === "/healthz") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === "/warmup") {
        try {
          const result = await this.warmup();
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.statusCode = 503;
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }
      if (req.url === "/metrics/ui") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(this.ui());
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });

    this.server.listen(this.port, "0.0.0.0", () => {
      this.logger("info", "metrics_server_started", { port: this.port });
    });

    process.on("SIGTERM", () => this.shutdown("SIGTERM"));
    process.on("SIGINT", () => this.shutdown("SIGINT"));
  }

  /**
   * @param {string} signal
   * @returns {void}
   */
  shutdown(signal) {
    this.logger("info", "graceful_shutdown_started", { signal });
    if (this.server) {
      this.server.close(() => {
        this.logger("info", "metrics_server_stopped", { signal });
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 5000).unref();
    }
  }

  /**
   * @returns {string}
   */
  ui() {
    return `<!doctype html>
<html><head><title>SMTP Classifier Metrics</title><meta http-equiv="refresh" content="5">
<style>body{font-family:system-ui;margin:2rem;max-width:980px}pre{background:#111;color:#eee;padding:1rem;overflow:auto}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem}.card{border:1px solid #ddd;border-radius:8px;padding:1rem}</style></head>
<body><h1>SMTP Classifier Metrics</h1><div class="grid">
<div class="card"><h2>Cache Hit Ratio</h2><strong>${this.cache.hitRatio().toFixed(3)}</strong></div>
<div class="card"><h2>Circuit State</h2><strong>${this.circuitBreaker.gaugeValue()}</strong></div>
</div><p>Prometheus scrape endpoint: <code>/metrics</code></p></body></html>`;
  }
}

module.exports = { MetricsServer };
