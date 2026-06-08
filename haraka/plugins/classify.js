'use strict';

// Keyword-based email classifier — no HTTP calls, no external dependencies.
// Enable with a line containing only: classify

const crypto = require('crypto');

const LABELS = ['quote_request', 'booking_confirmation', 'invoice', 'other'];

const KEYWORDS = {
  quote_request: ['quote', 'pricing', 'price', 'estimate', 'proposal', 'units', 'rfq'],
  booking_confirmation: ['booking', 'confirmed', 'confirmation', 'reservation', 'check-in', 'itinerary'],
  invoice: ['invoice', 'payment due', 'amount due', 'bill', 'receipt', 'purchase order'],
};

exports.register = function register() {
  this.register_hook('data', 'hook_data');
  this.register_hook('data_post', 'hook_data_post');
  this.loginfo('[classify] keyword matcher registered (hooks: data, data_post)');
};

exports.hook_data = function hookData(next, connection) {
  if (connection.transaction) {
    connection.transaction.parse_body = true;
  }
  next();
};

exports.hook_data_post = function hookDataPost(next, connection) {
  try {
    const txn = connection.transaction;
    if (!txn) {
      next();
      return;
    }

    const body = extractBody(txn);
    const result = classify(body);
    const correlationId = getCorrelationId(txn);

    txn.add_header('X-Correlation-ID', correlationId);
    txn.add_header('X-Classification', result.label);
    txn.add_header('X-Classification-Confidence', result.confidence.toFixed(2));
    txn.add_header('X-Classification-Source', 'keyword_matcher');

    connection.loginfo('[classify] ' + JSON.stringify({
      label: result.label,
      confidence: result.confidence,
      body_chars: body.length,
      correlation_id: correlationId,
    }));
  } catch (err) {
    const txn = connection.transaction;
    if (txn) {
      txn.add_header('X-Classification', 'other');
      txn.add_header('X-Classification-Confidence', '0.00');
      txn.add_header('X-Classification-Source', 'keyword_matcher');
      txn.add_header('X-Classification-Error', sanitizeHeader(err.message));
    }
    connection.logerror('[classify] error: ' + err.message);
  }
  next();
};

function classify(text) {
  const normalized = String(text || '').toLowerCase();
  const scores = { other: 0 };

  for (const label of LABELS) {
    if (label === 'other') continue;
    scores[label] = score(normalized, KEYWORDS[label]);
  }

  let label = 'other';
  for (const candidate of LABELS) {
    if (candidate !== 'other' && scores[candidate] > scores[label]) {
      label = candidate;
    }
  }

  const confidence = label === 'other'
    ? 0.50
    : Math.min(0.95, 0.70 + scores[label] * 0.08);

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

function sanitizeHeader(value) {
  return String(value || '').replace(/[\r\n]/g, ' ').slice(0, 180);
}
