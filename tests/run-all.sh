#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# run-all.sh - run every check, in order. Stops at the first part that fails.
#
#   bash tests/run-all.sh
#
# Parts:
#   1. privacy   nothing personal is about to be published
#   2. syntax    every Python, JavaScript and shell file can be read; if the
#                linters "ruff" (Python) and "shellcheck" (shell) are installed,
#                they also look for undefined or unused names and risky shell
#   3. server    tests/test_server.py   (Python, no extra installs)
#   4. browser   tests/browser.test.js  (needs Node.js + Playwright; skipped if missing)
#   5. install   tests/easy-install.test.sh (the one-command install, all in a temp folder)
#                tests/nas-watch.test.sh    (the NAS reconnect helper, all in a temp folder)
#   6. deploy    tests/deploy.test.sh   (only on a throw-away machine; see that file)
# ---------------------------------------------------------------------------
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
export PYTHONDONTWRITEBYTECODE=1

part() { echo; echo "==> $1"; }
fail() { echo; echo "STOPPED: $1 failed. Fix it before pushing."; exit 1; }

part "1/6 Privacy"
bash tests/privacy_check.sh || fail "the privacy check"

part "2/6 Syntax"
ok=1
python3 -m py_compile app/server.py app/flightmap/*.py tests/*.py || ok=0
for f in app/static/*.js tests/*.js docs/*.js; do node --check "$f" || { echo "  bad: $f"; ok=0; }; done
for f in deploy/*.sh tests/*.sh; do bash -n "$f" || { echo "  bad: $f"; ok=0; }; done
python3 -c "import json; json.load(open('app/version.json'))" || ok=0
rm -rf app/__pycache__ app/flightmap/__pycache__ tests/__pycache__
[[ $ok == 1 ]] && echo "  PASS  all files read cleanly" || fail "the syntax check"
# Linters, when installed: undefined/unused names in Python, risky shell.
if python3 -m ruff --version >/dev/null 2>&1; then
  python3 -m ruff check app tests --select F,E9 --quiet && echo "  PASS  ruff: no undefined or unused names" || fail "the Python linter (ruff)"
else
  echo "  SKIP  ruff isn't installed (pip install ruff)"
fi
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -S warning deploy/*.sh tests/*.sh && echo "  PASS  shellcheck: no warnings" || fail "the shell linter (shellcheck)"
else
  echo "  SKIP  shellcheck isn't installed (apt install shellcheck)"
fi

part "3/6 Server"
python3 -m unittest discover -s tests -p 'test_*.py' 2>&1 | tail -4
[[ ${PIPESTATUS[0]} == 0 ]] || fail "the server tests"

part "4/6 Browser"
if node -e "require('playwright')" >/dev/null 2>&1; then
  node tests/browser.test.js || fail "the browser tests"
else
  echo "  SKIP  Playwright isn't installed (npm install playwright && npx playwright install chromium)"
fi

part "5/6 Easy install and the NAS helper"
bash tests/easy-install.test.sh || fail "the easy-install tests"
bash tests/nas-watch.test.sh || fail "the NAS helper tests"

part "6/6 Update scripts"
bash tests/deploy.test.sh || fail "the update-script tests"

echo
echo "All checks passed."
