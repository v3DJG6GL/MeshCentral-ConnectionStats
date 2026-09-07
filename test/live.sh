#!/usr/bin/env sh
# Runs the whole test suite with real PostgreSQL, MariaDB, MySQL and MongoDB servers in Docker.
# Usage: test/live.sh [--keep]     (--keep leaves the containers running for another round)
set -eu
cd "$(dirname "$0")/.."
COMPOSE="docker compose -f test/docker-compose.yml"
$COMPOSE up -d --wait
export CS_TEST_POSTGRES="postgres://meshcentral:meshcentral@127.0.0.1:55432/meshcentral"
export CS_TEST_MARIADB="mariadb://meshcentral:meshcentral@127.0.0.1:33306/meshcentral"
export CS_TEST_MYSQL="mysql://meshcentral:meshcentral@127.0.0.1:33307/meshcentral"
export CS_TEST_MONGODB="mongodb://127.0.0.1:37017/meshcentral"
status=0
npm test || status=$?
if [ "${1:-}" != "--keep" ]; then $COMPOSE down -v; fi
exit $status
