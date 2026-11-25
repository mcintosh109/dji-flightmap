// The README's pictures (docs/images/), made from the made-up test flights
// (Central Park, fake serial numbers), so nothing real is ever shown.
//
//   node docs/make-pictures.js            (needs Node.js, Playwright and Python 3)
//
// It starts the real map server with the test flights, and pretend
// OpenStreetMap places, address search and weather. Claude's sandbox can't
// load real map pictures, so the map underneath is left plain (MAP_BG).
'use strict';
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'images'));
fs.mkdirSync(OUT, { recursive: true });
const MAP_BG = '#30363f';   // plain map background (the real map pictures can't be loaded here)

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const listen = async (handler) => { const port = await freePort(); http.createServer(handler).listen(port, '127.0.0.1'); return `http://127.0.0.1:${port}`; };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-shots-'));
  const archive = path.join(tmp, 'archive');
  execFileSync('python3', [path.join(ROOT, 'tests', 'fixtures.py'), archive]);

  // Pretend OpenStreetMap places (around whatever is asked) and address search.
  const overpass = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const q = new URLSearchParams(body).get('data') || '';
      const [s, w, n, e] = (q.match(/\[bbox:([^\]]+)\]/) || [0, '0,0,0,0'])[1].split(',').map(Number);
      const lat = (s + n) / 2, lon = (w + e) / 2;
      const p = (id, dy, dx, name, tags) => ({ type: 'node', id, lat: lat + dy, lon: lon + dx, tags: { name, ...tags } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ elements: [
        p(1, 0.0006, -0.0012, 'Corner Cafe', { amenity: 'cafe' }),
        p(2, 0.0016, 0.0009, 'Hillside School', { amenity: 'school' }),
        p(3, -0.0004, 0.0018, 'County Heliport', { aeroway: 'heliport' }),
        p(4, -0.0014, -0.0006, 'Town Clinic', { amenity: 'clinic' }),
        p(5, -0.0010, 0.0030, 'Main St Gas', { amenity: 'fuel' }),
        p(6, 0.0012, -0.0030, 'Lakeside Park', { leisure: 'park' }),
        p(7, -0.0022, -0.0024, 'Village Grocery', { shop: 'supermarket' }),
      ] }));
    });
  });
  const nominatim = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([
      { lat: '40.7757', lon: '-73.9712', display_name: 'Bow Bridge, Central Park, Manhattan, New York, United States',
        category: 'man_made', type: 'bridge', boundingbox: ['40.7755', '40.7759', '-73.9718', '-73.9706'] },
      { lat: '40.7764', lon: '-73.9690', display_name: 'Bow Bridge Road, Central Park, Manhattan, New York, United States',
        category: 'highway', type: 'footway' },
      { lat: '40.7790', lon: '-73.9690', display_name: 'Belvedere Castle, Central Park, Manhattan, New York, United States',
        category: 'tourism', type: 'attraction' },
    ]));
  });

  const port = await freePort();
  const state = path.join(tmp, 'state');
  fs.mkdirSync(state);
  const server = spawn('python3', ['-u', path.join(ROOT, 'app', 'server.py')], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', DATA_DIR: archive, PORT: String(port), HOST: '127.0.0.1',
      CACHE_FILE: path.join(state, 'summaries.json'), DEFAULT_HTTPS: 'off', OVERPASS_URL: `${overpass}/api/interpreter`,
      NOMINATIM_URL: nominatim },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const d = await (await fetch(`${base}/api/flights`)).json(); if (!d.scanning) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'flightmap' },
    body: JSON.stringify({ mapProvider: 'free', mapLayer: 'road', checkUpdates: false, units: 'imperial' }) });

  const browser = await chromium.launch();
  const forecast = () => {
    const pad = (n) => String(n).padStart(2, '0');
    const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const time = [], days = [];
    for (let h = 0; h < 16 * 24; h++) { const t = new Date(start.getTime() + h * 3600e3); time.push(`${day(t)}T${pad(t.getHours())}:00`); }
    for (let d = 0; d < 16; d++) days.push(day(new Date(start.getTime() + d * 86400e3)));
    const fill = (v) => Array(time.length).fill(v);
    return { hourly: { time, temperature_2m: fill(14), precipitation_probability: fill(5), weather_code: fill(1),
      wind_speed_10m: fill(3), wind_direction_10m: fill(250), wind_gusts_10m: fill(6), wind_speed_80m: fill(5), wind_speed_120m: fill(6) },
    daily: { time: days, sunrise: days.map((d) => `${d}T06:45`), sunset: days.map((d) => `${d}T17:15`) } };
  };
  const newPage = async (viewport) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1.5 });   // sharp, but not huge files
    await ctx.route(/^https?:\/\//, (route) => {
      const u = new URL(route.request().url());
      if (u.hostname === '127.0.0.1') return route.continue();
      if (u.hostname === 'api.open-meteo.com') {
        return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(forecast()) });
      }
      return route.fulfill({ contentType: 'image/svg+xml',
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="${MAP_BG}"/></svg>` });
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('page error:', e.message));
    return page;
  };
  const shot = async (page, name, clip) => {
    await page.screenshot({ path: path.join(OUT, name), clip });
    console.log('saved', name);
  };

  try {
    // 1. All flights.
    let page = await newPage({ width: 1280, height: 800 });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    await page.click('#btn-fit');
    await page.waitForTimeout(600);
    await shot(page, 'overview.png');

    // 2. One flight, replaying.
    await page.click('[data-tab=flights]');
    await page.locator('.flight', { hasText: '197 ft' }).click();   // the flight with all the details
    await page.waitForTimeout(900);
    await page.evaluate(() => {
      const s = document.querySelector('#p-scrub');
      s.value = Math.round(Number(s.max) * 0.55);
      s.dispatchEvent(new Event('input'));
    });
    await page.waitForTimeout(500);
    await shot(page, 'flight-replay.png');
    await page.click('#d-close');
    await page.waitForTimeout(300);

    // 3. Address search.
    await page.evaluate(() => map.setView([40.7812, -73.9665], 15));
    await page.click('#btn-addr');
    await page.fill('#addr-q', 'Bow Bridge');
    await page.press('#addr-q', 'Enter');
    await page.waitForSelector('.addr-result', { timeout: 8000 });
    await page.waitForTimeout(300);
    const sp = await page.locator('#addr-panel').boundingBox();
    await shot(page, 'address-search.png', { x: sp.x - 16, y: 8, width: 1280 - (sp.x - 16), height: sp.y + sp.height + 8 });
    await page.click('.addr-result >> nth=0');
    await page.waitForTimeout(900);

    // 4. Right-click the pin: "Create a flight plan here".
    const pinBox = await page.locator('.addr-pin').boundingBox();
    await page.mouse.click(pinBox.x + pinBox.width / 2, pinBox.y + pinBox.height + 2, { button: 'right' });
    await page.waitForTimeout(400);
    const menu = await page.locator('.map-menu').boundingBox();
    await shot(page, 'right-click.png', { x: menu.x - 40, y: menu.y - 30, width: menu.width + 80, height: menu.height + 90 });
    await page.keyboard.press('Escape');
    await page.click('#addr-clear').catch(() => {});

    // 5. The planner, with weather.
    await page.click('[data-tab=plans]');
    await page.click('#btn-new-plan');
    await page.click('#pl-last-home');
    await page.waitForTimeout(400);
    await page.evaluate(() => map.setZoom(16));
    await page.waitForTimeout(400);
    for (const [x, y] of [[700, 140], [960, 120], [1040, 260], [760, 300]]) { await page.mouse.click(x, y); await page.waitForTimeout(150); }
    await page.mouse.move(300, 760);   // no hover label over the map
    await page.fill('#pl-name', 'Park loop');
    const t = new Date(Date.now() + 86400e3);
    const pad = (n) => String(n).padStart(2, '0');
    await page.fill('#pl-when', `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T10:00`);
    await page.dispatchEvent('#pl-when', 'change');
    await page.waitForTimeout(1500);
    await shot(page, 'planner.png');

    // 6. Save it, then the DJI Fly window.
    await page.click('#pl-save');
    await page.waitForTimeout(700);
    await page.click('#pl-djifly');
    await page.waitForTimeout(800);
    await shot(page, 'dji-fly.png');
    await page.context().close();

    // 7. Settings page.
    page = await newPage({ width: 1280, height: 900 });
    await page.goto(`${base}/settings.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await shot(page, 'settings.png');
    await page.context().close();

    // 8. Phone.
    page = await newPage({ width: 390, height: 844 });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    await shot(page, 'phone.png');
    await page.context().close();
  } finally {
    await browser.close();
    server.kill();
    process.exit(0);
  }
})();
