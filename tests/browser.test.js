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
           CACHE_FILE: path.join(state, 'summaries.json'), DEFAULT_HTTPS: 'off', ...env },
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
  // failTile: { key: 'z/x/y', left: n }: that picture fails n times (503).
  // placesFail: places searches are refused (Azure switched the old search off).
  const got = { tiles: 0, credits: 0, keys: new Set(), searches: 0, failTile: null, tileAsked: {}, placesFail: false };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    // The address search: Azure's Get Geocoding, and (same fake) OpenStreetMap's Nominatim.
    if (u.pathname === '/geocode' || u.pathname === '/search') {
      got.geocodes = (got.geocodes || 0) + 1;
      if (u.pathname === '/search') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify([{ lat: '40.7812', lon: '-73.9665', display_name: 'Bow Bridge, Central Park, New York',
          category: 'highway', type: 'footway', addresstype: 'road' }]));
      }
      got.keys.add(u.searchParams.get('subscription-key'));
      res.writeHead(200, { 'Content-Type': 'application/geo+json' });
      return res.end(JSON.stringify({ type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { type: 'Address', address: { formattedAddress: '1 Park Loop, New York, NY 10024' } },
          geometry: { type: 'Point', coordinates: [-73.9665, 40.7812] }, bbox: [-73.9670, 40.7808, -73.9660, 40.7816] },
        { type: 'Feature', properties: { type: 'PopulatedPlace', address: { formattedAddress: '<img src=x onerror="window.HACKED=5">Evil town' } },
          geometry: { type: 'Point', coordinates: [-73.99, 40.73] } },
      ] }));
    }
    got.keys.add(u.searchParams.get('subscription-key'));
    if (u.pathname === '/search/poi/json') {   // Azure's place search: knows nothing here
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ results: [] }));
    }
    if (u.pathname === '/search/nearby/json') {
      got.searches++;
      if (got.placesFail) { res.writeHead(400); return res.end('{}'); }
      const lat = Number(u.searchParams.get('lat')), lon = Number(u.searchParams.get('lon'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ results: [
        { id: 'p1', poi: { name: 'Bayou Gas', classifications: [{ code: 'PETROL_STATION', names: [{ name: 'petrol station' }] }] },
          position: { lat: lat + 0.001, lon: lon + 0.001 } },
        { id: 'p2', poi: { name: 'Main St Clinic', classifications: [{ code: 'HOSPITAL_POLYCLINIC', names: [{ name: 'hospital polyclinic' }] }] },
          position: { lat: lat - 0.002, lon: lon + 0.002 } },
        { id: 'p3', poi: { name: '<img src=x onerror="window.HACKED=4">Evil store', classifications: [{ code: 'SHOP' }] },
          position: { lat: lat + 0.002, lon: lon - 0.002 } },
        // An office right next to the gas station: zoomed out, only one of the two shows.
        { id: 'p4', poi: { name: 'Bayou Offices', classifications: [{ code: 'COMPANY' }] },
          position: { lat: lat + 0.00105, lon: lon + 0.00105 } },
      ] }));
    }
    if (u.pathname === '/map/tile') {
      const key = `${u.searchParams.get('zoom')}/${u.searchParams.get('x')}/${u.searchParams.get('y')}`;
      got.tileAsked[key] = (got.tileAsked[key] || 0) + 1;
      if (got.failTile && got.failTile.key === key && got.failTile.left > 0) {
        got.failTile.left--;
        res.writeHead(503);
        return res.end();
      }
    }
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

// A fake Google Map Tiles API for OUR SERVER to talk to: sessions, pictures, credits.
const GOOGLE_KEY = 'AIzaTEST-GOOGLE-KEY';
async function startFakeGoogle() {
  const http = require('http');
  const port = await freePort();
  const got = { sessions: [], tiles: 0, keys: new Set() };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    got.keys.add(u.searchParams.get('key'));
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (u.pathname === '/v1/places:searchNearby') {
        got.searches = (got.searches || 0) + 1;
        const c = JSON.parse(body).locationRestriction.circle.center;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ places: [
          { id: 'A1', displayName: { text: 'Dollar Store' }, location: { latitude: c.latitude + 0.0003, longitude: c.longitude },
            primaryType: 'discount_store', primaryTypeDisplayName: { text: 'Discount store' }, googleMapsUri: 'https://maps.google.com/?cid=1' },
          { id: 'A2', displayName: { text: 'Quick Gas' }, location: { latitude: c.latitude, longitude: c.longitude + 0.0004 },
            primaryType: 'gas_station', primaryTypeDisplayName: { text: 'Gas station' } }] }));
      }
      if (u.pathname === '/v1/createSession') {
        got.sessions.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ session: `S${got.sessions.length}`, expiry: String(Math.floor(Date.now() / 1000) + 1209600) }));
      }
      if (u.pathname === '/tile/v1/viewport') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Like the real answer: the whole world at a low zoom, plus a closer area.
        return res.end(JSON.stringify({ copyright: 'Map data ©2026 Google', maxZoomRects: [
          { maxzoom: 3, south: -85, north: 85, west: -180, east: 180 },
          { maxzoom: 19, south: 40, north: 41.5, west: -74.5, east: -73.5 }] }));
      }
      got.tiles++;
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=60' });
      res.end(png);
    });
  }).listen(port, '127.0.0.1');
  return { base: `http://127.0.0.1:${port}`, got, close: () => server.close() };
}

