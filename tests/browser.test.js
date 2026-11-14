#!/usr/bin/env node
/*
  Browser tests: open the real pages in a hidden Chromium and use them like
  a person would.

  Run:  node tests/browser.test.js        (or: bash tests/run-all.sh)
  Needs Node.js and Playwright (npm install playwright, then
  npx playwright install chromium).

  Nothing goes to the internet: map pictures, Azure Maps and GitHub are
  answered by fakes inside this file, and the flights are made up
  (tests/fixtures.py).
*/
'use strict';
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${!ok && detail ? `  (${detail})` : ''}`);
}

// ---------- helpers ----------
const freePort = () => new Promise((resolve) => {
  const srv = net.createServer().listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

async function startServer(dataDir, env = {}) {
  const port = await freePort();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'flightmap-state-'));
  const proc = spawn(process.env.PYTHON || 'python3', ['-u', path.join(ROOT, 'app', 'server.py')], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1',
           CACHE_FILE: path.join(state, 'summaries.json'), ...env },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!env.AUTH_USER) {   // wait for the first scan of the folder
    for (let i = 0; i < 100; i++) {
      const d = await (await fetch(`${base}/api/flights`)).json();
      if (!d.scanning) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { base, proc, state };
}

const putSettings = (base, values) => fetch(`${base}/api/settings`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'flightmap' }, body: JSON.stringify(values),
});

// Fake internet: coloured squares for map pictures, Azure credits, GitHub version file.
function fakeInternet(ctx, { github = null } = {}) {
  const seen = { tiles: [], github: 0 };
  const svg = (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="${c}"/></svg>`;
  return ctx.route(/^https?:\/\//, (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1') return route.continue();
    if (u.hostname === 'raw.githubusercontent.com') {
      seen.github++;
      return github ? route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(github) })
        : route.abort();
    }
    if (u.pathname === '/map/attribution') {
      // Azure really sends HTML like this; the page must show only the text.
      return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ copyrights: [
          '<a data-azure-maps-attribution-dynamic="true">&copy;2026 TomTom</a>',
          '<a data-azure-maps-attribution-dynamic="true">&copy;2026 TomTom</a>',
          '<img src=x onerror="window.HACKED=1">Evil<script>window.HACKED=2</script>'] }) });
    }
    seen.tiles.push(u.hostname.includes('atlas') ? `azure:${u.searchParams.get('tilesetId')}` : u.hostname);
    return route.fulfill({ contentType: 'image/svg+xml', body: svg('#8a9') });
  }).then(() => seen);
}

