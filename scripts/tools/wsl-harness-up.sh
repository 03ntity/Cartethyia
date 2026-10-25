#!/bin/sh
# Starts the disposable Postgres + Redis the Phase F harness needs, inside the
# local WSL2 Debian instance, and verifies both are reachable.
#
# WSL2 here has no systemd, so `service` (not systemctl) is the start path, and
# services do not survive `wsl --shutdown` — re-run this after one.
#
# Idempotent: safe to run when both services are already up.
set -e

echo "[harness] starting redis-server"
service redis-server start 2>&1 | tail -1

echo "[harness] starting postgresql"
service postgresql start 2>&1 | tail -1

# Postgres needs a moment before it accepts connections.
sleep 3

echo "[harness] verifying"
redis-cli -u "redis://127.0.0.1:6379/5" ping
PGPASSWORD=cartethyia_test \
  psql "postgres://cartethyia_test:cartethyia_test@127.0.0.1:5432/cartethyia_gwtest" \
  -tAc "SELECT current_user || '@' || current_database();"

echo "[harness] up"
