#!/bin/sh
# Marks an image as a LUME release (licensing L-C): LUME_RELEASE=1 writes <dir>/release.json with the version.
# A release build trusts only its compiled-in licence keys and always enforces its licence (ruling R4).
# Usage (in a Dockerfile): sh release-marker.sh "$LUME_RELEASE" "$LUME_VERSION" /app
set -eu
release="${1:-}"
version="${2:-}"
dir="${3:?usage: release-marker.sh <release> <version> <dir>}"
[ "$release" = "1" ] || exit 0
case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "a release needs its version (X.Y.Z), got '$version'" >&2; exit 1 ;;
esac
mkdir -p "$dir"
printf '{"release":true,"version":"%s"}\n' "$version" > "$dir/release.json"
