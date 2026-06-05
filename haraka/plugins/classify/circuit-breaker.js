"use strict";

class CircuitBreaker {
  /**
   * @param {{ failureThreshold: number, windowMs: number, cooldownMs: number }} options
   */
  constructor(options) {
    this.failureThreshold = options.failureThreshold;
    this.windowMs = options.windowMs;
    this.cooldownMs = options.cooldownMs;
    this.failures = [];
    this.openedAt = null;
  }

  /**
   * @returns {"closed" | "open" | "half_open"}
   */
  state() {
    if (!this.openedAt) return "closed";
    return Date.now() - this.openedAt >= this.cooldownMs ? "half_open" : "open";
  }

  /**
   * @returns {boolean}
   */
  canCall() {
    return this.state() !== "open";
  }

  /**
   * @returns {void}
   */
  recordSuccess() {
    this.failures = [];
    this.openedAt = null;
  }

  /**
   * @returns {void}
   */
  recordFailure() {
    const now = Date.now();
    this.failures = this.failures.filter((ts) => now - ts <= this.windowMs);
    this.failures.push(now);
    if (this.failures.length >= this.failureThreshold) {
      this.openedAt = now;
    }
  }

  /**
   * Numeric state for Prometheus gauges.
   * @returns {number}
   */
  gaugeValue() {
    const state = this.state();
    if (state === "open") return 1;
    if (state === "half_open") return 0.5;
    return 0;
  }
}

module.exports = { CircuitBreaker };
