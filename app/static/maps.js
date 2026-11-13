'use strict';
/*
  Map styles ("tile layers"). A web map is made of many small square
  pictures called tiles; each style below says where to download them.

  Some need a key (a password-like code you get free from the map company):
    Mapbox   -> https://account.mapbox.com/access-tokens/  (an "access token", starts with pk.)
    MapTiler -> https://cloud.maptiler.com/account/keys/    (an "API key")
  Used by both index.html (the map) and settings.html (the preview).
*/
window.MapStyles = (() => {
  const OSM = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const MAPBOX = '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> ' + OSM;
  const MAPTILER = '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> ' + OSM;
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // needs: which setting must be filled in for the style to work.
  const STYLES = [
    { id: 'carto-dark', name: 'Dark', group: 'Free',
      url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      opts: { subdomains: 'abcd', maxNativeZoom: 20, attribution: OSM + ' &copy; <a href="https://carto.com/attributions">CARTO</a>' } },
    { id: 'carto-light', name: 'Light', group: 'Free',
      url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      opts: { subdomains: 'abcd', maxNativeZoom: 20, attribution: OSM + ' &copy; <a href="https://carto.com/attributions">CARTO</a>' } },
    { id: 'osm', name: 'Street map (OpenStreetMap)', group: 'Free',
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      opts: { maxNativeZoom: 19, attribution: OSM } },
    { id: 'esri-satellite', name: 'Satellite (Esri)', group: 'Free', satellite: true,
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      opts: { maxNativeZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' } },

    { id: 'mapbox-satellite', name: 'Mapbox satellite + streets', group: 'Mapbox', needs: 'mapboxToken',
      url: (s) => `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/256/{z}/{x}/{y}@2x?access_token=${encodeURIComponent(s.mapboxToken)}`,
      opts: { maxNativeZoom: 22, attribution: MAPBOX } },
    { id: 'mapbox-dark', name: 'Mapbox dark', group: 'Mapbox', needs: 'mapboxToken',
      url: (s) => `https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/256/{z}/{x}/{y}@2x?access_token=${encodeURIComponent(s.mapboxToken)}`,
      opts: { maxNativeZoom: 22, attribution: MAPBOX } },
    { id: 'mapbox-outdoors', name: 'Mapbox outdoors', group: 'Mapbox', needs: 'mapboxToken',
      url: (s) => `https://api.mapbox.com/styles/v1/mapbox/outdoors-v12/tiles/256/{z}/{x}/{y}@2x?access_token=${encodeURIComponent(s.mapboxToken)}`,
      opts: { maxNativeZoom: 22, attribution: MAPBOX } },

    { id: 'maptiler-hybrid', name: 'MapTiler satellite + labels', group: 'MapTiler', needs: 'maptilerKey',
      url: (s) => `https://api.maptiler.com/maps/hybrid/256/{z}/{x}/{y}.jpg?key=${encodeURIComponent(s.maptilerKey)}`,
      opts: { maxNativeZoom: 20, attribution: MAPTILER } },
    { id: 'maptiler-satellite', name: 'MapTiler satellite', group: 'MapTiler', needs: 'maptilerKey', satellite: true,
      url: (s) => `https://api.maptiler.com/maps/satellite/256/{z}/{x}/{y}.jpg?key=${encodeURIComponent(s.maptilerKey)}`,
      opts: { maxNativeZoom: 20, attribution: MAPTILER } },
    { id: 'maptiler-streets', name: 'MapTiler streets', group: 'MapTiler', needs: 'maptilerKey',
      url: (s) => `https://api.maptiler.com/maps/streets-v2/256/{z}/{x}/{y}.png?key=${encodeURIComponent(s.maptilerKey)}`,
      opts: { maxNativeZoom: 22, attribution: MAPTILER } },
    { id: 'maptiler-outdoor', name: 'MapTiler outdoor', group: 'MapTiler', needs: 'maptilerKey',
      url: (s) => `https://api.maptiler.com/maps/outdoor-v2/256/{z}/{x}/{y}.png?key=${encodeURIComponent(s.maptilerKey)}`,
      opts: { maxNativeZoom: 22, attribution: MAPTILER } },

    { id: 'custom', name: 'Custom map', group: 'Custom', needs: 'customTileUrl',
      url: (s) => s.customTileUrl,
      opts: { maxNativeZoom: 19 } },
  ];

  // Road and place names drawn on top of the free satellite pictures.
  const LABELS = [
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  ];

  function find(id) { return STYLES.find((st) => st.id === id); }

  function usable(style, settings) {
    return !!style && (!style.needs || String(settings[style.needs] || '').trim() !== '');
  }

  // Styles that can be used with these settings (keys filled in).
  function available(settings) {
    return STYLES.filter((st) => usable(st, settings));
  }

  // Display name (the custom style uses the name chosen in settings).
  function label(style, settings) {
    return style.id === 'custom' ? (settings.customTileName || 'Custom map') : style.name;
  }

  // Build a Leaflet layer for a style. Returns null if it can't be used.
  function build(id, settings) {
    const style = find(id);
    if (!usable(style, settings)) return null;
    const url = typeof style.url === 'function' ? style.url(settings) : style.url;
    const opts = { maxZoom: 22, ...style.opts };
    if (style.id === 'custom') opts.attribution = esc(settings.customAttribution);
    const base = L.tileLayer(url, opts);
    if (style.id === 'esri-satellite' && settings.satelliteLabels) {
      return L.layerGroup([base, ...LABELS.map((u) => L.tileLayer(u, { maxZoom: 22, maxNativeZoom: 19 }))]);
    }
    return base;
  }

  return { STYLES, find, available, label, build };
})();
