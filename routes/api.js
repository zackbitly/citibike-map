const express = require('express');
const axios = require('axios');
const { getDB, getCollectionStats } = require('../db');

const router = express.Router();

const GBFS_STATUS_URL = 'https://gbfs.citibikenyc.com/gbfs/en/station_status.json';

// Cache live GBFS data for 30 seconds
let liveCache = null;
let liveCacheTime = 0;

async function getLiveStatus() {
  const now = Date.now();
  if (liveCache && now - liveCacheTime < 30000) return liveCache;
  try {
    const { data } = await axios.get(GBFS_STATUS_URL, { timeout: 10000 });
    const map = {};
    for (const s of data.data.stations) {
      map[s.station_id] = {
        num_bikes_available: s.num_bikes_available || 0,
        num_docks_available: s.num_docks_available || 0,
        num_ebikes_available: s.num_ebikes_available || 0,
        is_installed: s.is_installed ? 1 : 0,
        is_renting: s.is_renting ? 1 : 0,
        last_reported: s.last_reported || 0,
      };
    }
    liveCache = map;
    liveCacheTime = now;
    return map;
  } catch (err) {
    console.error('Failed to fetch live status:', err.message);
    return liveCache || {};
  }
}

// GET /api/stations - all stations with live status + optional historical
// Query: ?day=1&hour=14 (for historical view)
router.get('/stations', async (req, res) => {
  try {
    const db = getDB();
    const { day, hour } = req.query;
    const useHistorical = day !== undefined && hour !== undefined;

    // Get all station metadata
    const stations = db.prepare('SELECT * FROM stations ORDER BY name').all();

    if (stations.length === 0) {
      return res.json({ stations: [], dataSource: 'none', message: 'No stations loaded yet' });
    }

    // Get live status
    const liveStatus = await getLiveStatus();

    // If historical, get averages for the day/hour
    let averages = {};
    let sampleCount = 0;
    if (useHistorical) {
      const d = parseInt(day, 10);
      const h = parseInt(hour, 10);
      const rows = db.prepare(`
        SELECT station_id, avg_bikes_available, avg_docks_available, sample_count
        FROM hourly_averages
        WHERE day_of_week = ? AND hour_of_day = ?
      `).all(d, h);

      for (const row of rows) {
        averages[row.station_id] = {
          avg_bikes: Math.round(row.avg_bikes_available * 10) / 10,
          avg_docks: Math.round(row.avg_docks_available * 10) / 10,
          sample_count: row.sample_count,
        };
        sampleCount = Math.max(sampleCount, row.sample_count);
      }
    }

    const result = stations.map((s) => {
      const live = liveStatus[s.station_id] || {};
      const hist = averages[s.station_id];
      const capacity = s.capacity || (live.num_bikes_available || 0) + (live.num_docks_available || 0) || 1;

      const bikes = useHistorical && hist
        ? hist.avg_bikes
        : (live.num_bikes_available ?? null);

      const docks = useHistorical && hist
        ? hist.avg_docks
        : (live.num_docks_available ?? null);

      const pct = bikes !== null && capacity > 0
        ? Math.round((bikes / capacity) * 100)
        : null;

      return {
        id: s.station_id,
        name: s.name,
        lat: s.lat,
        lng: s.lng,
        capacity,
        bikes_available: bikes,
        docks_available: docks,
        ebikes_available: live.num_ebikes_available || 0,
        availability_pct: pct,
        is_renting: live.is_renting ?? 1,
        is_installed: live.is_installed ?? 1,
        has_history: useHistorical ? !!hist : null,
        sample_count: hist?.sample_count ?? 0,
        // Always include live for comparison
        live_bikes: live.num_bikes_available ?? null,
        live_docks: live.num_docks_available ?? null,
      };
    });

    res.json({
      stations: result,
      dataSource: useHistorical ? 'historical' : 'live',
      day: useHistorical ? parseInt(day, 10) : null,
      hour: useHistorical ? parseInt(hour, 10) : null,
      maxSampleCount: sampleCount,
      liveUpdatedAt: liveCacheTime,
    });
  } catch (err) {
    console.error('/api/stations error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/station/:id - single station detail
router.get('/station/:id', async (req, res) => {
  try {
    const db = getDB();
    const { id } = req.params;

    const station = db.prepare('SELECT * FROM stations WHERE station_id = ?').get(id);
    if (!station) return res.status(404).json({ error: 'Station not found' });

    const liveStatus = await getLiveStatus();
    const live = liveStatus[id] || {};

    // Get full weekly pattern for this station
    const history = db.prepare(`
      SELECT day_of_week, hour_of_day, avg_bikes_available, avg_docks_available, sample_count
      FROM hourly_averages
      WHERE station_id = ?
      ORDER BY day_of_week, hour_of_day
    `).all(id);

    const capacity = station.capacity || 1;

    res.json({
      id: station.station_id,
      name: station.name,
      lat: station.lat,
      lng: station.lng,
      capacity,
      live: {
        bikes_available: live.num_bikes_available ?? null,
        docks_available: live.num_docks_available ?? null,
        ebikes_available: live.num_ebikes_available ?? 0,
        is_renting: live.is_renting ?? null,
        last_reported: live.last_reported ?? null,
      },
      history,
    });
  } catch (err) {
    console.error('/api/station/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/status - data collection status
router.get('/status', (req, res) => {
  try {
    const db = getDB();
    const stats = getCollectionStats();
    const stationCount = db.prepare('SELECT COUNT(*) as cnt FROM stations').get().cnt;
    const avgRows = db.prepare('SELECT COUNT(*) as cnt FROM hourly_averages WHERE sample_count > 0').get().cnt;

    res.json({
      stations: stationCount,
      snapshotCount: stats.total,
      oldestSnapshot: stats.oldest ? new Date(stats.oldest * 1000).toISOString() : null,
      newestSnapshot: stats.newest ? new Date(stats.newest * 1000).toISOString() : null,
      avgRowsComputed: avgRows,
      avgSampleCount: stats.avgSampleCount ? Math.round(stats.avgSampleCount) : 0,
      dataReady: stats.total > 100,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
