---
name: release
description: Ship a finished change to DJI Flight Map - raise the version and write plain-English notes, update the README, run every test (including the privacy check), commit, push, and tell the owner exactly how to update. Use after any change to app/ or deploy/, before saying the work is done.
---

# Releasing a change to DJI Flight Map

Follow every step, in order. Don't skip the tests because a change "looks small":
most bugs in this project were found by testing, not by reading.

## 1. Version and notes (`app/version.json`)

- Raise `version` (MAJOR.MINOR.PATCH, based on [semantic versioning](https://semver.org)),
  using **the owner's rule**:
  - bug fix only → last number (2.0.0 → 2.0.1)
  - an improvement to something the app already does → middle number (2.0.1 → 2.1.0), last number back to 0
  - **a whole new function** (like the flight planner was, in 2.0.0), or something that
    needs the owner to do a manual step → first number (2.1.0 → 3.0.0), the others back to 0
  - If unsure which, ask the owner before releasing.
- Set `released` to today's date (`YYYY-MM-DD`).
- Replace `notes` with 2–6 short lines in **plain English, from the owner's
  point of view** ("Flight paths are easier to see on satellite maps"), not code
  talk. The owner reads these in the map's Updates window.

## 2. README

Update every place the change affects: the feature description, the settings
table, troubleshooting, the "How it works" file table. Keep the step-by-step,
beginner-friendly tone (see `CLAUDE.md`).

## 3. Test everything

```bash
FLIGHTMAP_ALLOW_SYSTEM_TEST=1 bash tests/run-all.sh
```

(`FLIGHTMAP_ALLOW_SYSTEM_TEST=1` is only for Claude's throw-away sandbox: that
part writes to `/opt` and `/etc`.)

- All parts must pass, including **1/5 Privacy**.
- If you added a feature, **add a check for it** to `tests/browser.test.js`
  and/or `tests/test_server.py` first, and see it fail before the fix if you can.
- If a test fails, find out whether the app or the test is wrong. Say which in
  your message to the owner.

## 4. Commit and push

- The owner works directly on `main`.
- Commit message: a short title, then what changed and why.
- Push with `git -c push.negotiate=true push origin main`.

## 5. Tell the owner

Keep it short and structured:

1. What changed, in plain words (a small table works well).
2. What was tested, and **what could not be tested** (real map pictures,
   real Proxmox, real Azure). Ask for a screenshot when it matters.
3. How to update, each command in its own block:

```bash
cd /root/dji-flightmap && bash deploy/update-ct.sh
```

Then: press **Ctrl+Shift+R** on the map page, and check the version number
next to "Flight Map" shows the new version.
