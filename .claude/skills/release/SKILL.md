---
name: release
description: Ship a finished change to DJI Flight Map - raise the version and write plain-English notes, update the README, run every test (including the privacy check), commit, push it as a TEST version, tell the owner exactly how to try it, and only after they confirm it works mark it RELEASED with a git tag. Use after any change to app/ or deploy/, before saying the work is done.
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

## 4. Commit and push (this makes it a TEST version)

- The owner works directly on `main`.
- Commit message: a short title, then what changed and why.
- Push with `git -c push.negotiate=true push origin main`.
- **Do not tag yet.** A pushed commit on `main` is a *test version*: the
  map's update notice does not offer it, and a normal update skips it.

## 5. Tell the owner how to try it

Keep it short and structured:

1. What changed, in plain words (a small table works well).
2. What was tested, and **what could not be tested** (real map pictures,
   real Proxmox, real Azure). Ask for a screenshot when it matters.
3. How to try the test version, each command in its own block:

```bash
cd /root/dji-flightmap && bash deploy/update-ct.sh --test
```

Then: press **Ctrl+Shift+R** on the map page, check the version number next
to "Flight Map" shows the new version, and tell you whether it works.

## 6. Release it, only after the owner says it works

Claude's sandbox can't prove a change works on the real server, so the owner's
confirmation is the gate.

```bash
git tag -a v2.3.0 -m "Version 2.3.0" <commit>
git push origin v2.3.0
```

- Use the exact version from `app/version.json` at that commit, with a `v`.
- Tags must go up: never tag a version lower than an existing tag, never move
  or delete a pushed tag (make a new patch version instead).
- From this moment the update notice offers it to everyone. Tell the owner it
  is released; they are already on it, so they need to do nothing.
- If the owner reports a problem instead: fix it, raise the patch number,
  and go back to step 3. To get them working again meanwhile:
  `bash deploy/update-ct.sh --version <last good release>`.
- Docs-only changes (README, CLAUDE.md, tests) need no version bump or tag.
