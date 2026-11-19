#!/bin/sh
# Make sure the data folder is writable by the unprivileged "node" user, then drop root.
# Docker creates missing bind-mount folders as root, which the app can't write to.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR" 2>/dev/null || echo "[entrypoint] Warning: could not change the owner of $DATA_DIR"
  exec su-exec node "$@"
fi
exec "$@"
