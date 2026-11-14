'use strict';
/*
  Map styles ("tile layers"). A web map is made of many small square
  pictures called tiles; each style below says where to download them.

  Some need a key (a password-like code you get free from the map company):
    CARTO    -> https://carto.com/basemaps/apikey  (free; CARTO started requiring
                keys in late 2026; without one its tiles say "API KEY REQUIRED")
    Mapbox   -> https://account.mapbox.com/access-tokens/  (an "access token", starts with pk.)
    MapTiler -> https://cloud.maptiler.com/account/keys/    (an "API key")
    Azure Maps (Microsoft's replacement for Bing Maps) -> Azure portal,
      create an "Azure Maps Account", then Settings > Authentication > Primary Key
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
    // The OpenStreetMap street map, darkened in the browser by a colour
    // filter (see .tiles-dark in style.css). Needs no key.
    { id: 'osm-dark', name: 'Dark', group: 'Free',
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      opts: { maxNativeZoom: 19, className: 'tiles-dark', attribution: OSM } },
    { id: 'osm', name: 'Street map (OpenStreetMap)', group: 'Free',
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      opts: { maxNativeZoom: 19, attribution: OSM } },
    { id: 'esri-satellite', name: 'Satellite (Esri)', group: 'Free', satellite: true,
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      opts: { maxNativeZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' } },

    { id: 'carto-dark', name: 'CARTO Dark Matter', group: 'CARTO', needs: 'cartoKey',
      url: (s) => `https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png?key=${encodeURIComponent(s.cartoKey)}`,
      opts: { maxNativeZoom: 20, attribution: OSM + ' &copy; <a href="https://carto.com/attributions">CARTO</a>' } },
    { id: 'carto-light', name: 'CARTO Positron (light)', group: 'CARTO', needs: 'cartoKey',
      url: (s) => `https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png?key=${encodeURIComponent(s.cartoKey)}`,
      opts: { maxNativeZoom: 20, attribution: OSM + ' &copy; <a href="https://carto.com/attributions">CARTO</a>' } },

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

    // Azure Maps "Render - Get Map Tile" (api-version 2024-04-01), 256-pixel tiles.
    { id: 'azure-road', name: 'Azure Maps road', group: 'Azure Maps', needs: 'azureMapsKey',
      azure: 'microsoft.base.road', opts: { maxNativeZoom: 22 } },
    { id: 'azure-dark', name: 'Azure Maps dark grey', group: 'Azure Maps', needs: 'azureMapsKey',
      azure: 'microsoft.base.darkgrey', opts: { maxNativeZoom: 22 } },
    { id: 'azure-satellite', name: 'Azure Maps satellite', group: 'Azure Maps', needs: 'azureMapsKey',
      azure: 'microsoft.imagery', satellite: true, opts: { maxNativeZoom: 19 } },
    { id: 'azure-hybrid', name: 'Azure Maps satellite + roads', group: 'Azure Maps', needs: 'azureMapsKey',
      azure: 'microsoft.imagery', overlay: 'microsoft.base.hybrid.road', opts: { maxNativeZoom: 19 } },

    { id: 'custom', name: 'Custom map', group: 'Custom', needs: 'customTileUrl',
      url: (s) => s.customTileUrl,
      opts: { maxNativeZoom: 19 } },
  ];

  // Road and place names drawn on top of the free satellite pictures.
  const LABELS = [
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  ];

  const AZURE = 'https://atlas.microsoft.com/map';
  const azureTileUrl = (tilesetId, key) =>
    `${AZURE}/tile?api-version=2024-04-01&tilesetId=${tilesetId}&zoom={z}&x={x}&y={y}&tileSize=256&subscription-key=${encodeURIComponent(key)}`;

  // Azure Maps' terms say the map must show the copyright credit for the
  // area on screen. Azure has an address that returns it ("Get Map
  // Attribution"); ask it again whenever the map stops moving.
  function azureCredits(layer, tilesetId, key, maxZoom) {
    let map = null, shown = '', timer = null;
    const show = (text) => {
      const ctrl = map?.attributionControl;
      if (!ctrl) return;
      if (shown) ctrl.removeAttribution(shown);
      shown = text;
      if (shown) ctrl.addAttribution(shown);
    };
    const update = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (!map) return;
        const b = map.getBounds();
        const clampLon = (v) => Math.max(-180, Math.min(180, v)).toFixed(5);
        const clampLat = (v) => Math.max(-85, Math.min(85, v)).toFixed(5);
        const bounds = [clampLon(b.getWest()), clampLat(b.getSouth()), clampLon(b.getEast()), clampLat(b.getNorth())].join(',');
        const zoom = Math.max(0, Math.min(maxZoom, Math.round(map.getZoom())));
        try {
          const res = await fetch(`${AZURE}/attribution?api-version=2024-04-01&tilesetId=${tilesetId}` +
            `&zoom=${zoom}&bounds=${bounds}&subscription-key=${encodeURIComponent(key)}`);
          if (!res.ok || !map) return;
          const data = await res.json();
          show((data.copyrights || []).map(esc).join(', '));
        } catch { /* keep the old credit line */ }
      }, 800);   // wait until the map has stopped moving
    };
    layer.on('add', () => { map = layer._map; map.on('moveend', update); update(); });
    layer.on('remove', () => { clearTimeout(timer); if (map) { map.off('moveend', update); show(''); } map = null; });
  }

  function buildAzure(style, settings) {
    const key = settings.azureMapsKey;
    const opts = { maxZoom: 22, ...style.opts, attribution: '&copy; Microsoft Azure Maps' };
    const base = L.tileLayer(azureTileUrl(style.azure, key), opts);
    const layer = style.overlay
      ? L.layerGroup([base, L.tileLayer(azureTileUrl(style.overlay, key), { maxZoom: 22, maxNativeZoom: 22 })])
      : base;
    azureCredits(layer, style.azure, key, style.opts.maxNativeZoom);
    return layer;
  }

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
    if (style.azure) return buildAzure(style, settings);
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
