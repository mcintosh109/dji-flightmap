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
      create an "Azure Maps Account", then Settings > Authentication > Primary Key.
      The Azure key stays on the server: the map asks OUR server for Azure
      pictures (tiles/azure/...), and the server asks Azure with the key.
    Google Maps -> Google Cloud console: turn on the "Map Tiles API" and make
      an API key. Same idea as Azure: pictures come through OUR server
      (tiles/google/...), so the key stays there. Google's rules: the Google
      logo and Google's credit text must be shown, and pictures are not
      stored on the server.
  Used by both index.html (the map) and settings.html (the preview).

  How it fits together:
    STYLES     every map the page can draw (one per provider + kind of map)
    PROVIDERS  which style each provider uses for Road / Satellite / Dark / Terrain
    resolve()  picks the style for the chosen provider + layer, falling back
               to the free one when a provider doesn't offer that layer
*/
window.MapStyles = (() => {
  const OSM = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const MAPBOX = '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> ' + OSM;
  const MAPTILER = '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> ' + OSM;

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
    { id: 'opentopo', name: 'Terrain (OpenTopoMap)', group: 'Free',
      url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      opts: { subdomains: 'abc', maxNativeZoom: 17,
        attribution: OSM + ', SRTM | style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)' } },

    { id: 'carto-dark', name: 'CARTO Dark Matter', group: 'CARTO', needs: 'cartoKey',
      url: (s) => `https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png?key=${encodeURIComponent(s.cartoKey)}`,
      opts: { maxNativeZoom: 20, attribution: OSM + ' &copy; <a href="https://carto.com/attributions">CARTO</a>' } },
    { id: 'carto-light', name: 'CARTO Positron (light)', group: 'CARTO', needs: 'cartoKey',
      url: (s) => `https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png?key=${encodeURIComponent(s.cartoKey)}`,
      opts: { maxNativeZoom: 20, attribution: OSM + ' &copy; <a href="https://carto.com/attributions">CARTO</a>' } },

    { id: 'mapbox-streets', name: 'Mapbox streets', group: 'Mapbox', needs: 'mapboxToken',
      url: (s) => `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/256/{z}/{x}/{y}@2x?access_token=${encodeURIComponent(s.mapboxToken)}`,
      opts: { maxNativeZoom: 22, attribution: MAPBOX } },
    { id: 'mapbox-satellite', name: 'Mapbox satellite', group: 'Mapbox', needs: 'mapboxToken', detailed: 'mapbox-satellite-streets',
      url: (s) => `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/256/{z}/{x}/{y}@2x?access_token=${encodeURIComponent(s.mapboxToken)}`,
      opts: { maxNativeZoom: 22, attribution: MAPBOX } },
    { id: 'mapbox-satellite-streets', name: 'Mapbox satellite + streets', group: 'Mapbox', needs: 'mapboxToken',
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
    { id: 'maptiler-satellite', name: 'MapTiler satellite', group: 'MapTiler', needs: 'maptilerKey', satellite: true, detailed: 'maptiler-hybrid',
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
      azure: 'microsoft.imagery', satellite: true, detailed: 'azure-hybrid', opts: { maxNativeZoom: 19 } },
    { id: 'azure-hybrid', name: 'Azure Maps satellite + roads', group: 'Azure Maps', needs: 'azureMapsKey',
      azure: 'microsoft.imagery', overlay: 'microsoft.base.hybrid.road', opts: { maxNativeZoom: 19 } },

    // Google Map Tiles API, 2D tiles (see app/flightmap/google.py). maxNativeZoom
    // is lowered automatically where Google has no closer pictures.
    { id: 'google-road', name: 'Google Maps road', group: 'Google Maps', needs: 'googleMapsKey',
      google: 'roadmap', opts: { maxNativeZoom: 22 } },
    { id: 'google-dark', name: 'Google Maps dark', group: 'Google Maps', needs: 'googleMapsKey',
      google: 'dark', opts: { maxNativeZoom: 22 } },
    { id: 'google-satellite', name: 'Google Maps satellite', group: 'Google Maps', needs: 'googleMapsKey',
      google: 'satellite', satellite: true, detailed: 'google-hybrid', opts: { maxNativeZoom: 21 } },
    { id: 'google-hybrid', name: 'Google Maps satellite + roads', group: 'Google Maps', needs: 'googleMapsKey',
      google: 'hybrid', opts: { maxNativeZoom: 21 } },
    { id: 'google-terrain', name: 'Google Maps terrain', group: 'Google Maps', needs: 'googleMapsKey',
      google: 'terrain', opts: { maxNativeZoom: 20 } },

    { id: 'custom', name: 'Custom map', group: 'Custom', needs: 'customTileUrl',
      url: (s) => s.customTileUrl,
      opts: { maxNativeZoom: 19 } },
  ];

  // ---- Providers: who draws the map. Each lists its style for each layer.
  // A layer a provider doesn't have uses the free style instead.
  const LAYERS = [
    { id: 'road', name: 'Road' },
    { id: 'satellite', name: 'Satellite' },
    { id: 'dark', name: 'Dark' },
    { id: 'terrain', name: 'Terrain' },
  ];
  const PROVIDERS = {
    free:     { name: 'Free (OpenStreetMap + Esri)', needs: null,
                layers: { road: 'osm', satellite: 'esri-satellite', dark: 'osm-dark', terrain: 'opentopo' } },
    carto:    { name: 'CARTO', needs: 'cartoKey',
                layers: { road: 'carto-light', dark: 'carto-dark' } },
    azure:    { name: 'Azure Maps', needs: 'azureMapsKey',
                layers: { road: 'azure-road', satellite: 'azure-satellite', dark: 'azure-dark' } },
    google:   { name: 'Google Maps', needs: 'googleMapsKey',
                layers: { road: 'google-road', satellite: 'google-satellite', dark: 'google-dark', terrain: 'google-terrain' } },
    mapbox:   { name: 'Mapbox', needs: 'mapboxToken',
                layers: { road: 'mapbox-streets', satellite: 'mapbox-satellite', dark: 'mapbox-dark', terrain: 'mapbox-outdoors' } },
    maptiler: { name: 'MapTiler', needs: 'maptilerKey',
                layers: { road: 'maptiler-streets', satellite: 'maptiler-satellite', terrain: 'maptiler-outdoor' } },
    custom:   { name: 'Custom map address', needs: 'customTileUrl',
                layers: { road: 'custom' } },
  };

  // A key counts as present if it's typed in, or saved on the server ("<key>Set").
  const hasValue = (settings, key) => !key || String(settings[key] || '').trim() !== '' || settings[`${key}Set`] === true;

  // Which style to draw for this provider + layer (+ "Details").
  //   id        the style to build
  //   fallback  true when the provider doesn't have this layer (free one used)
  //   noKey     true when the chosen provider's key is missing (free one used)
  function resolve(settings, layer, details) {
    const chosen = PROVIDERS[settings.mapProvider] || PROVIDERS.free;
    const ready = hasValue(settings, chosen.needs);
    const provider = ready ? chosen : PROVIDERS.free;
    let id = provider.layers[layer];
    const fallback = !id && provider !== PROVIDERS.free;
    if (!id) id = PROVIDERS.free.layers[layer] || PROVIDERS.free.layers.road;
    const style = find(id);
    if (details && style?.detailed) id = style.detailed;
    return { id, fallback, noKey: !ready };
  }

  // A small picture of one map tile around (lat, lon), for the layer buttons.
  function thumbUrl(id, settings, lat, lon, zoom = 14) {
    const style = find(id);
    if (!usable(style, settings)) return '';
    const n = 2 ** zoom;
    const x = Math.floor(((lon + 180) / 360) * n);
    const rad = (lat * Math.PI) / 180;
    const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
    const template = style.azure ? azureUrl(style.azure, settings)
      : style.google ? googleUrl(style.google)
        : (typeof style.url === 'function' ? style.url(settings) : style.url);
    const sub = (style.opts.subdomains || 'a')[0];
    return template.replace('{s}', sub).replace('{r}', '').replace('{z}', zoom).replace('{x}', x).replace('{y}', y);
  }

  // Road and place names drawn on top of the free satellite pictures.
  const LABELS = [
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  ];

  const AZURE = 'https://atlas.microsoft.com/map';
  const azureTileUrl = (tilesetId, key) =>
    `${AZURE}/tile?api-version=2024-04-01&tilesetId=${tilesetId}&zoom={z}&x={x}&y={y}&tileSize=256&subscription-key=${encodeURIComponent(key)}`;
  // Normally: through our server, which adds the saved key. Only a key typed
  // into the settings page (not saved yet) is used directly, for its preview.
  const azureUrl = (tilesetId, settings) => (String(settings.azureMapsKey || '').trim()
    ? azureTileUrl(tilesetId, settings.azureMapsKey.trim())
    : `tiles/azure/${tilesetId}/{z}/{x}/{y}.png`);

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
          const res = await fetch(key
            ? `${AZURE}/attribution?api-version=2024-04-01&tilesetId=${tilesetId}&zoom=${zoom}&bounds=${bounds}&subscription-key=${encodeURIComponent(key)}`
            : `api/azure-credits?tileset=${tilesetId}&zoom=${zoom}&bounds=${bounds}`);
          if (!res.ok || !map) return;
          const data = await res.json();
          // Azure sends each credit as a small piece of HTML, e.g.
          // <a data-azure-...>&copy;2026 TomTom</a>. Keep only the readable
          // text (DOMParser reads it without running or loading anything).
          const toText = (html) => {
            const doc = new DOMParser().parseFromString(String(html), 'text/html');
            doc.querySelectorAll('script, style').forEach((el) => el.remove());
            return doc.body.textContent.replace(/\s+/g, ' ').trim();
          };
          const credits = [...new Set((data.copyrights || []).map(toText).filter(Boolean))];
          show(credits.map(esc).join(', '));
        } catch { /* keep the old credit line */ }
      }, 800);   // wait until the map has stopped moving
    };
    layer.on('add', () => { map = layer._map; map.on('moveend', update); update(); });
    layer.on('remove', () => { clearTimeout(timer); if (map) { map.off('moveend', update); show(''); } map = null; });
  }

  function buildAzure(style, settings) {
    const key = String(settings.azureMapsKey || '').trim();   // only set while typing a new key in Settings
    const opts = { maxZoom: 22, ...style.opts, attribution: '&copy; Microsoft Azure Maps' };
    const base = L.tileLayer(azureUrl(style.azure, settings), opts);
    const layer = style.overlay
      ? L.layerGroup([base, L.tileLayer(azureUrl(style.overlay, settings), { maxZoom: 22, maxNativeZoom: 22 })])
      : base;
    azureCredits(layer, style.azure, key, style.opts.maxNativeZoom);
    return layer;
  }

  // ---- Google Maps ----
  // Always through our server, which adds the saved key and a session.
  const googleUrl = (set) => `tiles/google/${set}/{z}/{x}/{y}.png`;

  // Google's rules: show the Google logo, and Google's credit text for the
  // area on screen (asked again whenever the map stops moving). The logo
  // sits just above the credit line, bottom right.
  const GoogleLogo = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd() {
      const box = L.DomUtil.create('div', 'google-logo');
      const img = L.DomUtil.create('img', '', box);
      img.alt = 'Google';
      img.src = 'https://maps.gstatic.com/mapfiles/api-3/images/google_white5_hdpi.png';
      // If Google's logo picture can't be loaded, write "Google Maps" instead.
      img.addEventListener('error', () => { box.textContent = 'Google Maps'; box.classList.add('text'); });
      return box;
    },
  });

  function googleCredits(layer, set) {
    let map = null, shown = '', timer = null, logo = null;
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
        const lon = (v) => Math.max(-180, Math.min(180, v)).toFixed(5);
        const lat = (v) => Math.max(-85, Math.min(85, v)).toFixed(5);
        const bounds = [lon(b.getWest()), lat(b.getSouth()), lon(b.getEast()), lat(b.getNorth())].join(',');
        const zoom = Math.max(0, Math.min(22, Math.round(map.getZoom())));
        try {
          const res = await fetch(`api/google-credits?set=${set}&zoom=${zoom}&bounds=${bounds}`);
          if (!res.ok || !map) return;
          const data = await res.json();
          show(esc(data.copyright || 'Map data ©Google'));
          // Where Google has no closer pictures, enlarge the closest ones
          // instead of showing grey squares.
          if (Number.isInteger(data.maxZoom)) {
            const native = Math.min(data.maxZoom, layer.options.googleMaxZoom);
            if (native !== layer.options.maxNativeZoom) { layer.options.maxNativeZoom = native; layer.redraw(); }
          }
        } catch { /* keep the old credit line */ }
      }, 800);   // wait until the map has stopped moving
    };
    layer.on('add', () => {
      map = layer._map;
      logo = new GoogleLogo().addTo(map);
      map.on('moveend', update);
      update();
    });
    layer.on('remove', () => {
      clearTimeout(timer);
      if (map) { map.off('moveend', update); show(''); logo?.remove(); }
      map = null; logo = null;
    });
  }

  function buildGoogle(style) {
    const layer = L.tileLayer(googleUrl(style.google),
      { maxZoom: 22, ...style.opts, googleMaxZoom: style.opts.maxNativeZoom });
    googleCredits(layer, style.google);
    return layer;
  }

  function find(id) { return STYLES.find((st) => st.id === id); }

  function usable(style, settings) {
    return !!style && hasValue(settings, style.needs);
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
  // options.details: draw road/place names on the free satellite map.
  function build(id, settings, options = {}) {
    const style = find(id);
    if (!usable(style, settings)) return null;
    if (style.azure) return buildAzure(style, settings);
    if (style.google) return buildGoogle(style);
    const url = typeof style.url === 'function' ? style.url(settings) : style.url;
    const opts = { maxZoom: 22, ...style.opts };
    if (style.id === 'custom') opts.attribution = esc(settings.customAttribution);
    const base = L.tileLayer(url, opts);
    const details = options.details ?? settings.satelliteLabels;
    if (style.id === 'esri-satellite' && details) {
      return L.layerGroup([base, ...LABELS.map((u) => L.tileLayer(u, { maxZoom: 22, maxNativeZoom: 19 }))]);
    }
    return base;
  }

  return { STYLES, LAYERS, PROVIDERS, find, available, label, build, resolve, thumbUrl };
})();
