# SMTP Classifier

SMTP relay built with Haraka that classifies incoming email by keyword matching, adds `X-Classification` headers, and forwards to MailHog (or another upstream SMTP server).

**No Ollama required.** The default stack uses a deterministic keyword classifier that works on Windows, macOS, and Linux without GPU drivers, model downloads, or HTTP calls.

## Quick Start

```bash
git clone <repo-url>
cd SMTP
docker compose up --build
```

Wait until both containers are running:

```bash
docker ps
# smtp-haraka   Up
# smtp-mailhog  Up
```

Send a test email:

```bash
docker exec smtp-haraka swaks --to test@example.com --from sender@example.com --server 127.0.0.1:2525 --body "I need a quote for 100 units"
```

Verify classification in MailHog:

```bash
curl -s http://localhost:8025/api/v2/messages | grep "X-Classification"
# Expected: "X-Classification": ["quote_request"]
```

Open MailHog UI: `http://localhost:8025`

## Classification Rules

| Keywords in body/subject | Header value |
| --- | --- |
| quote, pricing, price, estimate, proposal, units, rfq | `quote_request` |
| booking, confirmed, confirmation, reservation, check-in, itinerary | `booking_confirmation` |
| invoice, payment due, amount due, bill, receipt, purchase order | `invoice` |
| (none matched) | `other` |

Every classified message receives:

```text
X-Correlation-ID: <uuid>
X-Classification: quote_request|booking_confirmation|invoice|other
X-Classification-Confidence: 0.70-0.95
X-Classification-Source: keyword_matcher
```

## Architecture

```text
SMTP client
   |
   v
Haraka :2525
   |
   | data_post hook (keyword matcher)
   |  - parse MIME body
   |  - match keywords
   |  - add X-Classification headers
   v
queue/smtp_forward ---------------------> MailHog :1025
```

## Why No Bundled Ollama?

The bundled `ollama/ollama` container fails on many fresh installs with:

```text
exec /bin/ollama: input/output error
```

This is common on Windows Docker Desktop and some Linux setups. Rather than block reviewers on a crashing dependency, the default stack disables Ollama entirely and uses the keyword matcher in `haraka/plugins/classify.js`.

Optional LLM mode (if your machine supports it):

```bash
docker compose --profile llm up --build
```

## Windows 10 Docker Desktop

Haraka binds `0.0.0.0:2525` inside the container. Compose publishes it on all interfaces:

```yaml
ports:
  - "0.0.0.0:2525:2525"
```

If `localhost:2525` fails, test the WSL2 gateway IP:

```powershell
$wslIp = (wsl hostname -I).Trim().Split(" ")[0]
docker exec smtp-haraka swaks --to test@example.com --from sender@example.com --server 127.0.0.1:2525 --body "I need a quote"
Test-NetConnection 127.0.0.1 -Port 2525
Test-NetConnection $wslIp -Port 2525
```

## Configuration

Copy `.env.example` to `.env` to override ports or upstream SMTP:

```text
SMTP_LISTEN_PORT=2525
SMTP_HOST_PORT=2525
UPSTREAM_SMTP_HOST=mailhog
UPSTREAM_SMTP_PORT=1025
```

Haraka plugins (`haraka/config/plugins`):

```text
classify
rcpt_accept
headers
queue/smtp_forward
```

`haraka/config/rcpt_accept.ini` sets `accept_all=true` for the assessment relay.

## Verification Commands

```powershell
# Clean start
docker compose down -v
docker compose up haraka mailhog --build -d

# Wait for Haraka to be ready
Start-Sleep -Seconds 5

# Send test email
docker exec smtp-haraka swaks --to test@example.com --from test@test.com --server 127.0.0.1:2525 --body "I need a quote for 100 units"

# Check classification header
curl -s http://localhost:8025/api/v2/messages | findstr "X-Classification"

# Check Haraka logs
docker logs smtp-haraka --tail 20
```

Expected output:

```text
"X-Classification": ["quote_request"]
```

## Optional: Prometheus Metrics

```bash
docker compose --profile metrics up --build
```

Prometheus UI: `http://localhost:9091`

## Tests

```bash
bash ./test/integration_test.sh
```

Requires `swaks` and `curl` on the host. The integration test validates that classification headers reach MailHog.
