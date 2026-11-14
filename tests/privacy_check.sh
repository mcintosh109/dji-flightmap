#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# privacy_check.sh - make sure nothing personal is about to be published.
#
# This repository is PUBLIC. It must never contain:
#   - real flight logs (.csv / .geojson / .txt from the drone: they show where you fly)
#   - your network addresses (like 10.x.x.x), except made-up examples
#   - email addresses, map keys or passwords
#
#   bash tests/privacy_check.sh
# ---------------------------------------------------------------------------
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
PROBLEMS=0
problem() { echo "  FAIL  $1"; PROBLEMS=$((PROBLEMS + 1)); }

# Files git would publish (already added, or new and not ignored).
FILES=$(git ls-files --cached --others --exclude-standard | grep -v '^app/static/vendor/')

# 1. No flight logs.
if grep -E '\.(csv|geojson|txt|DAT)$' <<<"$FILES"; then problem "flight log files are about to be published (above)"; fi

# 2. No private network addresses. Made-up examples are allowed:
#    127.0.0.1, 192.0.2.x (documentation range) and 192.168.1.<example>.
ALLOWED='^(127\.0\.0\.1|192\.0\.2\.[0-9]+|192\.168\.1\.(1|10|50|200|x|xx)|0\.0\.0\.0)$'
FOUND=$(grep -ohE '\b(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9x]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9x]{1,3}|192\.168\.[0-9]{1,3}\.[0-9x]{1,3})\b' $FILES 2>/dev/null | sort -u | grep -vE "$ALLOWED" || true)
if [[ -n "$FOUND" ]]; then
  problem "private network address(es) found: $(tr '\n' ' ' <<<"$FOUND")"
  grep -nE "$(tr '\n' '|' <<<"$FOUND" | sed 's/|$//; s/\./\\./g')" $FILES | head -5 | sed 's/^/        /'
fi

# 3. No email addresses (except the made-up / commit-attribution ones).
EMAILS=$(grep -ohE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' $FILES 2>/dev/null | sort -u \
  | grep -vE '^(user@example\.com|noreply@anthropic\.com)$' || true)
if [[ -n "$EMAILS" ]]; then problem "email address(es) found: $(tr '\n' ' ' <<<"$EMAILS")"; fi

# 4. Nothing that looks like a real map key (Mapbox tokens start with pk.eyJ).
if grep -lE 'pk\.eyJ[A-Za-z0-9_-]{20,}' $FILES 2>/dev/null; then problem "a Mapbox token is in the files above"; fi

if [[ $PROBLEMS -eq 0 ]]; then echo "  PASS  nothing personal found"; fi
[[ $PROBLEMS -eq 0 ]]
