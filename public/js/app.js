/* ── Citibike Map App ── */

const API_BASE = '';

// State
const state = {
  mode: 'live',         // 'live' | 'historical'
  day: new Date().getDay(),
  hour: new Date().getHours(),
  stations: [],
  selectedId: null,
  markers: {},
  map: null,
  dataStatus: { snapshotCount: 0, dataReady: false },
  liveTimer: null,
};

// ── Color helpers ──────────────────────────────────────────
function pctToColor(pct) {
  if (pct === null || pct === undefined) return '#475569';
  if (pct <= 0) return '#EF4444';
  if (pct < 15) return '#F97316';
  if (pct < 35) return '#EAB308';
  if (pct < 65) return '#84CC16';
  return '#22C55E';
}

function formatHour(h) {
  if (h === 0) return '12:00 AM';
  if (h < 12) return `${h}:00 AM`;
  if (h === 12) return '12:00 PM';
  return `${h - 12}:00 PM`;
}

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const DAY_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// ── Map setup ─────────────────────────────────────────────
function initMap() {
  const map = L.map('map', {
    center: [40.73, -73.99],
    zoom: 13,
    zoomControl: true,
    renderer: L.canvas({ padding: 0.5 }),
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_matter/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO | Data: Citibike GBFS',
    maxZoom: 19,
    subdomains: 'abcd',
  }).addTo(map);

  // Close station panel on map click
  map.on('click', () => {
    if (state.selectedId) deselectStation();
  });

  state.map = map;
  return map;
}

// ── Marker management ────────────────────────────────────
function getMarkerRadius(zoom) {
  if (zoom >= 16) return 9;
  if (zoom >= 14) return 7;
  if (zoom >= 12) return 5;
  return 4;
}

function renderMarkers(stations) {
  const map = state.map;
  const zoom = map.getZoom();
  const r = getMarkerRadius(zoom);

  // Remove markers for stations no longer in list
  const newIds = new Set(stations.map(s => s.id));
  for (const id of Object.keys(state.markers)) {
    if (!newIds.has(id)) {
      state.markers[id].remove();
      delete state.markers[id];
    }
  }

  for (const s of stations) {
    const color = (s.is_renting === 0 || s.is_installed === 0)
      ? '#475569'
      : pctToColor(s.availability_pct);

    const isSelected = s.id === state.selectedId;

    if (state.markers[s.id]) {
      // Update existing marker
      state.markers[s.id].setStyle({
        fillColor: color,
        color: isSelected ? 'white' : 'rgba(255,255,255,0.3)',
        fillOpacity: isSelected ? 1 : 0.85,
        weight: isSelected ? 2.5 : 1,
        radius: isSelected ? r + 3 : r,
      });
    } else {
      // Create new marker
      const marker = L.circleMarker([s.lat, s.lng], {
        radius: isSelected ? r + 3 : r,
        fillColor: color,
        color: isSelected ? 'white' : 'rgba(255,255,255,0.3)',
        weight: isSelected ? 2.5 : 1,
        fillOpacity: isSelected ? 1 : 0.85,
      });

      const bikesLabel = s.bikes_available !== null
        ? `${Math.round(s.bikes_available)} bike${Math.round(s.bikes_available) !== 1 ? 's' : ''}`
        : 'No data';

      marker.bindTooltip(`
        <div class="tooltip-name">${s.name}</div>
        <div class="tooltip-bikes">${bikesLabel} available${state.mode === 'historical' ? ' (avg)' : ''}</div>
      `, { permanent: false, direction: 'top', offset: [0, -4] });

      marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        selectStation(s.id);
      });

      marker.addTo(map);
      state.markers[s.id] = marker;
    }
  }

  // Resize on zoom
  map.off('zoomend');
  map.on('zoomend', () => {
    const z = map.getZoom();
    const nr = getMarkerRadius(z);
    for (const s of stations) {
      const m = state.markers[s.id];
      if (!m) continue;
      m.setRadius(s.id === state.selectedId ? nr + 3 : nr);
    }
  });
}

