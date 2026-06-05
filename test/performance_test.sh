#!/usr/bin/env bash
set -euo pipefail

SMTP_HOST="${SMTP_HOST:-localhost}"
SMTP_PORT="${SMTP_PORT:-2525}"
COUNT="${COUNT:-10}"

command -v swaks >/dev/null 2>&1 || { echo "missing required command: swaks" >&2; exit 1; }

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

for i in $(seq 1 "$COUNT"); do
  start="$(date +%s%3N)"
  swaks --server "$SMTP_HOST" --port "$SMTP_PORT" --data test/fixtures/quote_request.eml --quit-after DATA >/dev/null
  end="$(date +%s%3N)"
  echo $((end - start)) >> "$tmp"
done

p95="$(sort -n "$tmp" | awk -v n="$COUNT" 'BEGIN { idx=int(n*0.95); if (idx < 1) idx=1 } NR==idx { print $1 }')"
avg="$(awk '{ sum += $1 } END { printf "%.0f", sum / NR }' "$tmp")"
echo "sent=$COUNT avg_ms=$avg p95_ms=$p95"
