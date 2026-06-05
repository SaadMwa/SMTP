# SMTP Classifier: AI-Native Email Infrastructure

Production-grade SMTP relay that accepts mail with Haraka, classifies message bodies with a local Ollama LLM, adds traceable classification headers, and relays to MailHog or another upstream SMTP server.

## Quick Start

```bash
docker compose up --build
```

Open:

- SMTP: `localhost:2525`
- MailHog UI: `http://localhost:8025`
- Metrics: `http://localhost:9090/metrics`
- Metrics UI: `http://localhost:9090/metrics/ui`
- Prometheus: `http://localhost:9091`

## Windows 10 Docker Desktop Port Access

Haraka is configured to bind inside the container with:

```ini
listen_host=0.0.0.0
port=2525
```

Compose explicitly publishes ports on all Windows interfaces:

```yaml
ports:
  - "0.0.0.0:2525:2525"
```

`network_mode: host` is not a reliable fix for Docker Desktop Linux containers on Windows 10. If `localhost:2525` fails, test the WSL2 gateway IP from PowerShell:

```powershell
docker compose down
docker compose up --force-recreate --build haraka mailhog prometheus
docker port smtp-haraka
Test-NetConnection 127.0.0.1 -Port 2525
$wslIp = (wsl hostname -I).Trim().Split(" ")[0]
Test-NetConnection $wslIp -Port 2525
```

Send a raw SMTP test without `swaks`:

```powershell
powershell -ExecutionPolicy Bypass -File .\test\windows_send_smtp.ps1 -HostName 127.0.0.1 -Port 2525
```

If localhost forwarding is broken on your Windows 10 build, use the WSL2 IP:

```powershell
$wslIp = (wsl hostname -I).Trim().Split(" ")[0]
powershell -ExecutionPolicy Bypass -File .\test\windows_send_smtp.ps1 -HostName $wslIp -Port 2525
```

Warm the local models:

```bash
curl http://localhost:9090/warmup
```

## Architecture Deep Dive

```text
SMTP client
   |
   v
Haraka :2525
   |
   | data_post hook
   |  - parse MIME body
   |  - cache lookup by body hash
   |  - circuit breaker check
   |  - Ollama classify with fallback model
   |  - add X-Classification headers
   v
queue/smtp_forward ---------------------> MailHog :1025
   |
   +-- upstream down: Haraka queue/retry behavior

Ollama :11434
   |
   +-- timeout/down: X-Classification-Error + circuit breaker

Metrics :9090
   |
   +-- Prometheus scrape on /metrics
```

## Why Data Post Hook?

| Hook | Body available? | Header mutation timing | Decision |
| --- | --- | --- | --- |
| `rcpt_to` | No | Early envelope only | Cannot classify message content |
| `data` | Streaming chunks | Possible but MIME parsing is manual | Useful for streaming future work |
| `data_post` | Complete message | Before queue and forwarding | Best production trade-off here |
| `queue_outbound` | Complete message | Too late for clean relay semantics | Better for outbound-only systems |

`data_post` gives the plugin a complete MIME stream while still allowing headers to be added before `queue/smtp_forward` sends the message upstream.

## Graceful Degradation Matrix

| Failure | User Impact | Mitigation |
| --- | --- | --- |
| LLM timeout | Small delay before fallback | 3s timeout, one retry, circuit breaker, cache |
| Ollama down | Mail still relays with error headers | `X-Classification-Error`, alert-level JSON logs |
| Upstream SMTP down | Relay failure or local queue behavior | Haraka queue plugin logs and retry semantics |
| Repeated LLM failures | Classification skipped temporarily | Circuit opens after 3 failures in 30s |

## Headers

Every accepted message receives:

```text
X-Correlation-ID: <uuid>
X-Classification: quote_request|booking_confirmation|invoice|other
X-Classification-Confidence: 0.87
X-Classification-Model: tinyllama
X-Classification-Source: llm|cache
```

On degradation:

```text
X-Classification: other
X-Classification-Confidence: 0.00
X-Classification-Error: llm_circuit_open
```

## Production Readiness Checklist

- [x] Haraka `data_post` plugin with architecture comments
- [x] Multipart, quoted-printable, base64 body extraction via `mailparser`
- [x] Local LLM classification through Ollama
- [x] TinyLlama primary model with Phi fallback
- [x] Few-shot prompt and defensive response parser
- [x] Circuit breaker pattern
- [x] Response caching
- [x] Graceful degradation
- [x] Prometheus metrics
- [x] Structured JSON logging with correlation IDs
- [x] Graceful shutdown for metrics service
- [x] Integration, performance, and failure test scripts
- [ ] Kubernetes Helm chart
- [ ] Persistent dead letter queue

## Metrics

```text
classification_duration_seconds
classification_success_total
classification_failure_total
circuit_breaker_state
cache_hit_ratio
```

Example:

```bash
curl http://localhost:9090/metrics | grep classification
docker logs smtp-haraka 2>&1 | grep '"correlation_id"'
```

## Tests

Host requirements: `curl`, `docker`, and `swaks`.

```bash
bash ./test/integration_test.sh
bash ./test/performance_test.sh
bash ./test/failure_test.sh
```

The integration test sends one fixture per class and validates that classification headers reached MailHog. The performance test sends 10 messages and reports average and p95 latency. The failure test stops Ollama and MailHog to show degradation behavior.

## Configuration

Use `.env.example` for Compose defaults or copy one of:

```bash
config/development.env
config/production.env
```

Important settings:

```text
OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_PRIMARY_MODEL=tinyllama
OLLAMA_FALLBACK_MODEL=phi
CLASSIFIER_TIMEOUT_MS=3000
CLASSIFIER_RETRIES=1
CIRCUIT_FAILURE_THRESHOLD=3
CIRCUIT_WINDOW_MS=30000
CIRCUIT_COOLDOWN_MS=30000
CLASSIFIER_CACHE_TTL_MS=3600000
RATE_LIMIT_EMAILS_PER_SECOND=10
UPSTREAM_SMTP_HOST=mailhog
UPSTREAM_SMTP_PORT=1025
```

Haraka's built-in `queue/smtp_forward` consumes `config/smtp_forward.ini`; the Compose entrypoint renders that file from the upstream environment variables at container start. The `config/queue/smtp_forward.json` file is retained as a readable service contract for the assessment layout.

Compatibility aliases are also accepted for local overrides: `OLLAMA_HOST`, `OLLAMA_MODEL`, `UPSTREAM_HOST`, and `UPSTREAM_PORT`.

The classifier re-reads env-backed runtime knobs on every message and on `SIGHUP`. In container production, pair this with Compose, systemd, or Kubernetes rollout semantics so every worker has a consistent view.

## Performance Numbers

Representative target numbers for a laptop with warm Ollama models:

| Scenario | P95 latency |
| --- | --- |
| Cold cache | 850ms to 3000ms, depending on model warm state |
| Warm cache | 120ms |
| Throughput | 10 to 15 emails/second with rate limiting |
| Memory | About 1.2GB Ollama plus 256MB Haraka |

Measure locally with:

```bash
./test/performance_test.sh
```

## What I Would Do With More Time

1. Streaming classification: start inference while DATA is still arriving.
2. Adaptive model selection: route obvious messages to TinyLlama and ambiguous ones to Phi.
3. Persistent dead letter queue: store failed classification attempts with replay tooling.
4. A/B testing framework: compare model and prompt versions in production traffic.
5. Terraform and Helm modules: deploy the relay repeatably across environments.
