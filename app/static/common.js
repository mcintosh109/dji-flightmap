'use strict';
/*
  Tiny helpers shared by every page (the map and the settings page).
  Loaded first, before the other scripts.
*/

// Find one element / all elements, e.g. $('#status') or $$('.flight').
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

// Make text safe to put into HTML (so a file name like "<b>" shows as text).
const esc = (value) => String(value ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Remember small choices in this browser. localStorage can be blocked
// (private windows etc.), so never let it crash the page.
function loadSetting(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function saveSetting(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } }

// "just now", "5 minutes ago", "3 hours ago", or the date.
function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 129600) return `${Math.round(s / 3600)} hours ago`;
  return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

// A small drawing of a DJI Fly mission's route ([[lat, lon, h], ...]), scaled to fit.
function routeSketch(points) {
  const w = 72, h = 54, pad = 6;
  if (!points || points.length === 0) return `<svg class="rc2-sketch" viewBox="0 0 ${w} ${h}" aria-hidden="true"></svg>`;
  const lats = points.map((p) => p[0]), lons = points.map((p) => p[1]);
  const kx = Math.cos((Math.min(...lats) + Math.max(...lats)) / 2 * Math.PI / 180);
  const spanX = (Math.max(...lons) - Math.min(...lons)) * kx || 1e-6, spanY = (Math.max(...lats) - Math.min(...lats)) || 1e-6;
  const k = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
  const xy = points.map((p) => [pad + ((p[1] - Math.min(...lons)) * kx) * k, h - pad - (p[0] - Math.min(...lats)) * k]);
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const dots = xy.map(([x, y], i) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${i === 0 ? 3 : 2}"/>`).join('');
  return `<svg class="rc2-sketch" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${line}"/>${dots}</svg>`;
}

// DJI Fly's own picture of a mission (from the dock), or a drawing of its route.
const missionPicture = (m) => (m.preview
  ? `<img class="rc2-preview" alt="" src="api/rc2/preview/${encodeURIComponent(m.uuid)}?v=${esc(m.sha256.slice(0, 8))}">`
  : routeSketch(m.points));
