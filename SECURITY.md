# Security Policy

## Supported Versions

Only the **newest release** gets security fixes. Updating is one command
(see [Updating later](README.md#updating-later)), and the map shows a notice
when a new release is out, so please stay on the newest one.

| Version | Supported          |
| ------- | ------------------ |
| Newest release ([Releases](https://github.com/mcintosh109/dji-flightmap/releases)) | :white_check_mark: |
| Older releases | :x: |
| Test versions (not released yet) | :x: |

## Reporting a Vulnerability

Please report security problems **privately**, not in a public issue, so
they can be fixed before anyone else learns about them:

1. Open the **[Security](https://github.com/mcintosh109/dji-flightmap/security)**
   tab of this project.
2. Click **Report a vulnerability**.
3. Describe what you found, which version, and how to make it happen.

You need a GitHub account. Your report is only visible to you and the
project's owner.

**What to expect:** this is a hobby project looked after by one person, so
replies are best effort and there is no fixed timeline. You'll get an
answer in the report itself, saying whether it is accepted or declined and
why. An accepted problem is fixed in a new release, and the report may then be
published as a security advisory (crediting you, if you want).

## What counts

In scope: this project's own code, such as the web server and its login,
HTTPS, the settings page (including how map keys are kept), and the
`deploy/` scripts that install, update and back up the map.

Not in scope here:

- The map and place services it uses (Azure Maps, Google Maps,
  OpenStreetMap): report those to them.
- [dji-rc2-dock](https://github.com/mcintosh109/dji-rc2-dock), the separate
  project that copies the logs off the controller: report those there.
- Problems that need someone who already controls the Proxmox server or the
  container.
