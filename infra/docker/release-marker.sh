#!/bin/sh
# Marks an image as a LUME release (licensing L-C): LUME_RELEASE=1 writes <dir>/release.json with the version.
# A release build trusts only its compiled-in licence keys and always enforces its licence (ruling R4).
# Usage (in a Dockerfile): sh release-marker.sh "$LUME_RELEASE" "$LUME_VERSION" /app
set -eu
release="${1:-}"
version="${2:-}"
dir="${3:?usage: release-marker.sh <release> <version> <dir>}"
[ "$release" = "1" ] || exit 0
# Exactly X.Y.Z (digits and two dots, no part empty): anything else would read as a development build.
case "$version" in
  .* | *. | *..*) bad=1 ;;
  *) [ "$(printf '%s' "$version" | tr -d '0-9')" = ".." ] && bad=0 || bad=1 ;;
esac
if [ "$bad" = 1 ]; then
  echo "a release needs its version (X.Y.Z), got '$version'" >&2
  exit 1
fi
mkdir -p "$dir"
printf '{"release":true,"version":"%s"}\n' "$version" > "$dir/release.json"
