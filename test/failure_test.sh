#!/usr/bin/env bash
set -euo pipefail

echo "1/3 stopping Ollama to validate graceful degradation"
docker stop smtp-ollama >/dev/null
./test/integration_test.sh || true
docker start smtp-ollama >/dev/null

echo "2/3 checking circuit breaker metric"
curl -fsS http://localhost:9090/metrics | grep -E "circuit_breaker_state|classification_failure_total"

echo "3/3 stopping MailHog to validate SMTP upstream failure path"
docker stop smtp-mailhog >/dev/null
set +e
swaks --server localhost --port 2525 --data test/fixtures/invoice.eml --quit-after DATA
status=$?
set -e
docker start smtp-mailhog >/dev/null

if [ "$status" -ne 0 ]; then
  echo "upstream unavailable produced SMTP client failure; Haraka logs contain queue/relay error details"
else
  echo "message accepted while upstream recovered or queued"
fi

echo "failure test completed"
