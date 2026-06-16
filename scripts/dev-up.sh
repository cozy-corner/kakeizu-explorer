#!/usr/bin/env bash
# Local dev launcher — run this to start the app. Does the full startup in order
# so no step gets skipped.
set -euo pipefail

cd "$(dirname "$0")/.."

# Always run bun install first — unconditionally, every launch. You can't reliably
# know whether a pulled branch added a dependency, so don't gate this on "did deps
# change". A tracked dep that isn't installed locally surfaces only at runtime as a
# Next build error ("Module not found: Can't resolve '<pkg>'") that 500s every route.
echo "==> bun install"
bun install

# Fixed compose project name => no-op if Neo4j is already running, and no port/name
# clash across worktrees (see docker-compose.yml header).
echo "==> docker compose up -d (Neo4j)"
docker compose up -d

# Wait for Neo4j before the app starts, else the first /api/* request races the DB
# and 503s. 7474 serves the discovery JSON once it's accepting connections.
echo -n "==> waiting for Neo4j "
for _ in $(seq 1 60); do
  if curl -sf http://localhost:7474 >/dev/null 2>&1; then
    echo "ready"
    break
  fi
  echo -n "."
  sleep 1
done

echo "==> bun run dev"
exec bun run dev
