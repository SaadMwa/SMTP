FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates swaks \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g Haraka@3.1.1

COPY plugins/classify/package.json ./plugins/classify/package.json
RUN cd plugins/classify && npm install --omit=dev

COPY config /app/config
COPY plugins /app/plugins
COPY entrypoint.sh /app/entrypoint.sh

RUN chmod +x /app/entrypoint.sh

EXPOSE 2525 9090

ENTRYPOINT ["/app/entrypoint.sh"]
