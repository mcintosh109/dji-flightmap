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

// A fake Azure Maps for OUR SERVER to talk to (the browser must never call
// Azure itself). It records which key it was given.
const AZURE_KEY = 'TEST-AZURE-KEY-123';
async function startFakeAzure() {
  const http = require('http');
  const port = await freePort();
  const got = { tiles: 0, credits: 0, keys: new Set() };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    got.keys.add(u.searchParams.get('subscription-key'));
    if (u.pathname === '/map/attribution') {
      got.credits++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ copyrights: [
        '<a data-azure-maps-attribution-dynamic="true">&copy;2026 TomTom</a>',
        '<a data-azure-maps-attribution-dynamic="true">&copy;2026 TomTom</a>',
        '<img src=x onerror="window.HACKED=1">Evil<script>window.HACKED=2</script>'] }));
    }
    got.tiles++;
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(png);
  }).listen(port, '127.0.0.1');
  return { base: `http://127.0.0.1:${port}`, got, close: () => server.close() };
}

// A made-up 16-day forecast in Open-Meteo's format: cold (3 °C), strong wind
// up high (12 m/s at 120 m), sunrise 06:45, sunset 17:15 every day.
function fakeForecast() {
  const pad = (n) => String(n).padStart(2, '0');
  const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const time = [], days = [];
  for (let h = 0; h < 16 * 24; h++) { const t = new Date(start.getTime() + h * 3600e3); time.push(`${day(t)}T${pad(t.getHours())}:00`); }
  for (let d = 0; d < 16; d++) days.push(day(new Date(start.getTime() + d * 86400e3)));
  const fill = (v) => Array(time.length).fill(v);
  return {
    hourly: { time, temperature_2m: fill(3), precipitation_probability: fill(10), weather_code: fill(2),
      wind_speed_10m: fill(4), wind_direction_10m: fill(315), wind_gusts_10m: fill(8), wind_speed_80m: fill(7), wind_speed_120m: fill(12) },
    daily: { time: days, sunrise: days.map((d) => `${d}T06:45`), sunset: days.map((d) => `${d}T17:15`) },
  };
}
const localDay = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * 86400e3);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Fake internet: coloured squares for map pictures, Azure credits, GitHub version file, weather.
function fakeInternet(ctx, { github = null } = {}) {
  const seen = { tiles: [], github: 0, weather: 0, keyLeaks: 0 };
  const svg = (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="${c}"/></svg>`;
  return ctx.route(/^https?:\/\//, (route) => {
    const u = new URL(route.request().url());
    if (/subscription-key|TEST-AZURE-KEY/.test(route.request().url())) seen.keyLeaks++;
    if (u.hostname === '127.0.0.1') {
      const m = u.pathname.match(/^\/tiles\/azure\/([a-z.]+)\//);
      if (m) seen.tiles.push(`azure:${m[1]}`);
      return route.continue();
    }
    if (u.hostname === 'atlas.microsoft.com') seen.keyLeaks++;   // the browser must not call Azure directly
    // GitHub: the list of released versions (tags), then one release's notes.
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (u.hostname === 'api.github.com') {
      seen.github++;
      if (!github) return route.abort();
      const tags = [{ name: 'v0.0.1' }, { name: `v${github.version}` }, { name: 'nightly' }, { name: 'v999' }];
      return route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify(tags) });
    }
    if (u.hostname === 'raw.githubusercontent.com') {
      seen.notesFrom = u.pathname;
      return github ? route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify(github) }) : route.abort();
    }
    if (u.hostname === 'api.open-meteo.com') {
      seen.weather++;
      return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(fakeForecast()) });
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
  const azure = await startFakeAzure();
  const app = await startServer(archive, { AZURE_MAPS_URL: azure.base });
  const browser = await chromium.launch();
  const servers = [app];
  try {
    // ---- 1. map page ----
    console.log('Map page');
    await putSettings(app.base, { mapProvider: 'azure', mapLayer: 'road', azureMapsKey: AZURE_KEY, satelliteLabels: true, checkUpdates: false });
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
    check('Azure pictures come through our server', azure.got.tiles > 0 && azure.got.keys.has(AZURE_KEY), `${azure.got.tiles} tiles`);
    check('the browser never sees or sends the Azure key', seen.keyLeaks === 0
      && !(await page.content()).includes(AZURE_KEY)
      && !JSON.stringify(await (await fetch(`${app.base}/api/settings`)).json()).includes(AZURE_KEY), `${seen.keyLeaks} leaks`);
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
    // Record the drone's position on 12 screen frames, inside the browser,
    // and count how many track points it passed. Gliding = many different
    // positions per track point; hopping = one position per track point.
    const glide = await page.evaluate(() => new Promise((resolve) => {
      const spots = new Set(); const startIdx = state.idx; let frames = 0;
      const step = () => {
        const ll = state.droneMarker.getLatLng();
        spots.add(`${ll.lat.toFixed(8)},${ll.lng.toFixed(8)}`);
        if (++frames < 12) requestAnimationFrame(step);
        else resolve({ spots: spots.size, points: state.idx - startIdx });
      };
      requestAnimationFrame(step);
    }));
    check('drone glides between recorded points', glide.spots > glide.points + 2,
      `${glide.spots} positions while passing ${glide.points} track points`);
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

    // ---- 3b. flight planner ----
    console.log('Flight planner');
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    seen = await fakeInternet(ctx);
    page = await ctx.newPage();
    const plannerErrors = [];
    page.on('pageerror', (e) => plannerErrors.push(e.message));
    await page.goto(app.base, { waitUntil: 'networkidle' });
    await page.click('[data-tab=plans]');
    check('Plans tab is empty at first', (await page.textContent('#plan-list')).includes('No saved plans'));
    check('Plans tab shows the local-laws reminder', (await page.textContent('#tab-plans')).includes('local laws and regulations'));
    await page.click('#btn-new-plan');
    check('new plan asks for the take-off point', (await page.textContent('#pl-hint')).includes('take-off'));
    await page.click('#pl-last-home');
    await page.waitForTimeout(300);
    const hBox = await page.locator('.plan-home').boundingBox();
    const plannerTop = (await page.locator('#planner').boundingBox()).y;
    check('take-off point is visible above the planner panel', hBox && hBox.y + hBox.height < plannerTop, JSON.stringify({ hBox, plannerTop }));
    for (const [x, y] of [[650, 120], [1100, 120], [1150, 300], [650, 300]]) { await page.mouse.click(x, y); await page.waitForTimeout(120); }
    check('clicking the map adds waypoints (4)', (await page.locator('#pl-wps tbody tr').count()) === 4);
    check('new waypoints start at 200 ft and 18 mph',
      (await page.inputValue('#pl-wps tr[data-i="0"] input[data-f=alt]')) === '200' && (await page.inputValue('#pl-wps tr[data-i="0"] input[data-f=speed]')) === '18');
    check('distance and time are worked out', !(await page.textContent('#pl-stats')).includes('–'));
    const okText = await page.textContent('#pl-warnings');
    check('"OK" says airspace, obstacles and local rules are not checked', /Airspace, obstacles and local rules are not checked/.test(okText), okText);
    check('local-laws disclaimer is always shown in the planner', await page.isVisible('#pl-disclaimer')
      && (await page.textContent('#pl-disclaimer')).includes('Always check your local laws and regulations'));
    const altBox = '#pl-wps tr[data-i="1"] input[data-f=alt]';
    await page.fill(altBox, '500');
    await page.press(altBox, 'Tab');
    await page.waitForTimeout(200);
    const warns = () => page.$$eval('#pl-warnings li', (els) => els.map((e) => e.innerText).join(' | '));
    check('warns about 500 ft over the 400 ft limit', /500 ft.*400 ft/.test(await warns()), await warns());
    const setWhen = async (v) => {
      await page.fill('#pl-when', v);
      await page.$eval('#pl-when', (el) => el.dispatchEvent(new Event('change', { bubbles: true })));
      await page.waitForTimeout(1200);
    };
    await setWhen(`${localDay(1)}T15:00`);
    check('weather is fetched for the planned time', seen.weather === 1 && (await page.locator('#pl-weather .live div').count()) >= 8, `${seen.weather} requests`);
    check('warns about strong wind up high', (await warns()).includes('Wind up high'), await warns());
    check('warns about the cold', (await warns()).includes('Cold'), await warns());
    await setWhen(`${localDay(1)}T21:00`);
    check('warns about flying after sunset', (await warns()).includes('after sunset'), await warns());
    await page.fill('#pl-name', 'Test loop');
    await page.click('#pl-save');
    await page.waitForTimeout(500);
    check('plan saves', (await page.textContent('#pl-save-msg')).includes('Saved'));
    check('plan appears in the Plans tab', (await page.locator('.plan-card').count()) === 1);
    // Unsaved changes: opening a flight asks first; saying "no" keeps the plan open.
    await page.mouse.click(900, 330);
    await page.click('[data-tab=flights]');
    page.once('dialog', (d) => d.dismiss());
    await page.locator('.flight').first().click();
    await page.waitForTimeout(400);
    check('unsaved plan: asks before closing, and stays open on "no"', await page.isVisible('#planner'));
    // Reload: the plan is still there, with exact values.
    page.once('dialog', (d) => d.accept());
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('[data-tab=plans]');
    await page.click('.plan-card');
    await page.waitForTimeout(400);
    check('saved plan opens again with its 4 waypoints', (await page.locator('#pl-wps tbody tr').count()) === 4);
    check('500 ft is still exactly 500 ft', (await page.inputValue(altBox)) === '500');
    page.once('dialog', (d) => d.accept());
    await page.click('#pl-delete');
    await page.waitForTimeout(400);
    check('plan can be deleted', (await page.locator('.plan-card').count()) === 0 && await page.isHidden('#planner'));
    check('no errors in the planner', plannerErrors.length === 0, plannerErrors.join(' | '));
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
    check('saved Azure key is shown as hidden, not filled in', (await page.inputValue('#azureMapsKey')) === ''
      && (await page.textContent('#azure-key-status')).includes('saved'));
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
      if (checkOn) {
        const before = seen.github;
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(400);
        check(`${label}: checks again on every page load`, seen.github === before + 1, `${before} -> ${seen.github}`);
      }
      if (!checkOn) {
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(400);
        check('checking off: GitHub not contacted, even after reloading', seen.github === 0, `${seen.github} requests`);
      }
      if (wantBanner) {
        await page.click('#update-banner');
        check('update window shows the command', (await page.textContent('#upd-cmd')).includes('deploy/update-ct.sh'));
        check('notes come from the released version (its tag), not from main', seen.notesFrom.includes('/v99.0.0/app/version.json'), seen.notesFrom);
        check('update window shows what is new', (await page.textContent('#upd-notes')).includes('Test note'));
      }
      await ctx.close();
    }

    // Installed version newer than the newest release = a test version.
    await putSettings(app.base, { checkUpdates: true });
    ctx = await browser.newContext();
    await fakeInternet(ctx, { github: { version: '0.5.0', notes: [] } });
    page = await ctx.newPage();
    await page.goto(app.base, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    check('test version: no update notice', await page.isHidden('#update-banner'));
    await page.click('#btn-version');
    check('test version: the window says it is not released yet', /test version.*newest release is 0\.5\.0/.test(await page.textContent('#upd-status')), await page.textContent('#upd-status'));
    await ctx.close();

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
      `import sys; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'app'))}); from flightmap.auth import hash_password; print(hash_password('testpass123', rounds=1000))`],
      { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }).toString().trim();
    const locked = await startServer(archive, { AUTH_USER: 'tester', AUTH_PASSWORD_HASH: hash });
    servers.push(locked);
    // (The locked server has its own settings, with update checks on by default.)
    ctx = await browser.newContext();
    seen = await fakeInternet(ctx, { github: { version: '99.0.0', notes: [] } });
    page = await ctx.newPage();
    await page.goto(locked.base);
    check('signed out: sent to the login page', page.url().endsWith('/login.html'));
    await page.waitForTimeout(400);
    check('login page does not check for updates', seen.github === 0, `${seen.github} requests`);
    await page.fill('#username', 'tester'); await page.fill('#password', 'wrong-password');
    await page.click('button[type=submit]');
    await page.waitForLoadState('networkidle');
    check('wrong password is refused', (await page.textContent('#error')).includes('Wrong'));
    check('no update check after a wrong password', seen.github === 0, `${seen.github} requests`);
    await page.fill('#username', 'tester'); await page.fill('#password', 'testpass123');
    await page.click('button[type=submit]');
    await page.waitForTimeout(800);
    check('right password opens the map', page.url() === `${locked.base}/` && await page.isVisible('#btn-logout'));
    check('update check runs right after signing in', seen.github === 1, `${seen.github} requests`);
    await page.click('#btn-logout');
    await page.waitForTimeout(500);
    check('sign out returns to the login page', page.url().endsWith('/login.html'));
    await ctx.close();
  } catch (err) {
    check('test run finished without crashing', false, err.stack);
  } finally {
    await browser.close();
    for (const s of servers) { s.proc.kill(); fs.rmSync(s.state, { recursive: true, force: true }); }
    azure.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
