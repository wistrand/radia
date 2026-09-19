#!/bin/bash
# The standby's entrypoint: clone the primary on first start, then run as a hot standby.
#
# `cluster_name=standby1` is the application_name the walreceiver reports, which is the name the
# primary's `synchronous_standby_names` waits for. `pg_basebackup -R` writes standby.signal and the
# primary_conninfo; the password comes from PGPASSWORD in the environment, which the server
# inherits for the walreceiver's reconnects.
set -euo pipefail
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  until pg_isready -h pg-primary -p 5432 -q; do sleep 1; done
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"
  gosu postgres pg_basebackup -h pg-primary -U replicator -D "$PGDATA" -R -X stream
fi
exec docker-entrypoint.sh postgres -c hot_standby=on -c cluster_name=standby1 \
  -c shared_preload_libraries=pg_stat_statements
