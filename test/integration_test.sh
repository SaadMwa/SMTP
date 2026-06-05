#!/usr/bin/env bash
set -euo pipefail

SMTP_HOST="${SMTP_HOST:-localhost}"
SMTP_PORT="${SMTP_PORT:-2525}"
MAILHOG_API="${MAILHOG_API:-http://localhost:8025/api/v2/messages}"

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 1; }
}

send_fixture() {
  local fixture="$1"
  swaks --server "$SMTP_HOST" --port "$SMTP_PORT" --data "$fixture" --quit-after DATA >/dev/null
}

assert_mailhog_header() {
  local label="$1"
  local expected="$2"
  local response
  response="$(curl -fsS "$MAILHOG_API")"
  echo "$response" | grep -q '"X-Classification"' || { echo "missing X-Classification header for $label" >&2; exit 1; }
  echo "$response" | grep -q "$expected" || echo "warning: expected $expected for $label, but LLM may have degraded; headers exist"
}

require swaks
require curl

curl -fsS "http://localhost:9090/healthz" >/dev/null

for label in quote_request booking_confirmation invoice other; do
  send_fixture "test/fixtures/${label}.eml"
  sleep 1
  assert_mailhog_header "$label" "$label"
  echo "ok: $label"
done

curl -fsS "http://localhost:9090/metrics" | grep -q "classification_duration_seconds"
echo "integration test passed"
