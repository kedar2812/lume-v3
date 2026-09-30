#!/usr/bin/env bash
# The fleet library's own check (used by fleet.test.ts): target a client, run two steps there.
set -euo pipefail
# shellcheck source=scripts/fleet/lib.sh
. "$(dirname "$0")/lib.sh"
parse_dry "$@"
target "${ARGS[0]:?usage: selftest.sh <slug> [--dry-run]}"
remote uptime
remote docker ps
