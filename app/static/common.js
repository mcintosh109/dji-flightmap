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
