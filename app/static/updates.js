'use strict';
/*
  Update checks, shared by the map page and the settings page.

  The server tells us which version is installed. We ask GitHub for the
  project's RELEASED versions and compare. A version counts as released when
  it has a tag like "v2.3.0" (research: "git tag"); work that is still being
  tested has no tag yet, so it is never offered here.

  The map asks GitHub each time it opens; while it stays open, the answer is
  remembered for 6 hours so GitHub isn't asked every minute.
*/
window.Updates = (() => {
  const COMMAND = 'cd /root/dji-flightmap && bash deploy/update-ct.sh';
  const CACHE_KEY = 'updateCheck';
  const CACHE_MS = 6 * 60 * 60 * 1000;

  // "1.10.0" is newer than "1.9.2": compare number by number.
  function isNewer(latest, installed) {
    const a = String(latest).split('.').map((n) => parseInt(n, 10) || 0);
    const b = String(installed).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    }
    return false;
  }

  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { return null; }
  }
  function writeCache(value) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(value)); } catch { /* ignore */ }
  }

  const REPO_RE = /^[\w.-]+\/[\w.-]+$/;        // "owner/name"
  const TAG_RE = /^v(\d+\.\d+\.\d+)$/;        // release tags look like v2.3.0

  // The newest released version of `repo`, e.g. "2.3.0", or '' if none yet.
  async function newestRelease(repo) {
    const res = await fetch(`https://api.github.com/repos/${repo}/tags?per_page=100`, { cache: 'no-store' });
    if (res.status === 403 || res.status === 429) throw new Error('GitHub is busy; it allows about 60 checks an hour. Try again later');
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const tags = await res.json();
    let newest = '';
    for (const tag of Array.isArray(tags) ? tags : []) {
      const match = TAG_RE.exec(String(tag.name));
      if (match && (!newest || isNewer(match[1], newest))) newest = match[1];
    }
    return newest;
  }

  // The "what's new" notes of a released version (best effort).
  async function releaseNotes(repo, version) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${repo}/v${version}/app/version.json`, { cache: 'no-store' });
      if (!res.ok) return {};
      const data = await res.json();
      return {
        released: String(data.released || '').slice(0, 20),
        notes: (Array.isArray(data.notes) ? data.notes : []).slice(0, 10).map((n) => String(n).slice(0, 200)),
      };
    } catch { return {}; }
  }

  // Adds what the comparison means to a remembered or fresh answer:
  //   available  a newer released version exists
  //   testing    the installed version is newer than the newest release
  //              (you installed a test version with --test)
  function compare(info, installed) {
    return {
      ...info, installed,
      available: !!info.latest && isNewer(info.latest, installed),
      testing: !info.latest || isNewer(installed, info.latest),
    };
  }

  // Returns { installed, latest, notes, released, available, testing, checkedAt }
  // or { installed, error } if GitHub couldn't be reached.
  async function check(installed, repo, { force = false } = {}) {
    if (!REPO_RE.test(String(repo))) return { installed, error: 'no project address to check' };
    const cached = readCache();
    if (!force && cached && cached.repo === repo && Date.now() - cached.checkedAt < CACHE_MS) {
      return compare(cached, installed);
    }
    try {
      const latest = await newestRelease(repo);
      const info = { repo, latest, released: '', notes: [], checkedAt: Date.now() };
      if (latest && isNewer(latest, installed)) Object.assign(info, await releaseNotes(repo, latest));
      writeCache(info);
      return compare(info, installed);
    } catch (err) {
      return { installed, error: err.message, checkedAt: Date.now() };
    }
  }

  // Copy text. navigator.clipboard only works on https:// pages, so fall
  // back to the older method, which also works on plain http://.
  async function copy(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* try the fallback */ }
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.appendChild(box);
    box.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    box.remove();
    return ok;
  }

  // Hook up a "Copy" button: shows "Copied ✓" (or tells you to copy by hand).
  function wireCopyButton(button, text = COMMAND) {
    button.addEventListener('click', async () => {
      const ok = await copy(text);
      const before = button.dataset.label || button.textContent;
      button.dataset.label = before;
      button.textContent = ok ? 'Copied ✓' : 'Select the text and copy it';
      setTimeout(() => { button.textContent = before; }, 2500);
    });
  }

  return { COMMAND, check, copy, isNewer, wireCopyButton };
})();
