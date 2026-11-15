#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# release-tags.sh - list the RELEASED versions of the project, newest first.
#
#   bash deploy/release-tags.sh [project folder]
#
# A release is a git tag like v4.2.0. A tag without the v (4.2.0) counts
# too, because it is easy to forget the v when making a release on GitHub.
# If both exist for one version, the one with the v is listed.
# (Research: "git tag", "semantic versioning".)
# ---------------------------------------------------------------------------
set -euo pipefail
DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# 1. only names like 4.2.0 or v4.2.0   2. put the bare number in front
# 3. newest number first (the v one first when equal)   4. one per number
git -C "$DIR" tag -l | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' \
  | awk '{ n = $0; sub(/^v/, "", n); print n, $0 }' \
  | sort -k1,1Vr -k2,2r \
  | awk '!seen[$1]++ { print $2 }' || true
