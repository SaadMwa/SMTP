.PHONY: up down test perf failure logs metrics warmup

up:
	docker compose up --build

down:
	docker compose down

test:
	./test/integration_test.sh

perf:
	./test/performance_test.sh

failure:
	./test/failure_test.sh

logs:
	docker logs -f smtp-haraka

metrics:
	curl -fsS http://localhost:9090/metrics

warmup:
	curl -fsS http://localhost:9090/warmup
