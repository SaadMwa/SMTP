"use strict";

const LABELS = ["quote_request", "booking_confirmation", "invoice", "other"];

class LlmClient {
  /**
   * @param {{ baseUrl: string, primaryModel: string, fallbackModel: string, timeoutMs: number, retries: number, fetchImpl?: typeof fetch }} options
   */
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.primaryModel = options.primaryModel;
    this.fallbackModel = options.fallbackModel;
    this.timeoutMs = options.timeoutMs;
    this.retries = options.retries;
    this.fetch = options.fetchImpl || fetch;
  }

  /**
   * @param {string} text
   * @param {string} correlationId
   * @returns {Promise<{ classification: string, confidence: number, model: string, raw: string }>}
   * @throws {Error} when Ollama is unreachable or every model fails.
   */
  async classify(text, correlationId) {
    const prompt = this.prompt(text);
    const models = [this.primaryModel, this.fallbackModel].filter(Boolean);
    let lastError;
    for (const model of models) {
      for (let attempt = 0; attempt <= this.retries; attempt += 1) {
        try {
          const raw = await this.generate(model, prompt, correlationId);
          const parsed = this.parse(raw);
          return { ...parsed, model, raw };
        } catch (err) {
          lastError = err;
          if (attempt < this.retries) await this.sleep(100);
        }
      }
    }
    throw new Error(`Ollama classification failed after fallback models: ${lastError.message}`);
  }

  /**
   * @returns {Promise<object>}
   */
  async health() {
    const response = await this.fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) throw new Error(`Ollama health check failed: HTTP ${response.status}`);
    return response.json();
  }

  /**
   * @returns {Promise<Array<object>>}
   */
  async warmup() {
    const results = [];
    for (const model of [this.primaryModel, this.fallbackModel].filter(Boolean)) {
      const raw = await this.generate(model, "Reply only with: other 0.50", "warmup");
      results.push({ model, raw: raw.slice(0, 120) });
    }
    return results;
  }

  /**
   * @param {string} model
   * @param {string} prompt
   * @param {string} correlationId
   * @returns {Promise<string>}
   */
  async generate(model, prompt, correlationId) {
    const response = await this.fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
      },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature: 0.1,
          top_p: 0.8,
          num_predict: 32,
        },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Ollama unreachable: HTTP ${response.status}; check docker logs smtp-ollama`);
    }
    const data = await response.json();
    return String(data.response || "");
  }

  /**
   * @param {string} body
   * @returns {string}
   */
  prompt(body) {
    return `You classify emails for an SMTP relay.
Return exactly one line: label confidence
Labels: quote_request, booking_confirmation, invoice, other
Confidence is a decimal from 0.00 to 1.00.

Examples:
Email: "Can you send pricing for 25 rooms next Friday?"
Answer: quote_request 0.91
Email: "Your booking ABC123 is confirmed for June 18."
Answer: booking_confirmation 0.94
Email: "Invoice #7781 is attached. Payment due in 15 days."
Answer: invoice 0.95
Email: "Thanks for lunch yesterday."
Answer: other 0.82

Email:
"""${body.slice(0, 4000)}"""
Answer:`;
  }

  /**
   * @param {string} raw
   * @returns {{ classification: string, confidence: number }}
   */
  parse(raw) {
    const lowered = raw.toLowerCase();
    const label = LABELS.find((candidate) => new RegExp(`\\b${candidate}\\b`).test(lowered)) || "other";
    const confidenceMatch = lowered.match(/(?:confidence|probability|score)?\s*[:=]?\s*(0?\.\d+|1(?:\.0+)?|0(?:\.0+)?)/);
    const confidence = confidenceMatch ? Number(confidenceMatch[1]) : this.heuristicConfidence(label, lowered);
    return {
      classification: label,
      confidence: Math.max(0, Math.min(1, Number.isFinite(confidence) ? confidence : 0.55)),
    };
  }

  /**
   * @param {string} label
   * @param {string} raw
   * @returns {number}
   */
  heuristicConfidence(label, raw) {
    return raw.includes(label) ? 0.76 : 0.55;
  }

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = { LlmClient, LABELS };
