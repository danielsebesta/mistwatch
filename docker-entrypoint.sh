#!/bin/sh
set -e
# First start: create the config, then run the requested command.
[ -f "$MISTWATCH_HOME/config.toml" ] || node /app/dist/cli.js init >/dev/null
exec node /app/dist/cli.js "$@"
