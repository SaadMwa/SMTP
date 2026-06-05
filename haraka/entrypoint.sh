#!/usr/bin/env sh
set -eu

cat > /app/config/smtp.ini <<EOF
listen_host=0.0.0.0
port=${SMTP_LISTEN_PORT:-2525}
nodes=1
EOF

cat > /app/config/connection.ini <<EOF
[haproxy]
hosts[]=203.0.113.254

[headers]
max_received_count=100

[max]
bytes=26214400
line_length=998
data_line_length=1000
mime_parts=1000

[uuid]
deny_chars=
banner_chars=4
EOF

mkdir -p /app/config/queue
cat > /app/config/smtp_forward.ini <<EOF
host=${UPSTREAM_SMTP_HOST:-${UPSTREAM_HOST:-mailhog}}
port=${UPSTREAM_SMTP_PORT:-${UPSTREAM_PORT:-1025}}
enable_tls=false
enable_outbound=true
check_recipient=false
EOF

cat > /app/config/queue/smtp_forward.json <<EOF
{
  "host": "${UPSTREAM_SMTP_HOST:-${UPSTREAM_HOST:-mailhog}}",
  "port": ${UPSTREAM_SMTP_PORT:-${UPSTREAM_PORT:-1025}},
  "enable_tls": false
}
EOF

exec haraka -c /app