// ---------- the tests ----------
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flightmap-browser-'));
  const archive = path.join(tmp, 'archive');
  const expect = JSON.parse(execFileSync(process.env.PYTHON || 'python3', [path.join(__dirname, 'fixtures.py'), archive]).toString());
  const app = await startServer(archive);
  const browser = await chromium.launch();
  const servers = [app];
  try {
    // ---- 1. map page ----
    console.log('Map page');
    await putSettings(app.base, { mapProvider: 'azure', mapLayer: 'road', azureMapsKey: 'TESTKEY', satelliteLabels: true, checkUpdates: false });
    let ctx = await browser.newContext({ viewport: { width: 1400, height: 860 } });
    let seen = await fakeInternet(ctx);
    let page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.base, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    check('shows the made-up flights', (await page.textContent('#status')).includes(`${expect.flights} flights`), await page.textContent('#status'));
    check('one card per aircraft (2)', (await page.locator('.aircraft').count()) === 2);
    check('uses the saved provider (Azure road)', seen.tiles.includes('azure:microsoft.base.road'), seen.tiles.join());
    const credit = await page.textContent('#map .leaflet-control-attribution');
    check('Azure credit shows clean text, once', credit.includes('©2026 TomTom') && credit.split('TomTom').length === 2 && !credit.includes('<a'), credit);
    check('code inside the credit does not run', !(await page.evaluate(() => window.HACKED)));

    // ---- 2. layers panel ----
    console.log('Layers panel');
    await page.click('#btn-layers');
    await page.waitForTimeout(300);
    check('4 layer buttons', (await page.locator('.layer-opt').count()) === 4);
    check('Details is off for Road', await page.isDisabled('#layer-details'));
    seen.tiles.length = 0;
    await page.click('.layer-opt[data-layer=satellite]');
    await page.waitForTimeout(500);
    check('panel stays open after picking a layer', await page.isVisible('#layers-panel'));
    check('Details is on for Satellite', !(await page.isDisabled('#layer-details')));
    check('Satellite + Details = Azure imagery + roads', seen.tiles.includes('azure:microsoft.imagery') && seen.tiles.includes('azure:microsoft.base.hybrid.road'), seen.tiles.join());
    seen.tiles.length = 0;
    await page.click('.layer-opt[data-layer=terrain]');
    await page.waitForTimeout(500);
    check('Terrain falls back to the free map (Azure has none)', seen.tiles.some((t) => t.includes('opentopomap')), seen.tiles.join());
    check('fallback is labelled "free map"', (await page.textContent('.layer-opt[data-layer=terrain]')).includes('free map'));
    await page.mouse.click(800, 600);
    check('clicking the map closes the panel', await page.isHidden('#layers-panel'));

    // ---- 3. replay ----
    console.log('Replay');
    // Pick flight A (the 2-minute loop) by its id, not by text on screen.
    const list = (await (await fetch(`${app.base}/api/flights`)).json()).flights;
    const flightA = list.find((f) => f.start && f.start.startsWith(expect.a_start));
    const visibleLines = () => page.evaluate(() => map.hasLayer(overviewLines) ? overviewLines.getLayers().length : 0);
    check('overview shows every flight path', (await visibleLines()) > 0);
    await page.click('[data-tab=flights]');
    await page.click(`.flight[data-id="${flightA.id}"]`);
    await page.waitForTimeout(800);
    check('flight opens', await page.isVisible('#detail') && await page.isVisible('#p-speed'));
    check('only the open flight is shown (others hidden)', (await visibleLines()) === 0);
    await page.selectOption('#p-speed', '1');
    await page.evaluate(() => seekTime(30));
    await page.click('#p-play');
    const samples = [];
    for (let i = 0; i < 6; i++) {
      samples.push(await page.evaluate(() => { const ll = state.droneMarker.getLatLng(); return `${ll.lat.toFixed(8)},${ll.lng.toFixed(8)}`; }));
      await page.waitForTimeout(16);
    }
    check('drone glides between recorded points', new Set(samples).size >= 3, `${new Set(samples).size} positions`);
    const t1 = await page.evaluate(() => state.trail.getLatLngs().length);
    await page.waitForTimeout(800);
    const t2 = await page.evaluate(() => state.trail.getLatLngs().length);
    check('trail grows as it flies', t2 > t1, `${t1} -> ${t2}`);
    if ((await page.getAttribute('#p-follow', 'aria-pressed')) !== 'true') await page.click('#p-follow');
    await page.waitForTimeout(400);
    const off = await page.evaluate(() => {
      const o = fitOptions(), s = map.getSize();
      const target = [(o.paddingTopLeft[0] + s.x - o.paddingBottomRight[0]) / 2, (o.paddingTopLeft[1] + s.y - o.paddingBottomRight[1]) / 2];
      const p = map.latLngToContainerPoint(state.droneMarker.getLatLng());
      return Math.hypot(p.x - target[0], p.y - target[1]);
    });
    check('Follow keeps the drone centred', off < 3, `${off.toFixed(1)} px off`);
    await page.mouse.move(900, 150); await page.mouse.down(); await page.mouse.move(800, 200, { steps: 4 }); await page.mouse.up();
    check('dragging the map turns Follow off', (await page.getAttribute('#p-follow', 'aria-pressed')) === 'false');
    await page.click('#p-play');
    await page.click('#d-close');
    await page.waitForTimeout(300);
    check('closing the flight brings the other paths back', (await visibleLines()) > 0);
    check('no errors on the map page', errors.length === 0, errors.join(' | '));
    await ctx.close();

    // ---- 4. settings page ----
    console.log('Settings page');
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await fakeInternet(ctx);
    page = await ctx.newPage();
    await page.goto(`${app.base}/settings.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const shownKeys = () => page.$$eval('.provider-key', (els) => els.filter((e) => !e.classList.contains('hidden')).map((e) => e.dataset.provider).join());
    check('only the Azure key box is shown', (await shownKeys()) === 'azure', await shownKeys());
    await page.selectOption('#mapProvider', 'mapbox');
    check('switching provider shows its key box', (await shownKeys()) === 'mapbox');
    await page.waitForTimeout(800);
    check('missing key is explained in the preview', (await page.textContent('#preview-status')).includes('needs a key'));
    await page.selectOption('#mapProvider', 'azure');
    await page.fill(`[data-serial="${expect.serial}"]`, 'Scout');
    await page.click('#btn-save');
    await page.waitForTimeout(500);
    check('settings save', (await page.textContent('#save-msg')).includes('Saved'));
    await page.click('#back');
    await page.waitForTimeout(800);
    check('nickname shows on the map page', (await page.locator('.aircraft h3').allTextContents()).includes('Scout'));
    await ctx.close();

    // ---- 5. update notice ----
    console.log('Update notice');
    const installed = (await (await fetch(`${app.base}/api/flights`)).json()).app.version;
    for (const [label, gh, checkOn, wantBanner] of [
      ['newer version on GitHub shows the notice', { version: '99.0.0', notes: ['Test note'] }, true, true],
      ['same version: no notice', { version: installed, notes: [] }, true, false],
      ['checking off: no notice', { version: '99.0.0', notes: [] }, false, false],
    ]) {
      await putSettings(app.base, { checkUpdates: checkOn });
      ctx = await browser.newContext();
      seen = await fakeInternet(ctx, { github: gh });
      page = await ctx.newPage();
      await page.goto(app.base, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      check(label, (await page.isVisible('#update-banner')) === wantBanner);
      if (!checkOn) check('checking off: GitHub not contacted', seen.github === 0, `${seen.github} requests`);
      if (wantBanner) {
        await page.click('#update-banner');
        check('update window shows the command', (await page.textContent('#upd-cmd')).includes('deploy/update-ct.sh'));
      }
      await ctx.close();
    }

    // ---- 6. phone layout ----
    console.log('Phone layout');
    ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await fakeInternet(ctx);
    page = await ctx.newPage();
    await page.goto(app.base, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const box = await page.locator('#panel').boundingBox();
    check('panel sits at the bottom on a phone', Math.round(box.y + box.height) === 844 && box.height < 844 * 0.5, JSON.stringify(box));
    check('no sideways scrolling on a phone', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await ctx.close();

    // ---- 7. login ----
    console.log('Login page');
    const hash = execFileSync(process.env.PYTHON || 'python3', ['-c',
      `import sys; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'app'))}); import server; print(server.hash_password('testpass123', rounds=1000))`],
      { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }).toString().trim();
    const locked = await startServer(archive, { AUTH_USER: 'tester', AUTH_PASSWORD_HASH: hash });
    servers.push(locked);
    ctx = await browser.newContext();
    await fakeInternet(ctx);
    page = await ctx.newPage();
    await page.goto(locked.base);
    check('signed out: sent to the login page', page.url().endsWith('/login.html'));
    await page.fill('#username', 'tester'); await page.fill('#password', 'wrong-password');
    await page.click('button[type=submit]');
    await page.waitForLoadState('networkidle');
    check('wrong password is refused', (await page.textContent('#error')).includes('Wrong'));
    await page.fill('#username', 'tester'); await page.fill('#password', 'testpass123');
    await page.click('button[type=submit]');
    await page.waitForTimeout(800);
    check('right password opens the map', page.url() === `${locked.base}/` && await page.isVisible('#btn-logout'));
    await page.click('#btn-logout');
    await page.waitForTimeout(500);
    check('sign out returns to the login page', page.url().endsWith('/login.html'));
    await ctx.close();
  } catch (err) {
    check('test run finished without crashing', false, err.stack);
  } finally {
    await browser.close();
    for (const s of servers) { s.proc.kill(); fs.rmSync(s.state, { recursive: true, force: true }); }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
