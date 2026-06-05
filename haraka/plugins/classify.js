'use strict';

// Haraka 3.x legacy plugin file.
// Put this file at: /app/plugins/classify.js
// Enable with a line containing only: classify

const crypto = require('crypto');

const LABELS = ['quote_request', 'booking_confirmation', 'invoice', 'other'];

exports.register = function register() {
  this.name = 'classify';
  this.register_hook('init_master', 'hook_init_master');
  this.register_hook('init_child', 'hook_init_child');
  this.register_hook('connect', 'hook_connect');
  this.register_hook('ehlo', 'hook_ehlo');
  this.register_hook('helo', 'hook_helo');
  this.register_hook('mail', 'hook_mail');
  this.register_hook('rcpt', 'hook_rcpt_observe', 50);
  this.register_hook('data', 'hook_data');
  this.register_hook('data_post', 'hook_data_post');
  this.loginfo('[classify] register complete hooks=init_master,init_child,connect,ehlo,helo,mail,rcpt,data,data_post');
};

exports.hook_init_master = function hookInitMaster(next, server) {
  this.loginfo('[classify] hook=init_master status=registered');
  next();
};

exports.hook_init_child = function hookInitChild(next, server) {
  this.loginfo('[classify] hook=init_child status=registered');
  next();
};

exports.hook_connect = function hookConnect(next, connection) {
  log(connection, 'connect', { remote_ip: connection.remote && connection.remote.ip });
  next();
};

exports.hook_ehlo = function hookEhlo(next, connection, helo) {
  log(connection, 'ehlo', { helo: String(helo || '') });
  next();
};

exports.hook_helo = function hookHelo(next, connection, helo) {
  log(connection, 'helo', { helo: String(helo || '') });
  next();
};

exports.hook_mail = function hookMail(next, connection, params) {
  log(connection, 'mail', { from: safeAddress(params && params[0]) });
  next();
};

exports.hook_rcpt_observe = function hookRcptObserve(next, connection, params) {
  log(connection, 'rcpt', { to: safeAddress(params && params[0]) });
  next();
};

exports.hook_data = function hookData(next, connection) {
  if (connection.transaction) {
    connection.transaction.parse_body = true;
    connection.transaction.notes.classify_started_at = Date.now();
  }
  log(connection, 'data', { status: 'parse_body_enabled' });
  next();
};

exports.hook_data_post = function hookDataPost(next, connection) {
  try {
    const txn = connection.transaction;
    if (!txn) {
      log(connection, 'data_post', { status: 'no_transaction' });
      next();
      return;
    }

    const body = extractBody(txn);
    const result = classify(body);
    const correlationId = getCorrelationId(txn);
    const durationMs = Date.now() - (txn.notes.classify_started_at || Date.now());

    txn.add_header('X-Correlation-ID', correlationId);
    txn.add_header('X-Classification', result.label);
    txn.add_header('X-Classification-Confidence', result.confidence.toFixed(2));
    txn.add_header('X-Classification-Source', 'haraka-plugin-data-post');
    txn.add_header('X-Classification-Duration-Ms', String(durationMs));
    txn.add_header('X-Classify-Hook-Executed', 'data_post');

    log(connection, 'data_post', {
      status: 'headers_added',
      classification: result.label,
      confidence: result.confidence.toFixed(2),
      duration_ms: durationMs,
      body_chars: body.length,
      correlation_id: correlationId,
    });
  } catch (err) {
    const txn = connection.transaction;
    if (txn) {
      txn.add_header('X-Classification', 'other');
      txn.add_header('X-Classification-Confidence', '0.00');
      txn.add_header('X-Classification-Error', sanitizeHeader(err.message));
    }
    log(connection, 'data_post', { status: 'error', error: err.message });
  }
  next();
};

function classify(text) {
  const normalized = String(text || '').toLowerCase();
  const scores = {
    quote_request: score(normalized, ['quote', 'pricing', 'price', 'estimate', 'proposal', 'units', 'rfq']),
    booking_confirmation: score(normalized, ['booking', 'confirmed', 'confirmation', 'reservation', 'check-in', 'itinerary']),
    invoice: score(normalized, ['invoice', 'payment due', 'amount due', 'bill', 'receipt', 'purchase order']),
    other: 1,
  };

  let label = 'other';
  for (const candidate of LABELS) {
    if (scores[candidate] > scores[label]) label = candidate;
  }

  const confidence = label === 'other'
    ? 0.62
    : Math.min(0.95, 0.68 + scores[label] * 0.08);

  return { label, confidence };
}

function score(text, terms) {
  return terms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0);
}

function extractBody(txn) {
  const parts = [];

  if (txn.body && txn.body.bodytext) {
    parts.push(String(txn.body.bodytext));
  }

  if (txn.body && Array.isArray(txn.body.children)) {
    for (const child of txn.body.children) {
      if (child && child.bodytext) parts.push(String(child.bodytext));
    }
  }

  if (parts.length === 0 && txn.header) {
    parts.push(String(txn.header.get('Subject') || ''));
  }

  return parts.join('\n').replace(/\r/g, '').trim();
}

function getCorrelationId(txn) {
  const existing = txn.header && txn.header.get('X-Correlation-ID');
  if (existing) return sanitizeHeader(existing);
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function safeAddress(value) {
  if (!value) return '';
  if (value.original) return String(value.original);
  return String(value);
}

function sanitizeHeader(value) {
  return String(value || '').replace(/[\r\n]/g, ' ').slice(0, 180);
}

function log(connection, hook, fields) {
  const payload = {
    plugin: 'classify',
    hook,
    ...fields,
  };
  connection.loginfo('[classify] ' + JSON.stringify(payload));
}