// ── Data fetching ─────────────────────────────────────────
async function fetchStations() {
  let url = `${API_BASE}/api/stations`;
  if (state.mode === 'historical') {
    url += `?day=${state.day}&hour=${state.hour}`;
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchStationDetail(id) {
  const res = await fetch(`${API_BASE}/api/station/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchStatus() {
  const res = await fetch(`${API_BASE}/api/status`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Load and render stations ──────────────────────────────
async function loadStations() {
  try {
    const data = await fetchStations();
    state.stations = data.stations;

    renderMarkers(data.stations);

    // Update count badge
    const badge = document.getElementById('station-count-badge');
    badge.textContent = `${data.stations.length} stations`;
    badge.classList.remove('hidden');

    // Data quality warning
    if (state.mode === 'historical') {
      const quality = document.getElementById('data-quality');
      const msg = document.getElementById('data-quality-msg');

      if (data.maxSampleCount === 0) {
        quality.classList.remove('hidden');
        msg.textContent = 'Collecting data — historical averages will appear after a few snapshots.';
      } else if (data.maxSampleCount < 10) {
        quality.classList.remove('hidden');
        msg.textContent = `Only ${data.maxSampleCount} snapshots so far. Averages improve over time.`;
      } else {
        quality.classList.add('hidden');
      }
    }

    // Update status
    updateStatusBar(data);

    // If a station was selected, refresh its panel
    if (state.selectedId) {
      const updated = state.stations.find(s => s.id === state.selectedId);
      if (updated) updateStationPanel(updated);
    }

    return data;
  } catch (err) {
    console.error('loadStations error:', err);
    setStatusError(err.message);
    throw err;
  }
}

function updateStatusBar(data) {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');

  if (data.dataSource === 'live') {
    dot.className = 'status-dot live';
    const t = new Date(data.liveUpdatedAt);
    text.textContent = `Live · updated ${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } else {
    dot.className = 'status-dot live';
    const snap = state.dataStatus.snapshotCount;
    text.textContent = snap > 0
      ? `Historical avg · ${snap.toLocaleString()} snapshots`
      : 'Historical avg · collecting data...';
  }
}

function setStatusError(msg) {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  dot.className = 'status-dot error';
  text.textContent = `Error: ${msg}`;
}

// ── Station selection ─────────────────────────────────────
async function selectStation(id) {
  const prev = state.selectedId;
  state.selectedId = id;

  // Update marker styles
  if (prev && state.markers[prev]) {
    const s = state.stations.find(s => s.id === prev);
    const color = s ? pctToColor(s.availability_pct) : '#475569';
    const zoom = state.map.getZoom();
    const r = getMarkerRadius(zoom);
    state.markers[prev].setStyle({ color: 'rgba(255,255,255,0.3)', weight: 1, fillOpacity: 0.85 });
    state.markers[prev].setRadius(r);
  }
  if (state.markers[id]) {
    const zoom = state.map.getZoom();
    const r = getMarkerRadius(zoom);
    state.markers[id].setStyle({ color: 'white', weight: 2.5, fillOpacity: 1 });
    state.markers[id].setRadius(r + 3);
  }

  // Show panel with basic info while loading detail
  const basicStation = state.stations.find(s => s.id === id);
  if (basicStation) updateStationPanel(basicStation);

  // Load full detail (including hourly chart data)
  try {
    const detail = await fetchStationDetail(id);
    updateStationPanelFull(detail);
  } catch (err) {
    console.error('Failed to load station detail:', err);
  }
}

function deselectStation() {
  const prev = state.selectedId;
  state.selectedId = null;

  if (prev && state.markers[prev]) {
    const s = state.stations.find(s => s.id === prev);
    const color = s ? pctToColor(s.availability_pct) : '#475569';
    const zoom = state.map.getZoom();
    const r = getMarkerRadius(zoom);
    state.markers[prev].setStyle({ color: 'rgba(255,255,255,0.3)', weight: 1, fillOpacity: 0.85 });
    state.markers[prev].setRadius(r);
  }

  document.getElementById('station-panel').classList.add('hidden');
}

function updateStationPanel(s) {
  document.getElementById('station-panel').classList.remove('hidden');
  document.getElementById('station-name').textContent = s.name;
  document.getElementById('station-dot').style.background = pctToColor(s.availability_pct);
  document.getElementById('stat-bikes').textContent = s.bikes_available !== null ? Math.round(s.bikes_available) : '–';
  document.getElementById('stat-ebikes').textContent = s.ebikes_available !== null ? s.ebikes_available : '–';
  document.getElementById('stat-docks').textContent = s.docks_available !== null ? Math.round(s.docks_available) : '–';
  document.getElementById('stat-capacity').textContent = s.capacity || '–';
  document.getElementById('station-id-label').textContent = `Station ID: ${s.id}`;

  // Live vs avg comparison row
  const compRow = document.getElementById('comparison-row');
  if (state.mode === 'historical' && s.live_bikes !== null) {
    compRow.classList.remove('hidden');
    document.getElementById('comp-live').textContent = s.live_bikes;
    document.getElementById('comp-avg').textContent = s.bikes_available !== null ? Math.round(s.bikes_available) : '–';
  } else {
    compRow.classList.add('hidden');
  }
}

function updateStationPanelFull(detail) {
  // Update stats with full detail
  document.getElementById('stat-bikes').textContent =
    detail.live.bikes_available !== null ? detail.live.bikes_available : '–';
  document.getElementById('stat-ebikes').textContent = detail.live.ebikes_available || '–';
  document.getElementById('stat-docks').textContent =
    detail.live.docks_available !== null ? detail.live.docks_available : '–';
  document.getElementById('stat-capacity').textContent = detail.capacity || '–';

  // Draw hourly chart
  drawHourlyChart(detail);
}

// ── Hourly chart ──────────────────────────────────────────
function drawHourlyChart(detail) {
  const canvas = document.getElementById('hourly-chart');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth;
  const H = canvas.offsetHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);

  const dayToShow = state.mode === 'historical' ? state.day : new Date().getDay();
  const dayLabel = document.getElementById('chart-day-label');
  dayLabel.textContent = `${DAY_NAMES[dayToShow]} average pattern`;

  // Filter history for the selected day
  const hourData = detail.history.filter(r => r.day_of_week === dayToShow);
  const hourMap = {};
  for (const r of hourData) {
    hourMap[r.hour_of_day] = r.avg_bikes_available;
  }

  if (hourData.length === 0) {
    ctx.fillStyle = '#64748B';
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data collected yet for this day', W / 2, H / 2);
    return;
  }

  const maxBikes = detail.capacity || Math.max(...Object.values(hourMap), 1);
  const pad = { top: 8, right: 4, bottom: 16, left: 4 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top - pad.bottom;
  const barW = chartW / 24;

  ctx.clearRect(0, 0, W, H);

  // Draw bars
  for (let h = 0; h < 24; h++) {
    const val = hourMap[h] ?? 0;
    const pct = maxBikes > 0 ? val / maxBikes : 0;
    const barH = Math.max(2, pct * chartH);
    const x = pad.left + h * barW;
    const y = pad.top + chartH - barH;

    const isCurrentHour = h === (state.mode === 'historical' ? state.hour : new Date().getHours());

    ctx.fillStyle = isCurrentHour ? '#0066FF' : pctToColor(pct * 100);
    ctx.globalAlpha = isCurrentHour ? 1 : 0.75;
    ctx.beginPath();
    ctx.roundRect(x + 1, y, barW - 2, barH, [2, 2, 0, 0]);
    ctx.fill();
  }

  ctx.globalAlpha = 1;

  // Hour labels (0, 6, 12, 18)
  ctx.fillStyle = '#64748B';
  ctx.font = `${10 * (1 / dpr + dpr * 0.4)}px Inter, sans-serif`;
  ctx.font = '10px Inter, sans-serif';
  ctx.textAlign = 'center';
  for (const h of [0, 6, 12, 18]) {
    const x = pad.left + h * barW + barW / 2;
    const label = h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`;
    ctx.fillText(label, x, H - 2);
  }
}

// ── Search ────────────────────────────────────────────────
function initSearch() {
  const input = document.getElementById('search-input');
  const results = document.getElementById('search-results');
  const clearBtn = document.getElementById('search-clear');

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    clearBtn.classList.toggle('visible', q.length > 0);

    if (q.length < 2) {
      results.classList.remove('visible');
      results.innerHTML = '';
      return;
    }

    const matches = state.stations
      .filter(s => s.name.toLowerCase().includes(q))
      .slice(0, 8);

    results.innerHTML = matches.map(s => {
      const bikes = s.bikes_available !== null ? Math.round(s.bikes_available) : '?';
      const color = pctToColor(s.availability_pct);
      return `
        <div class="search-result-item" data-id="${s.id}">
          <span class="result-dot" style="background:${color}"></span>
          <span class="result-name">${s.name}</span>
          <span class="result-bikes">${bikes} bikes</span>
        </div>
      `;
    }).join('');

    results.classList.toggle('visible', matches.length > 0);
  });

  results.addEventListener('click', (e) => {
    const item = e.target.closest('.search-result-item');
    if (!item) return;
    const id = item.dataset.id;
    const station = state.stations.find(s => s.id === id);
    if (station) {
      state.map.flyTo([station.lat, station.lng], 16, { duration: 0.8 });
      selectStation(id);
    }
    results.classList.remove('visible');
    input.value = station ? station.name : '';
    clearBtn.classList.add('visible');
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    results.classList.remove('visible');
    results.innerHTML = '';
    clearBtn.classList.remove('visible');
    input.focus();
  });

  // Close results when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#search-wrapper')) {
      results.classList.remove('visible');
    }
  });
}

// ── Controls ──────────────────────────────────────────────
function initControls() {
  // Mode toggle
  document.getElementById('btn-live').addEventListener('click', () => setMode('live'));
  document.getElementById('btn-historical').addEventListener('click', () => setMode('historical'));

  // Day buttons
  document.querySelectorAll('.day-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.day-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.day = parseInt(btn.dataset.day, 10);
      loadStations();
    });
  });

  // Time slider
  const slider = document.getElementById('time-slider');
  const display = document.getElementById('time-display');

  slider.addEventListener('input', () => {
    state.hour = parseInt(slider.value, 10);
    display.textContent = formatHour(state.hour);
    updateSliderTrack(slider);
    debounceLoad();
  });

  // Refresh button
  document.getElementById('btn-refresh').addEventListener('click', async () => {
    const btn = document.getElementById('btn-refresh');
    btn.classList.add('spinning');
    try {
      await loadStations();
    } finally {
      btn.classList.remove('spinning');
    }
  });

  // Station close
  document.getElementById('station-close').addEventListener('click', deselectStation);
}

let loadTimer = null;
function debounceLoad() {
  clearTimeout(loadTimer);
  loadTimer = setTimeout(() => loadStations(), 300);
}

function updateSliderTrack(slider) {
  const pct = (slider.value / slider.max) * 100;
  slider.style.background = `linear-gradient(to right, var(--accent) 0%, var(--accent) ${pct}%, var(--border) ${pct}%)`;
}

function setMode(mode) {
  state.mode = mode;

  document.getElementById('btn-live').classList.toggle('active', mode === 'live');
  document.getElementById('btn-historical').classList.toggle('active', mode === 'historical');
  document.getElementById('historical-controls').classList.toggle('hidden', mode === 'live');
  document.getElementById('data-quality').classList.add('hidden');

  // Clear comparison row when switching to live
  if (mode === 'live') {
    document.getElementById('comparison-row').classList.add('hidden');
  }

  loadStations();

  // Start/stop auto-refresh
  if (mode === 'live') {
    startAutoRefresh();
  } else {
    stopAutoRefresh();
  }
}

// ── Auto refresh ──────────────────────────────────────────
function startAutoRefresh() {
  stopAutoRefresh();
  state.liveTimer = setInterval(() => {
    if (state.mode === 'live') loadStations();
  }, 60 * 1000); // every 60s
}

function stopAutoRefresh() {
  if (state.liveTimer) {
    clearInterval(state.liveTimer);
    state.liveTimer = null;
  }
}

// ── Init ──────────────────────────────────────────────────
async function init() {
  initMap();
  initSearch();
  initControls();

  // Set initial day/hour UI
  const now = new Date();
  state.day = now.getDay();
  state.hour = now.getHours();

  document.querySelectorAll('.day-btn').forEach(b => {
    if (parseInt(b.dataset.day, 10) === state.day) b.classList.add('active');
  });

  const slider = document.getElementById('time-slider');
  slider.value = state.hour;
  document.getElementById('time-display').textContent = formatHour(state.hour);
  updateSliderTrack(slider);

  // Load collection status
  try {
    const status = await fetchStatus();
    state.dataStatus = status;
    const snapInfo = document.getElementById('snapshot-info');
    if (status.snapshotCount > 0) {
      snapInfo.classList.remove('hidden');
      snapInfo.textContent = `${status.snapshotCount.toLocaleString()} snapshots collected`;
    }
  } catch (e) { /* ignore */ }

  // Load stations
  try {
    const loading = document.getElementById('map-loading');
    await loadStations();
    loading.classList.add('hidden');
    startAutoRefresh();
  } catch (err) {
    document.getElementById('map-loading').classList.add('hidden');
    console.error('Init failed:', err);
  }
}

// Start
document.addEventListener('DOMContentLoaded', init);
