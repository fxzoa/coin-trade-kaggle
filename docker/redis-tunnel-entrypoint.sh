#!/bin/sh
set -eu
for k in SSH_TARGET SSH_PORT REMOTE_REDIS_PORT LOCAL_REDIS_PORT; do
  eval "v=\${$k:-}"
  [ -n "$v" ] || { echo "ERROR: $k is not set" >&2; exit 1; }
done
[ -f /ssh/id_key ] || { echo "ERROR: /ssh/id_key not found" >&2; exit 1; }
cp /ssh/id_key /tmp/id_key && chmod 600 /tmp/id_key
exec ssh -N \
  -i /tmp/id_key -p "$SSH_PORT" \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/known_hosts \
  -L "0.0.0.0:${LOCAL_REDIS_PORT}:localhost:${REMOTE_REDIS_PORT}" \
  "$SSH_TARGET"
