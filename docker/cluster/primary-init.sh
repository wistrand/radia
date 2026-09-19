#!/bin/bash
# Runs once, when the primary's data directory is initialised: the role the standby streams as, and
# the pg_hba line that lets it. pg_stat_statements is what counts queries per operation across every
# Radia instance, since a separate process cannot wrap the adapter the way bench/suites/chatload.ts does.
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
create role replicator with replication login password 'replicator';
create extension if not exists pg_stat_statements;
SQL
echo "host replication replicator all scram-sha-256" >>"$PGDATA/pg_hba.conf"
