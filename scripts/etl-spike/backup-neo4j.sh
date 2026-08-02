#!/usr/bin/env bash
# Back up the local Neo4j :Person graph before load.ts wipes it.
#
# Why: data/ is gitignored, so the intermediate JSON that produced the current
# graph is not committed — the running DB is the only copy. load.ts starts with
# `MATCH (p:Person) DETACH DELETE p`, so a bad ETL run is unrecoverable without
# this dump (Wikidata changes daily; the same input can't be regenerated).
#
# Neo4j 5 Community can't dump a running DB, so we stop the server and run a
# one-off container over the same volume. Output → scripts/etl-spike/data/backups
# (under the gitignored data/ dir). Restore instructions are in NOTES.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUP_DIR="$REPO_ROOT/scripts/etl-spike/data/backups"
VOLUME="kakeizu_neo4j-data"
# docker-compose.yml pins container_name, so plain docker addresses the same
# container compose would — and works where the compose CLI plugin is missing.
CONTAINER="kakeizu-neo4j"

mkdir -p "$BACKUP_DIR"

# The dump reads the volume, not the container, so a torn-down container is still
# backed up — there is just nothing to stop or restart. Only skipping the stop
# would abort the run under `set -e`, losing the backup this script exists to take.
WAS_RUNNING=$(docker ps --quiet --filter "name=^${CONTAINER}$")

if [ -n "$WAS_RUNNING" ]; then
  echo "Stopping neo4j…"
  docker stop "$CONTAINER"
fi

echo "Dumping database 'neo4j' → $BACKUP_DIR/neo4j.dump"
docker run --rm \
  -v "$VOLUME:/data" \
  -v "$BACKUP_DIR:/backups" \
  neo4j:5 neo4j-admin database dump neo4j --to-path=/backups --overwrite-destination=true

if [ -n "$WAS_RUNNING" ]; then
  echo "Restarting neo4j…"
  docker start "$CONTAINER"
fi

echo "Done. Backup at $BACKUP_DIR/neo4j.dump"
