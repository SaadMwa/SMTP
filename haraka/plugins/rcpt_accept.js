"use strict";

const constants = require("haraka-constants");

exports.register = function register() {
  this.register_hook("rcpt", "hook_rcpt");
};

/**
 * Accepts recipients for the assessment relay.
 *
 * In a production internet-facing deployment this would be replaced with domain,
 * auth, tenant, or ACL checks. This service is intentionally a controlled relay
 * whose job is to classify and forward messages to a configured upstream.
 *
 * @param {Function} next
 * @returns {void}
 */
exports.hook_rcpt = function hookRcpt(next) {
  next(constants.OK);
};