// A fake OpenStreetMap (Overpass API) for OUR SERVER to ask about places.
// It puts a cafe, a school and a heliport in the middle of the box it is asked about.
async function startFakeOverpass() {
  const http = require('http');
  const port = await freePort();
  const got = { queries: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      got.queries++;
      const query = new URLSearchParams(body).get('data') || '';
      const [s, w, n, e] = (query.match(/\[bbox:([^\]]+)\]/) || [0, '0,0,0,0'])[1].split(',').map(Number);
      const lat = (s + n) / 2, lon = (w + e) / 2;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ elements: [
        { type: 'node', id: 1, lat, lon, tags: { name: 'Corner Cafe', amenity: 'cafe', 'addr:housenumber': '1', 'addr:street': 'Main St' } },
        { type: 'way', id: 2, center: { lat: lat + 0.0004, lon }, tags: { name: 'Hillside School', amenity: 'school' } },
        { type: 'node', id: 3, lat, lon: lon + 0.0006, tags: { name: 'County Heliport', aeroway: 'heliport' } },
        { type: 'node', id: 4, lat: lat - 0.0004, lon, tags: { name: '<img src=x onerror="window.HACKED=3">Evil shop', shop: 'yes' } },
        // Two places 13 m apart: their names overlap at zoom 17, not at zoom 19.
        { type: 'node', id: 5, lat: lat - 0.0008, lon, tags: { name: 'Corner Store', shop: 'convenience' } },
        { type: 'node', id: 6, lat: lat - 0.00092, lon, tags: { name: 'Town Clinic', amenity: 'clinic' } },
      ] }));
    });
  }).listen(port, '127.0.0.1');
  return { url: `http://127.0.0.1:${port}/api/interpreter`, got, close: () => server.close() };
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
  return ctx.route(/^https?:\/\//, async (route) => {
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
      // Both v99.0.0 and 99.0.0 (a forgotten v): the v one must be used. With
      // noV, only 99.0.0 exists, and it must still count as a release.
      const tags = [{ name: 'v0.0.1' }, ...(github.noV ? [] : [{ name: `v${github.version}` }]),
        { name: github.version }, { name: 'nightly' }, { name: 'v999' }];
      return route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify(tags) });
    }
    if (u.hostname === 'raw.githubusercontent.com') {
      seen.notesFrom = u.pathname;
      return github ? route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify(github) }) : route.abort();
    }
    if (u.hostname === 'api.open-meteo.com') {
      seen.weather++;
      // seen.slowRain: the next forecast arrives late (ms) and says 100% rain.
      const slow = seen.slowRain;
      seen.slowRain = 0;
      const forecast = fakeForecast();
      if (slow) forecast.hourly.precipitation_probability.fill(100);
      if (slow) await new Promise((r) => setTimeout(r, slow));
      return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(forecast) });
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
  const osm = await startFakeOverpass();
  const google = await startFakeGoogle();
  const app = await startServer(archive, { AZURE_MAPS_URL: azure.base, OVERPASS_URL: osm.url,
    GOOGLE_TILES_URL: google.base, GOOGLE_PLACES_URL: google.base, NOMINATIM_URL: azure.base });
  const browser = await chromium.launch();
  const servers = [app];
  try {
    // ---- 1. map page ----
    console.log('Map page');
    // (Azure places off here: the OpenStreetMap places are tested first; Azure's after.)
    await putSettings(app.base, { mapProvider: 'azure', mapLayer: 'road', azureMapsKey: AZURE_KEY, satelliteLabels: true, checkUpdates: false, azurePlacesDailyLimit: 0 });
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

    // ---- 1b. address search ----
    console.log('Address search');
    const addrBox = await page.locator('#btn-addr').boundingBox();
    check('the address search is one small button in the top-right corner (the box is hidden)',
      addrBox && addrBox.width <= 40 && addrBox.x > 1000 && !(await page.isVisible('#addr-panel')), JSON.stringify(addrBox));
    await page.click('#btn-addr');
    await page.waitForTimeout(200);
    check('clicking it opens the search box, ready to type', await page.isVisible('#addr-panel')
      && await page.evaluate(() => document.activeElement.id === 'addr-q'));
    await page.fill('#addr-q', 'ab');
    await page.press('#addr-q', 'Enter');
    await page.waitForTimeout(200);
    check('a too-short search asks for more letters (nothing is sent)',
      (await page.textContent('#addr-results')).includes('at least 3 letters') && !azure.got.geocodes);
    await page.fill('#addr-q', '1 Park Loop');
    await page.press('#addr-q', 'Enter');
    await page.waitForSelector('.addr-result', { timeout: 5000 }).catch(() => {});
    check('Enter searches, through our server, Azure and OpenStreetMap: the answers are listed',
      (await page.locator('.addr-result').count()) === 3 && (await page.textContent('#addr-results')).includes('1 Park Loop, New York')
      && (await page.textContent('#addr-results')).includes('Bow Bridge') && azure.got.geocodes === 2,
      `${azure.got.geocodes} searches: ${await page.textContent('#addr-results')}`);
    check("...in plain words: OpenStreetMap's footway is a \"Trail or path\"",
      (await page.textContent('#addr-results')).includes('Trail or path · OpenStreetMap'), await page.textContent('#addr-results'));
    check('...each answer says which company it came from', (await page.textContent('.addr-result >> nth=0')).includes('Azure Maps')
      && (await page.textContent('#addr-results')).includes('OpenStreetMap'), await page.textContent('#addr-results'));
    check('a name with code in it shows as text and does not run',
      (await page.textContent('#addr-results')).includes('<img src=x') && !(await page.evaluate(() => window.HACKED)));
    check('it says where the addresses come from (Azure Maps and OpenStreetMap)',
      (await page.textContent('#addr-foot')).includes('Azure Maps and © OpenStreetMap contributors'), await page.textContent('#addr-foot'));
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'desktop-results.png') });
    await page.click('.addr-result >> nth=0');
    await page.waitForTimeout(900);
    const at = await page.evaluate(() => ({ c: map.getCenter(), z: map.getZoom(), pins: document.querySelectorAll('.addr-pin').length,
      label: document.querySelector('.addr-label')?.textContent, clickable: !!document.querySelector('.addr-pin.leaflet-interactive') }));
    check('picking one goes there, close up, with a pin and its name', at.pins === 1 && at.label === '1 Park Loop'
      && at.z >= 16 && Math.abs(at.c.lat - 40.7812) < 0.01 && Math.abs(at.c.lng + 73.9665) < 0.02, JSON.stringify(at));
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'desktop-pin.png') });
    check('...the search box closes, and the pin lets clicks through (for waypoints)', !(await page.isVisible('#addr-panel')) && !at.clickable);
    await page.click('#btn-addr');
    await page.click('#btn-layers');
    await page.waitForTimeout(200);
    check('only one panel at a time: Layers closes the search box', !(await page.isVisible('#addr-panel')) && await page.isVisible('#layers-panel'));
    await page.click('#btn-addr');
    await page.waitForTimeout(200);
    check('...and the search box closes Layers', await page.isVisible('#addr-panel') && !(await page.isVisible('#layers-panel')));
    const searchesBefore = azure.got.geocodes;
    await page.fill('#addr-q', `40°46'40.0"N 73°58'10.0"W`);
    await page.press('#addr-q', 'Enter');
    await page.waitForTimeout(900);
    const spot = await page.evaluate(() => ({ c: map.getCenter(), label: document.querySelector('.addr-label')?.textContent,
      pins: document.querySelectorAll('.addr-pin').length }));
    check('pasted coordinates go straight there, with a pin (nothing is searched)', azure.got.geocodes === searchesBefore
      && spot.pins === 1 && spot.label === '40.77778, -73.96944' && Math.abs(spot.c.lat - 40.77778) < 0.01
      && !(await page.isVisible('#addr-panel')), JSON.stringify(spot));
    await page.click('#btn-addr');
    await page.click('#addr-clear');
    check('"Remove the pin" removes it', (await page.locator('.addr-pin').count()) === 0 && !(await page.isVisible('#addr-clear')));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check('Esc closes the search box', !(await page.isVisible('#addr-panel')));

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

    // ---- 2b. places (shops, schools...) ----
    console.log('Places');
    await page.evaluate(() => map.setView([40.7812, -73.9665], 14));
    await page.waitForTimeout(800);
    check('zoomed out: no places drawn', (await page.locator('.place-icon').count()) === 0);
    check('zoomed out: says to zoom in', (await page.textContent('#places-status')).includes('Zoom in'), await page.textContent('#places-status'));
    await page.evaluate(() => map.setView([40.7812, -73.9665], 17));
    await page.waitForTimeout(1500);
    const placeCount = await page.locator('.place-icon').count();
    check('zoomed in: places are drawn', placeCount >= 4, `${placeCount} places, status: ${await page.textContent('#places-status')}`);
    check('names show under the icons', await page.isVisible('.place-icon .nm >> text=Hillside School'));
    // Corner Cafe's name runs into County Heliport's: the heliport (more important for a pilot) keeps it.
    check('a cafe name that would cover the heliport name is hidden', await page.isHidden('.place-icon .nm >> text=Corner Cafe'));
    const nameShown = (n) => page.evaluate((text) => {
      const el = [...document.querySelectorAll('.place-icon .nm')].find((e) => e.textContent === text);
      return !!el && getComputedStyle(el).visibility !== 'hidden';
    }, n);
    check('overlapping names: one is hidden, the clinic keeps its name',
      (await nameShown('Town Clinic')) && !(await nameShown('Corner Store')));
    // Zoom in on the two close places (where they are depends on the fake's answer).
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('.place-icon')].find((e) => e.textContent.includes('Corner Store'));
      const r = el.getBoundingClientRect(), m = map.getContainer().getBoundingClientRect();
      map.setView(map.containerPointToLatLng([r.left + r.width / 2 - m.left, r.top + r.height / 2 - m.top]), 19);
    });
    await page.waitForTimeout(1500);
    check('zooming in shows the hidden name again', await nameShown('Corner Store') && await nameShown('Town Clinic'));
    await page.evaluate(() => map.setView([40.7812, -73.9665], 17));
    await page.waitForTimeout(800);
    check('OpenStreetMap is credited', (await page.textContent('#map .leaflet-control-attribution')).includes('OpenStreetMap'));
    check('a name with code in it does not run', !(await page.evaluate(() => window.HACKED)));
    await page.locator('.place-air').first().hover();
    await page.waitForTimeout(200);
    const tip = await page.textContent('.place-tip').catch(() => '');
    check('pointing at a place icon says what it is (name and kind)', tip.includes('County Heliport') && /heliport/i.test(tip.replace('County Heliport', '')), tip);
    await page.locator('.place-air').first().click();
    await page.waitForTimeout(300);
    check('  ...clicking it opens the popup without the label covering it',
      await page.isVisible('.leaflet-popup-content') && (await page.locator('.place-tip').count() === 0 || await page.isHidden('.place-tip')));
    const pop = await page.textContent('.leaflet-popup-content');
    check('heliport popup warns about airspace', pop.includes('County Heliport') && pop.includes('does not check airspace'), pop);
    const asked = osm.got.queries;
    await page.evaluate(() => { map.closePopup(); map.panBy([5, 5]); });
    await page.waitForTimeout(800);
    check('moving a little does not ask OpenStreetMap again', osm.got.queries === asked, `${osm.got.queries - asked} more`);
    await page.click('#btn-layers');
    await page.uncheck('#layer-places');
    await page.waitForTimeout(300);
    check('Places can be turned off', (await page.locator('.place-icon').count()) === 0);
    check('...and that is remembered', (await page.evaluate(() => localStorage.getItem('mapPlaces'))) === '0');
    await page.check('#layer-places');
    await page.waitForTimeout(600);
    check('...and on again', (await page.locator('.place-icon').count()) >= 4);
    await page.mouse.click(800, 600);

    // ---- 2b2. Azure places, and map squares that fail ----
    console.log('Azure places');
    await putSettings(app.base, { azurePlacesDailyLimit: 150 });
    {
      // The Azure picture of Central Park at zoom 14 fails twice (the server
      // tries twice, then the page tries again after a second).
      const z = 14, n = 2 ** z, lat0 = 40.7812, lon0 = -73.9665;
      const tx = Math.floor((lon0 + 180) / 360 * n);
      const ty = Math.floor((1 - Math.log(Math.tan(lat0 * Math.PI / 180) + 1 / Math.cos(lat0 * Math.PI / 180)) / Math.PI) / 2 * n);
      azure.got.failTile = { key: `${z}/${tx}/${ty}`, left: 2 };
      const actx = await browser.newContext({ viewport: { width: 1400, height: 860 } });
      await fakeInternet(actx);
      const apage = await actx.newPage();
      await apage.goto(app.base, { waitUntil: 'networkidle' });
      await apage.evaluate(([la, lo]) => map.setView([la, lo], 14), [lat0, lon0]);
      await apage.waitForTimeout(3500);
      const status = await apage.textContent('#places-status');
      check('Azure map: places come from Azure Maps, from zoom 14', status.includes('from Azure Maps')
        && await apage.isVisible('.place-icon >> text=⛽'), status);
      check('  ...and the layers panel says they come from Azure Maps', (await apage.textContent('#places-from')).includes('Azure Maps'));
      check('  ...through our server (one search), with the key added there', azure.got.searches === 1 && !(await apage.content()).includes(AZURE_KEY));
      check('  ...a name with code in it does not run', !(await apage.evaluate(() => window.HACKED)));
      const failed = await apage.evaluate((k) => [...document.querySelectorAll('img.leaflet-tile')]
        .filter((img) => img.src.includes(`/${k}.png`)).map((img) => img.complete && img.naturalWidth > 0), `microsoft.base.road/${z}/${tx}/${ty}`);
      const opacities = await apage.evaluate(() => MapStyles.build('azure-hybrid', state.settings).getLayers().map((l) => l.options.opacity));
      check('Azure satellite + roads: the picture is solid, the road + name layer a little see-through',
        JSON.stringify(opacities) === '[1,0.8]', JSON.stringify(opacities));
      check('a map square that failed is asked for again and shows (no black square)',
        azure.got.tileAsked[`${z}/${tx}/${ty}`] >= 3 && failed.length > 0 && failed.every(Boolean), JSON.stringify({ asked: azure.got.tileAsked[`${z}/${tx}/${ty}`], failed }));

      const shown = () => apage.evaluate(() => [...document.querySelectorAll('.place-icon')]
        .filter((el) => getComputedStyle(el).visibility !== 'hidden').map((el) => el.querySelector('.pin').textContent));
      const far = await shown();
      check('  ...zoomed out, an icon that would cover another is hidden (the gas station stays, the office goes)',
        far.includes('⛽') && !far.includes('🏢') && (await apage.locator('.place-icon').count()) === 4, JSON.stringify(far));
      await apage.evaluate(() => map.setZoom(16));
      await apage.waitForTimeout(1500);
      const near = await shown();
      check('  ...zoomed in, every place shows again', near.includes('⛽') && near.includes('🏢'), JSON.stringify(near));
      // Azure refuses (e.g. Microsoft switched the old search off): OpenStreetMap's places instead.
      azure.got.placesFail = true;
      await apage.evaluate(() => map.setView([40.86, -73.88], 17));   // ~11 km away: a new search
      await apage.waitForTimeout(3000);
      const status2 = await apage.textContent('#places-status');
      check('Azure refuses: OpenStreetMap places are shown instead, and it says why',
        /Azure Maps places didn't answer.*OpenStreetMap's places.*places here/.test(status2) && (await apage.locator('.place-icon').count()) > 0, status2);
      check('  ...the layers panel says they come from OpenStreetMap now', (await apage.textContent('#places-from')).includes('OpenStreetMap'));
      azure.got.placesFail = false;
      // 5 minutes later (pretend), moving the map asks Azure again: one hiccup no longer means OpenStreetMap all day.
      const before = azure.got.searches;
      await apage.evaluate(() => { const real = Date.now; Date.now = () => real() + 6 * 60e3; map.setView([40.79, -73.95], 17); });
      await apage.waitForTimeout(3000);
      const status3 = await apage.textContent('#places-status');
      check('  ...after 5 minutes Azure is asked again, and its places come back', azure.got.searches > before
        && status3.includes('from Azure Maps') && !status3.includes("didn't answer"), status3);
      await actx.close();
    }
    await putSettings(app.base, { azurePlacesDailyLimit: 0 });

    // ---- 2c. Google Maps ----
    console.log('Google Maps');
    await putSettings(app.base, { mapProvider: 'google', googleMapsKey: GOOGLE_KEY });
    {
      const gctx = await browser.newContext({ viewport: { width: 1400, height: 860 } });
      const gseen = await fakeInternet(gctx);
      const gpage = await gctx.newPage();
      await gpage.goto(app.base, { waitUntil: 'networkidle' });
      await gpage.evaluate(() => map.setView([40.7812, -73.9665], 15));
      await gpage.waitForTimeout(1500);
      check('Google pictures come through our server', google.got.tiles > 0 && google.got.keys.has(GOOGLE_KEY), `${google.got.tiles} tiles`);
      check('the browser never sees the Google key', !gseen.tiles.some((t) => t.includes('googleapis'))
        && !(await gpage.content()).includes(GOOGLE_KEY)
        && !JSON.stringify(await (await fetch(`${app.base}/api/settings`)).json()).includes(GOOGLE_KEY));
      const gcredit = await gpage.textContent('#map .leaflet-control-attribution');
      check("Google's credit text is shown", gcredit.includes('Map data ©2026 Google'), gcredit);
      check('the Google logo is shown', await gpage.isVisible('#map .google-logo'));
      const nativeZoom = await gpage.evaluate(() => { let z = null; map.eachLayer((l) => { if (l.options.googleMaxZoom) z = l.options.maxNativeZoom; }); return z; });
      check("pictures come from the closest zoom Google has here (19), not the world's (3)", nativeZoom === 19, `maxNativeZoom ${nativeZoom}`);
      // Places come from Google with the Google map.
      const osmBefore = osm.got.queries;
      await gpage.evaluate(() => map.setView([40.7812, -73.9665], 17));
      await gpage.waitForTimeout(2000);
      check('with Google, places come from Google', await gpage.isVisible('.place-icon .nm >> text=Dollar Store')
        && osm.got.queries === osmBefore, await gpage.textContent('#places-status'));
      check('the daily count is shown', (await gpage.textContent('#places-status')).includes('Google searches used today'),
        await gpage.textContent('#places-status'));
      await gpage.locator('.place-icon', { hasText: 'Dollar Store' }).click();
      await gpage.waitForTimeout(300);
      check('a Google place links to Google Maps', (await gpage.textContent('.leaflet-popup-content')).includes('Open in Google Maps'));
      const searched = google.got.searches;
      await gpage.evaluate(() => { map.closePopup(); map.panBy([20, 10]); });
      await gpage.waitForTimeout(1500);
      check('moving a little does not search Google again (it counts)', google.got.searches === searched, `${google.got.searches - searched} more`);
      check('no OpenStreetMap credit while the places are from Google',
        !(await gpage.textContent('#map .leaflet-control-attribution')).includes('OpenStreetMap'));
      const googleSets = () => gpage.evaluate(() => performance.getEntriesByType('resource')
        .map((e) => (e.name.match(/\/tiles\/google\/([a-z-]+)\/(\d+)\//) || []).slice(1).join('/')).filter(Boolean));
      check("with Google's places as pins, the pictures leave Google's own place labels out",
        (await googleSets()).some((s) => s.startsWith('roadmap-nopoi/17')));
      await gpage.evaluate(() => performance.clearResourceTimings());
      await gpage.click('#btn-layers');
      await gpage.uncheck('#layer-places');
      await gpage.waitForTimeout(800);
      check("Places off: Google's own place labels come back", (await googleSets()).some((s) => s === 'roadmap/17'),
        (await googleSets()).join());
      await gpage.check('#layer-places');
      await gpage.keyboard.press('Escape');
      await gpage.click('#btn-layers');
      await gpage.click('.layer-opt[data-layer=satellite]');
      await gpage.waitForTimeout(800);
      check('Satellite + Details = Google satellite with roads', google.got.sessions.some((b) => b.mapType === 'satellite' && (b.layerTypes || []).includes('layerRoadmap')));
      await gpage.click('.layer-opt[data-layer=terrain]');
      await gpage.waitForTimeout(800);
      check('Google has its own Terrain (no free-map fallback)', google.got.sessions.some((b) => b.mapType === 'terrain')
        && !(await gpage.textContent('.layer-opt[data-layer=terrain]')).includes('free map'));
      await gctx.close();
    }
    await putSettings(app.base, { mapProvider: 'azure' });

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
    check('the flight shows which battery pack flew it (told apart by its size)',
      (await page.textContent('#d-stats')).includes('Standard · 2453 mAh'), await page.textContent('#d-stats'));
    const creditBox = await page.locator('#map .leaflet-control-attribution').boundingBox();
    const detailBox = await page.locator('#detail').boundingBox();
    check('the map credit line stays visible above the flight panel', creditBox.y + creditBox.height <= detailBox.y + 1,
      `credit bottom ${creditBox.y + creditBox.height}, panel top ${detailBox.y}`);
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

    // Charts (5.5.0): one at a time, picked with buttons, same time line.
    const chartNames = await page.$$eval('#d-charts .chart-btn', (els) => els.map((e) => e.textContent));
    check('the flight has Height, Speed, Climb, Battery and Satellites charts',
      JSON.stringify(chartNames) === JSON.stringify(['Height', 'Speed', 'Climb', 'Battery', 'Satellites']), chartNames.join(', '));
    await page.click('.chart-btn[data-chart=speed]');
    check('  ...Speed shows the speed chart with its top speed', /^Speed · max /.test(await page.textContent('#d-profile-label'))
      && (await page.getAttribute('#d-profile', 'data-chart')) === 'speed', await page.textContent('#d-profile-label'));
    await page.click('.chart-btn[data-chart=battery]');
    check('  ...Battery shows start and end percent', /^Battery · 9\d% → 7\d%$/.test(await page.textContent('#d-profile-label')),
      await page.textContent('#d-profile-label'));
    await page.click('.chart-btn[data-chart=climb]');
    check('  ...Climb has a 0 line (up above, down below)', (await page.locator('#d-profile line.zero').count()) === 1);
    await page.evaluate(() => seekTime(60));
    const cursorX = Number(await page.getAttribute('#d-cursor', 'x1'));
    check('  ...the replay line is on the chart after switching', cursorX > 400 && cursorX < 600, String(cursorX));
    check('  ...the choice is remembered', await page.evaluate(() => localStorage.getItem('chart')) === 'climb');
    await page.click('.chart-btn[data-chart=height]');

    await page.click('#d-close');
    await page.waitForTimeout(300);
    check('closing the flight brings the other paths back', (await visibleLines()) > 0);

    // ---- Stats tab (5.5.0): totals, calendar, drones, battery health, records ----
    console.log('Stats tab');
    await page.click('[data-tab=stats]');
    const statsText = await page.textContent('#tab-stats');
    const shownFlights = await page.evaluate(() => state.flights.length);
    check('Stats counts every flight', statsText.includes(`Flights${shownFlights}`), statsText.slice(0, 200));
    const bat1 = page.locator('.battery[data-serial=TESTBATTERY01]');
    check('battery health: the standard battery holds 95% of a new one (2453 of 2590 mAh)',
      /95%\s*of a new one · holds 2453 mAh \(new: 2590 mAh\)/.test(await bat1.textContent()), await bat1.textContent());
    check('  ...the Plus battery is told apart (3790 of 3850 mAh = 98%)',
      /Plus[\s\S]*98%/.test(await page.locator('.battery[data-serial=TESTBATTERY02]').textContent()));
    check('  ...temperature and cell difference are shown', /Temperature/.test(await bat1.textContent()) && /30 mV \(est\.\)/.test(await bat1.textContent()),
      await bat1.textContent());
    check('  ...and it says it is a rough guide, not the official reading', /rough guide only.*DJI Fly/s.test(statsText));
    check('records say they are not a goal to beat', /not a goal to beat.*local rules/.test(statsText));
    const days = await page.locator('#tab-stats button.cal-day').count();
    check('the calendar marks the days flown', days >= 2, String(days));
    await page.locator('#tab-stats button.cal-day').first().click();
    await page.waitForTimeout(200);
    check('  ...clicking a day shows that day in the Flights tab', await page.isVisible('#tab-flights')
      && (await page.inputValue('#search')).length > 0 && (await page.locator('#flight-list .flight').count()) >= 1,
      await page.inputValue('#search'));
    await page.fill('#search', ''); await page.dispatchEvent('#search', 'input');
    await page.click('[data-tab=stats]');
    await page.locator('.record').first().click();
    await page.waitForTimeout(600);
    check('clicking a record opens that flight', await page.isVisible('#detail'));
    await page.click('#d-close');
    check('  ...temperature shows the unit once (e.g. 68–86 °F)', /Temperature\d+–\d+ °[FC]/.test(await bat1.textContent()), await bat1.textContent());

    // Stats per drone: a "Drone" choice, and a Stats button on each drone's card.
    await page.click('[data-tab=stats]');
    const droneOpts = await page.$$eval('#st-drone option', (els) => els.map((e) => e.value));
    check('the Stats tab can show one drone (All drones + each drone)',
      droneOpts[0] === 'all' && droneOpts.includes('TEST0000SERIAL01') && droneOpts.includes('TEST0000SERIAL02'), droneOpts.join(', '));
    await page.selectOption('#st-drone', 'TEST0000SERIAL02');
    let st = await page.textContent('#tab-stats');
    check('  ...only that drone is counted (1 GeoJSON flight, no batteries)', st.includes('Flights1')
      && /No battery serial numbers in this drone's logs/.test(st) && !/Each drone/.test(st), st.slice(0, 300));
    await page.selectOption('#st-drone', 'TEST0000SERIAL01');
    st = await page.textContent('#tab-stats');
    check('  ...the other drone has its batteries, tagged with the drone they flew in',
      (await page.locator('.battery').count()) === 2 && /Flown in: DJI Mini 4 Pro ···RIAL01/.test(st), st.slice(0, 300));
    await page.click('[data-tab=aircraft]');
    await page.locator('.aircraft[data-key=TEST0000SERIAL02] [data-act=stats]').click();
    await page.waitForTimeout(200);
    check("a drone's Stats button opens the Stats tab set to that drone",
      await page.isVisible('#tab-stats') && (await page.inputValue('#st-drone')) === 'TEST0000SERIAL02');
    await page.selectOption('#st-drone', 'all');
    await page.click('[data-tab=aircraft]');
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
    // Right-click the map: "Create a flight plan here".
    await page.mouse.click(800, 250, { button: 'right' });
    await page.waitForTimeout(250);
    const spotClicked = await page.evaluate(() => map.containerPointToLatLng([800, 250]));
    check('right-clicking the map offers "Create a flight plan here"', await page.isVisible('.map-menu')
      && (await page.textContent('.map-menu')).includes('Create a flight plan here') && await page.isHidden('#planner'));
    await page.click('.map-menu-go');
    await page.waitForTimeout(400);
    const made = await page.evaluate(() => Planner._plan());
    check('  ...it opens a new plan with the take-off point on that spot', await page.isVisible('#planner') && made?.home
      && Math.abs(made.home.lat - spotClicked.lat) < 1e-6 && Math.abs(made.home.lon - spotClicked.lng) < 1e-6
      && made.waypoints.length === 0 && (await page.textContent('#pl-save-msg')).includes('Unsaved'), JSON.stringify(made?.home));
    await page.mouse.click(900, 200, { button: 'right' });
    await page.waitForTimeout(250);
    check('  ...with a plan open, right-click offers "Add a waypoint here"', (await page.textContent('.map-menu')).includes('Add a waypoint here'));
    await page.click('.map-menu-go');
    await page.waitForTimeout(300);
    check('  ...which adds waypoint 1 there (not 2: the menu click does not also count as a map click)',
      (await page.evaluate(() => Planner._plan().waypoints.length)) === 1);
    await page.locator('.wp-icon', { hasText: '1' }).click({ button: 'right' });
    await page.waitForTimeout(250);
    check("  ...right-clicking a waypoint still opens the waypoint's own menu only",
      await page.isVisible('.wp-menu-delete') && (await page.locator('.map-menu').count()) === 0);
    await page.keyboard.press('Escape');
    page.once('dialog', (d) => d.accept());
    await page.click('#pl-close');
    await page.waitForTimeout(300);
    check('  ...and the plan closes without saving (nothing in the Plans tab)', await page.isHidden('#planner')
      && (await page.textContent('#plan-list')).includes('No saved plans'));
    await page.click('#btn-new-plan');
    check('new plan asks for the take-off point', (await page.textContent('#pl-hint')).includes('take-off'));
    await page.click('#pl-last-home');
    await page.waitForTimeout(300);
    const hBox = await page.locator('.plan-home').boundingBox();
    const plannerTop = (await page.locator('#planner').boundingBox()).y;
    check('take-off point is visible above the planner panel', hBox && hBox.y + hBox.height < plannerTop, JSON.stringify({ hBox, plannerTop }));
    for (const [x, y] of [[650, 120], [1100, 120], [1150, 300], [650, 300]]) { await page.mouse.click(x, y); await page.waitForTimeout(120); }
    check('clicking the map adds waypoints (4)', (await page.locator('#pl-wps tbody tr').count()) === 4);
    const split = await page.evaluate(() => ({
      editorInSidebar: document.querySelector('#pl-editor').parentElement.id === 'panel',
      tabsHidden: getComputedStyle(document.querySelector('#panel .tabs')).display === 'none',
      numbersAtBottom: !!document.querySelector('#planner #pl-stats') && !!document.querySelector('#planner #pl-weather')
        && !!document.querySelector('#planner #pl-disclaimer'),
    }));
    check('wide screen: the plan editor is in the left sidebar (instead of the tabs), the numbers, weather and the '
      + '"Planning aid only" note at the bottom', split.editorInSidebar && split.tabsHidden && split.numbersAtBottom, JSON.stringify(split));
    const scrolled = await page.evaluate(() => {
      const body = document.querySelector('#pl-editor .pl-edit-body');
      body.style.maxHeight = '200px';   // make it scroll, whatever the window size
      body.scrollTop = body.scrollHeight;
      const p = document.querySelector('#panel').getBoundingClientRect(), s = document.querySelector('#pl-save').getBoundingClientRect();
      const r = { scrolls: body.scrollHeight > body.clientHeight, saveInView: s.top >= p.top && s.bottom <= p.bottom,
        bodyBelowHead: body.getBoundingClientRect().top >= document.querySelector('#pl-editor .detail-head').getBoundingClientRect().bottom - 1 };
      body.scrollTop = 0;
      body.style.maxHeight = '';
      return r;
    });
    check('the editor scrolls under its top row: Save plan and ✕ stay in view', scrolled.scrolls && scrolled.saveInView
      && scrolled.bodyBelowHead, JSON.stringify(scrolled));
    // Right-click a waypoint: a menu with Delete (here on a 5th, extra point).
    await page.mouse.click(900, 200);
    await page.waitForTimeout(150);
    await page.locator('.wp-icon', { hasText: '5' }).click({ button: 'right' });
    check('right-clicking a waypoint opens its menu', await page.isVisible('.wp-menu') && (await page.textContent('.wp-menu')).includes('Waypoint 5'));
    await page.click('.wp-menu-delete');
    await page.waitForTimeout(400);   // the menu fades out (0.2 s) before it is removed
    check('  ...and Delete removes that waypoint', (await page.locator('#pl-wps tbody tr').count()) === 4 && await page.isHidden('.wp-menu'));
    check('new waypoints start at 200 ft and 18 mph',
      (await page.inputValue('#pl-wps tr[data-i="0"] input[data-f=alt]')) === '200' && (await page.inputValue('#pl-wps tr[data-i="0"] input[data-f=speed]')) === '18');
    check('distance and time are worked out', !(await page.textContent('#pl-stats')).includes('–'));
    const okText = await page.textContent('#pl-warnings');
    check('"OK" says airspace, obstacles and local rules are not checked', /Airspace, obstacles and local rules are not checked/.test(okText), okText);
    check('local-laws disclaimer is always shown in the planner', await page.isVisible('#pl-disclaimer')
      && (await page.textContent('#pl-disclaimer')).includes('Always check your local laws and regulations'));
    // Battery: the standard one by default (the last flight with a known battery used it).
    const batteryUsed = async () => Number((await page.textContent('#pl-stats')).match(/Battery used\s*~(\d+)%/)?.[1]);
    const note = () => page.textContent('#pl-battery-note');
    const standardUse = await batteryUsed();
    check('battery: the standard one at first, learned from the standard-battery flights',
      (await page.inputValue('#pl-battery-kind')) === 'standard' && /1 flight with the standard battery/.test(await note()), await note());
    await page.selectOption('#pl-battery-kind', 'plus');
    await page.waitForTimeout(200);
    check('  ...the Plus battery uses the flights flown with it',
      /1 flight with the Plus battery/.test(await note()) && (await batteryUsed()) !== standardUse, `${standardUse}% vs ${await batteryUsed()}%: ${await note()}`);
    check('  ...and says the drone is then over 249 g (registration rules)', /more than 249 g.*Check your local rules/.test(await note()));
    check('  ...and the choice counts as an unsaved change', (await page.textContent('#pl-save-msg')).includes('Unsaved'));
    await page.selectOption('#pl-battery-kind', 'standard');
    await page.waitForTimeout(200);
    check('  ...back to standard: the same estimate as before', (await batteryUsed()) === standardUse && !/249 g/.test(await note()));
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
    // A slow forecast for an earlier choice must not replace the newer one.
    seen.slowRain = 2500;
    await page.fill('#pl-when', `${localDay(1)}T10:00`);
    await page.$eval('#pl-when', (el) => el.dispatchEvent(new Event('change', { bubbles: true })));
    await page.waitForTimeout(900);                       // its (slow, rainy) request is on its way
    await setWhen(`${localDay(1)}T21:00`);                // a new choice, answered at once
    await page.waitForTimeout(2500);                      // ...then the slow answer arrives
    await page.fill('#pl-battery', '95');                 // any change: the warnings are worked out again
    await page.press('#pl-battery', 'Tab');
    await page.waitForTimeout(200);
    check('weather: a late answer for an earlier time is dropped (no wrong rain warning)',
      (await warns()).includes('after sunset') && !(await warns()).includes('chance of rain'), await warns());
    await page.fill('#pl-name', 'Test loop');
    await page.evaluate(() => { $('#pl-save').click(); $('#pl-save').click(); });   // a quick double click
    await page.waitForTimeout(700);
    check('plan saves', (await page.textContent('#pl-save-msg')).includes('Saved'));
    check('plan appears in the Plans tab, once (a double click on Save makes one plan)',
      (await page.locator('.plan-card').count()) === 1, `${await page.locator('.plan-card').count()} plans`);
    // Unsaved changes: closing asks first; saying "no" keeps the plan open.
    // (While a plan is open on a wide screen, the sidebar shows its editor, not the tabs.)
    await page.fill('#pl-name', 'Test loop (changed)');   // an unsaved change
    page.once('dialog', (d) => d.dismiss());
    await page.click('#pl-close');
    await page.waitForTimeout(400);
    check('unsaved plan: asks before closing, and stays open on "no"', await page.isVisible('#planner'));
    // Reload: the plan is still there, with exact values.
    page.once('dialog', (d) => d.accept());
    await page.reload({ waitUntil: 'networkidle' });
    check('no plan markers on the map outside the Plans tab', (await page.locator('.plan-blip').count()) === 0);
    await page.click('[data-tab=plans]');
    await page.waitForTimeout(300);
    check('the Plans tab puts a marker on the map at each saved plan\'s take-off point',
      (await page.locator('.plan-blip').count()) === 1 && await page.isVisible('.plan-blip'));
    await page.hover('.plan-card');
    check('  ...pointing at a plan in the list lights up its marker', await page.locator('.plan-blip.active').count() === 1);
    await page.click('[data-tab=aircraft]');
    check('  ...and the markers go when you leave the Plans tab', (await page.locator('.plan-blip').count()) === 0);
    await page.click('[data-tab=plans]');
    await page.waitForTimeout(300);
    await page.click('.plan-blip');
    await page.waitForTimeout(400);
    check('  ...clicking a marker opens that plan (and the markers hide while it is open)',
      await page.isVisible('#planner') && (await page.inputValue('#pl-name')) === 'Test loop' && (await page.locator('.plan-blip').count()) === 0);
    await page.click('#pl-close');
    await page.waitForTimeout(300);
    check('  ...closing it brings them back', (await page.locator('.plan-blip').count()) === 1);
    check('  ...and the sidebar shows the tabs and the plans list again', await page.isVisible('#panel .tabs')
      && await page.isVisible('#plan-list') && await page.isHidden('#pl-editor'));
    await page.click('.plan-card');
    await page.waitForTimeout(400);
    check('saved plan opens again with its 4 waypoints', (await page.locator('#pl-wps tbody tr').count()) === 4);
    check('500 ft is still exactly 500 ft', (await page.inputValue(altBox)) === '500');
    // ---- Download for DJI Fly ----
    const djProblems = () => page.$$eval('#dj-problems li', (els) => els.map((e) => e.innerText).join(' | '));
    const tickAll = async () => { for (const c of await page.$$('.dj-ok')) await c.check(); };
    await page.click('#pl-djifly');
    await tickAll();
    check('DJI Fly: a waypoint above the height limit blocks the download, even with every box ticked',
      (await djProblems()).includes('height limit') && await page.isDisabled('#dj-download'), await djProblems());
    await page.keyboard.press('Escape');
    await page.fill(altBox, '200');
    await page.press(altBox, 'Tab');
    const speedBox = '#pl-wps tr[data-i="1"] input[data-f=speed]';
    await page.fill(speedBox, '25');
    await page.press(speedBox, 'Tab');
    await page.fill('#pl-when', '');
    await page.$eval('#pl-when', (el) => el.dispatchEvent(new Event('change', { bubbles: true })));
    await page.waitForTimeout(1200);   // the weather is looked up again (here: none) after a moment
    await page.click('#pl-djifly');
    check('DJI Fly: unsaved changes must be saved first', (await djProblems()).includes('Save the plan first'), await djProblems());
    check('DJI Fly: different speeds are explained (DJI Fly has one speed)',
      (await page.textContent('#dj-speed')).includes('one speed for the whole route') && await page.isVisible('#dj-speed-apply'));
    await page.fill('#dj-speed-value', '18');
    await page.click('#dj-speed-apply');
    await page.waitForTimeout(600);
    check('DJI Fly: "Apply and save" gives every waypoint one speed and saves the plan',
      (await page.textContent('#dj-speed')).includes('The whole route flies at') && (await djProblems()) === ''
      && (await page.textContent('#pl-save-msg')).includes('Saved'), await djProblems());
    check('DJI Fly: the download waits until every safety box is ticked', await page.isDisabled('#dj-download'));
    await tickAll();
    check('DJI Fly: says the drone flies curves and cuts the corners', (await page.textContent('#dj-dialog')).includes('cuts the corners'));
    check('DJI Fly: a box to tick about taking off from the plan\'s take-off point',
      (await page.textContent('#dj-dialog')).includes("take off from the plan's take-off point") && (await page.$$('.dj-ok')).length === 5);
    const [kmz] = await Promise.all([page.waitForEvent('download'), page.click('#dj-download')]);
    const kmzBytes = fs.readFileSync(await kmz.path());
    check('DJI Fly: downloads a .kmz (a ZIP file) named after the plan',
      kmz.suggestedFilename() === 'Test loop.kmz' && kmzBytes.subarray(0, 2).toString() === 'PK', kmz.suggestedFilename());
    check('DJI Fly: the window explains how to put it on the RC 2, with a backup first',
      (await page.textContent('#dj-dialog')).includes('Copy the .kmz that is already there to your PC first'));
    // ---- Send to RC 2 (through the RC 2 dock; here the test plays the dock) ----
    await page.waitForTimeout(300);
    check('RC 2: without a dock key, the window points to Settings → RC 2 dock',
      (await page.textContent('#dj-rc2')).includes('Settings → RC 2 dock') && await page.isHidden('#dj-rc2-send'));
    const pageHeaders = { 'X-Requested-With': 'flightmap', 'Content-Type': 'application/json' };
    const dockKey = (await (await fetch(`${app.base}/api/rc2/key`, { method: 'POST', headers: pageHeaders })).json()).key;
    const dockCall = (p, method = 'GET', data) => fetch(`${app.base}${p}`, {
      method, headers: { Authorization: `Bearer ${dockKey}`, 'Content-Type': 'application/json' },
      body: data ? JSON.stringify(data) : undefined,
    }).then((r) => r.json());
    const RC2_UUID = '0A1B2C3D-0000-4000-8000-0000000000AA';
    const RC2_SLOT1 = '0A1B2C3D-0000-4000-8000-0000000000A1';
    // The pretend RC 2 holds the file just downloaded (4 waypoints: slot 3's
    // placeholder) and a 2-waypoint placeholder (slot 1), made by the test's helper.
    const twoPoints = execFileSync('python3', ['-c', `import sys, base64; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'tests'))}); `
      + 'from test_server import placeholder_kmz; print(base64.b64encode(placeholder_kmz([(40.7812, -73.9665, 30), (40.7830, -73.9660, 40)])).decode())']).toString().trim();
    await dockCall('/api/dock/missions', 'PUT', { missions: [
      { uuid: RC2_UUID, kmz: kmzBytes.toString('base64'), modified: '2026-11-20' },
      { uuid: RC2_SLOT1, kmz: twoPoints, modified: '2026-11-20' }] });
    await page.keyboard.press('Escape');
    await page.click('#pl-djifly');
    await tickAll();
    await page.waitForTimeout(600);
    check('RC 2: until the slots are confirmed, the window says how to set them up (2, 3, 4 and 5 waypoints)',
      (await page.textContent('#dj-rc2')).includes('2, 3, 4 and 5 waypoints') && await page.isDisabled('#dj-rc2-send'), await page.textContent('#dj-rc2'));
    await fetch(`${app.base}/api/rc2/slot`, { method: 'POST', headers: pageHeaders, body: JSON.stringify({ slot: 3, uuid: RC2_UUID }) });
    await page.keyboard.press('Escape');
    await page.click('#pl-djifly');
    await tickAll();
    await page.waitForTimeout(600);
    check('RC 2: the 4 slots are listed; slot 3 is ready (with a sketch of its route), the others not set up',
      (await page.locator('.rc2-mission').count()) === 4 && (await page.locator('.rc2-mission.off').count()) === 3
      && (await page.textContent('#dj-rc2')).includes('Slot 3: the placeholder (4 waypoints)') && await page.isVisible('.rc2-sketch'),
      await page.textContent('#dj-rc2'));
    check('RC 2: Send waits until a slot is picked', await page.isDisabled('#dj-rc2-send'));
    await page.check('input[name=rc2-slot][value="3"]');
    check('RC 2: ...then it can be sent', await page.isEnabled('#dj-rc2-send'));
    await page.click('#dj-rc2-send');
    await page.waitForTimeout(800);
    check('RC 2: the send waits for the dock', (await page.textContent('#dj-rc2')).includes('Slot 3: waiting for the dock'),
      await page.textContent('#dj-rc2'));
    const rc2Queue = await dockCall('/api/dock/queue');
    check("RC 2: the dock gets it, with the placeholder's fingerprint",
      rc2Queue.send.length === 1 && rc2Queue.send[0].uuid === RC2_UUID && /^[0-9a-f]{64}$/.test(rc2Queue.send[0].expectSha256), JSON.stringify(rc2Queue));
    await dockCall(`/api/dock/result/${rc2Queue.send[0].id}`, 'POST', { ok: true, message: 'written and checked' });
    await page.waitForTimeout(5600);   // the window looks again every 5 seconds
    check('RC 2: when the dock is done, the window says to check the route in DJI Fly before flying',
      (await page.textContent('#dj-rc2')).includes('check the route on its map')
      && (await page.textContent('#dj-rc2')).includes('Slot 3: holds Test loop from the map'), await page.textContent('#dj-rc2'));
    await page.keyboard.press('Escape');
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
    // The NAS card is checked when the page opens. Here the logs are a plain
    // folder, so there is nothing to reconnect.
    await page.waitForSelector('#nas-checks li', { timeout: 15000 }).catch(() => {});
    check('the NAS card checks the logs when the page opens', (await page.textContent('#nas-summary')).includes('can be read')
      && await page.isHidden('#nas-reconnect'), await page.textContent('#nas-summary'));
    check('the RC 2 dock card shows the dock checked in and sent the list',
      (await page.textContent('#dock-checks')).includes('last checked in') && (await page.textContent('#dock-checks')).includes('2 missions'),
      await page.textContent('#dock-checks'));
    const slotsText = () => page.textContent('#dock-slot-list');
    check('the slots: slot 3 confirmed, slot 1 offers its 2-waypoint placeholder, slot 2 says how to make one',
      (await slotsText()).includes('confirmed') && await page.isVisible('button[data-slot="1"]')
      && (await slotsText()).includes('exactly 3 waypoints'), await slotsText());
    await page.click('button[data-slot="1"]');
    await page.waitForTimeout(500);
    check('"Use as slot 1" confirms it', (await page.locator('#dock-slot-list button[data-free]').count()) === 2, await slotsText());
    page.once('dialog', (d) => d.accept());
    await page.click('button[data-free="1"]');
    await page.waitForTimeout(500);
    check('"Free this slot" frees it again', (await page.locator('#dock-slot-list button[data-free]').count()) === 1
      && await page.isVisible('button[data-slot="1"]'), await slotsText());
    page.once('dialog', (d) => d.accept());
    await page.click('#dock-make');
    await page.waitForTimeout(500);
    check('a new dock key is shown once, with the map address and the command for the Pi',
      (await page.textContent('#dock-key')).startsWith('dock_') && (await page.textContent('#dock-url')).startsWith('http')
      && (await page.textContent('#dock-new')).includes('sudo dji-map-link') && (await page.textContent('#dock-checks')).includes("hasn't checked in"),
      await page.textContent('#dock-checks'));
    {
      // A lost NAS share (the server's answers are pretend ones here).
      const nctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await fakeInternet(nctx);
      let pending = false, fixed = false, asked = 0, fromOurPage = false;
      const nasStatus = () => ({
        kind: 'share', ok: fixed && !pending, pending,
        summary: pending ? '⏳ Asked the Proxmox server to reconnect.' : fixed ? '✓ Connected: the flight logs on the NAS can be read.'
          : "⚠️ The map can't reach its flight logs on the NAS.",
        checks: [{ id: 'reachable', ok: true, text: 'The NAS (192.168.1.10) answers on the network' },
          { id: 'connected', ok: fixed, text: fixed ? 'The NAS share is connected to the map' : "The NAS share isn't connected to the map" },
          { id: 'readable', ok: fixed, text: fixed ? 'The flight logs can be read' : "The flight logs can't be read: the folder is empty" },
          { id: 'helper', ok: true, text: 'Automatic reconnect is on' }],
        message: fixed ? 'Restarted the map, so it sees the NAS share again.' : '',
      });
      await nctx.route('**/api/nas', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(nasStatus()) }));
      await nctx.route('**/api/nas/reconnect', (route) => {
        asked++;
        fromOurPage = route.request().headers()['x-requested-with'] === 'flightmap';
        pending = true;
        setTimeout(() => { pending = false; fixed = true; }, 2000);
        return route.fulfill({ contentType: 'application/json', body: '{"requested":true}' });
      });
      const npage = await nctx.newPage();
      await npage.goto(`${app.base}/settings.html`, { waitUntil: 'networkidle' });
      await npage.waitForSelector('#nas-checks li');
      check('a lost NAS share is shown, with a Reconnect now button',
        (await npage.textContent('#nas-summary')).includes("can't reach") && await npage.isVisible('#nas-reconnect')
        && (await npage.locator('#nas-checks li.warn').count()) === 2);
      await npage.click('#nas-reconnect');
      await npage.waitForFunction(() => document.querySelector('#nas-summary').textContent.includes('Connected'), null, { timeout: 20000 }).catch(() => {});
      check('Reconnect now asks the server once, from our page, then shows it fixed',
        asked === 1 && fromOurPage && (await npage.textContent('#nas-summary')).includes('Connected'), { asked, fromOurPage });
      check('  ...and what the Proxmox server did', (await npage.textContent('#nas-message')).includes('Restarted the map'));
      await nctx.close();
    }
    check('the HTTPS box says it is off, with the way back', (await page.textContent('#https-status')).includes('plain http')
      && (await page.textContent('#https-cmd')).includes('set-https.sh --off') && await page.isHidden('#https-private'));
    await page.click('label:has([name=httpsMode][value=letsencrypt])');
    check("Let's Encrypt asks for the DNS company's token", await page.isVisible('#cred-cf') && await page.isVisible('#httpsName'));
    await page.selectOption('#https-dns', 'dns_gd');
    check('GoDaddy asks for its key and secret', await page.isVisible('#cred-gdk') && await page.isVisible('#cred-gds') && await page.isHidden('#cred-cf'));
    await page.click('label:has([name=httpsMode][value=off])');
    check('Off hides the name, port and DNS boxes', await page.isHidden('#httpsName') && await page.isHidden('#cred-gdk'));
    await page.reload({ waitUntil: 'networkidle' });
    const shownKeys = () => page.$$eval('.provider-key', (els) => [...new Set(els.filter((e) => !e.classList.contains('hidden')).map((e) => e.dataset.provider))].join());
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
    await page.fill('#tunnelAddress', 'flightmap.home');
    await page.click('#btn-save');
    await page.waitForTimeout(500);
    check('a Cloudflare Tunnel "address" that is a name is refused, with a reason',
      (await page.textContent('#save-msg')).includes('must be an address'), await page.textContent('#save-msg'));
    await page.fill('#tunnelAddress', ' 192.168.1.50 ');
    await page.click('#btn-save');
    await page.waitForTimeout(500);
    const savedTunnel = await page.evaluate(async () => (await (await fetch('/api/settings')).json()).settings.tunnelAddress);
    check('the Cloudflare Tunnel address is saved', savedTunnel === '192.168.1.50'
      && (await page.textContent('#save-msg')).includes('Saved'), savedTunnel);
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
      ['a release tagged without the v (99.0.0) also shows the notice', { version: '99.0.0', notes: ['Test note'], noV: true }, true, true],
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
        const tagPath = gh.noV ? '/99.0.0/app/version.json' : '/v99.0.0/app/version.json';
        check('notes come from the released version (its tag), not from main', seen.notesFrom.endsWith(tagPath), seen.notesFrom);
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

    // ---- 5b. turning HTTPS on from the settings page ----
    console.log('HTTPS from the settings page');
    {
      const httpsPort = await freePort();
      const own = await startServer(archive, { FLIGHTMAP_IP: '127.0.0.1' });
      servers.push(own);
      const hctx = await browser.newContext({ ignoreHTTPSErrors: true });
      await fakeInternet(hctx);
      const hpage = await hctx.newPage();
      await hpage.goto(`${own.base}/settings.html`, { waitUntil: 'networkidle' });
      await hpage.click('label:has([name=httpsMode][value=private])');
      check('choosing HTTPS says the page will move', await hpage.isVisible('#https-save-note'));
      await hpage.fill('#httpsPort', String(httpsPort));
      await hpage.click('#btn-save');
      await hpage.waitForURL(`https://127.0.0.1:${httpsPort}/settings.html#https`, { timeout: 20000 }).catch(() => {});
      check('after Save, the page moves to the https address', hpage.url().startsWith(`https://127.0.0.1:${httpsPort}/`), hpage.url());
      await hpage.waitForTimeout(800);
      check('it says HTTPS is on, with a private certificate', (await hpage.textContent('#https-status')).includes('🔒 On'),
        await hpage.textContent('#https-status'));
      check('...and offers the certificate download with the Windows steps', await hpage.isVisible('#https-ca')
        && (await hpage.textContent('#https-private')).includes('Trusted Root Certification Authorities'));
      await hctx.close();
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
    await page.click('[data-tab=plans]');
    await page.click('#btn-new-plan');
    await page.waitForTimeout(300);
    const phonePlan = await page.evaluate(() => {
      const box = document.querySelector('#planner').getBoundingClientRect();
      return { inOnePanel: document.querySelector('#pl-editor').parentElement.id === 'planner', bottom: Math.round(box.bottom),
        saveVisible: !!document.querySelector('#pl-save').offsetParent };
    });
    check('phone: the planner stays one panel at the bottom, editor included', phonePlan.inOnePanel && phonePlan.bottom === 844
      && phonePlan.saveVisible, JSON.stringify(phonePlan));
    await page.click('#pl-close');
    await page.waitForTimeout(200);
    await page.click('#btn-addr');
    await page.waitForTimeout(200);
    const addrPanel = await page.locator('#addr-panel').boundingBox();
    check('the address search box fits on a phone screen', addrPanel && addrPanel.x >= 0 && addrPanel.x + addrPanel.width <= 390,
      JSON.stringify(addrPanel));
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'phone-search.png') });
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
    osm.close();
    google.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
