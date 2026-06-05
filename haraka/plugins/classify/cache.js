"use strict";

const crypto = require("crypto");

class ClassificationCache {
  /**
   * @param {{ ttlMs: number, maxEntries?: number }} options
   */
  constructor(options) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries || 1000;
    this.store = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Builds a stable cache key from the first 500 characters of normalized body text.
   * @param {string} body
   * @returns {string}
   */
  key(body) {
    return crypto
      .createHash("sha256")
      .update((body || "").trim().toLowerCase().slice(0, 500))
      .digest("hex");
  }

  /**
   * @param {string} key
   * @returns {{ classification: string, confidence: number, model: string } | null}
   */
  get(key) {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    return entry.value;
  }

  /**
   * @param {string} key
   * @param {{ classification: string, confidence: number, model: string }} value
   * @returns {void}
   */
  set(key, value) {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /**
   * @returns {number}
   */
  hitRatio() {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }
}

module.exports = { ClassificationCache };
