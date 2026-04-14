const Database = require('better-sqlite3');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'citibike.db');

const GBFS_STATION_INFO = 'https://gbfs.citibikenyc.com/gbfs/en/station_information.json';
const GBFS_STATION_STATUS = 'https://gbfs.citibikenyc.com/gbfs/en/station_status.json';

let db;

function getDB() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

function initDB() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS stations (
      station_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      short_name TEXT,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      capacity INTEGER DEFAULT 0,
      region_id TEXT,
      last_updated INTEGER
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id TEXT NOT NULL,
      num_bikes_available INTEGER NOT NULL,
      num_docks_available INTEGER NOT NULL,
      num_ebikes_available INTEGER DEFAULT 0,
      is_installed INTEGER NOT NULL,
      is_renting INTEGER NOT NULL,
      captured_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_station_time
      ON snapshots(station_id, captured_at);

    CREATE INDEX IF NOT EXISTS idx_snapshots_time
      ON snapshots(captured_at);

    CREATE TABLE IF NOT EXISTS hourly_averages (
      station_id TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,
      hour_of_day INTEGER NOT NULL,
      avg_bikes_available REAL DEFAULT 0,
      avg_docks_available REAL DEFAULT 0,
      sample_count INTEGER DEFAULT 0,
      computed_at INTEGER,
      PRIMARY KEY (station_id, day_of_week, hour_of_day)
    );

    CREATE TABLE IF NOT EXISTS collection_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collected_at INTEGER NOT NULL,
      station_count INTEGER,
      success INTEGER DEFAULT 1,
      error_msg TEXT
    );
  `);

  console.log('Database initialized at', DB_PATH);
  return db;
}

async function refreshStationInfo() {
  try {
    const { data } = await axios.get(GBFS_STATION_INFO, { timeout: 15000 });
    const stations = data.data.stations;
    const now = Math.floor(Date.now() / 1000);

    const upsert = db.prepare(`
      INSERT INTO stations (station_id, name, short_name, lat, lng, capacity, region_id, last_updated)
      VALUES (@station_id, @name, @short_name, @lat, @lng, @capacity, @region_id, @last_updated)
      ON CONFLICT(station_id) DO UPDATE SET
        name = excluded.name,
        lat = excluded.lat,
        lng = excluded.lng,
        capacity = excluded.capacity,
        last_updated = excluded.last_updated
    `);

    const insertMany = db.transaction((stations) => {
      for (const s of stations) {
        upsert.run({
          station_id: s.station_id,
          name: s.name,
          short_name: s.short_name || null,
          lat: s.lat,
          lng: s.lon,
          capacity: s.capacity || 0,
          region_id: s.region_id || null,
          last_updated: now,
        });
      }
    });

    insertMany(stations);
    console.log(`Refreshed ${stations.length} station records`);
    return stations.length;
  } catch (err) {
    console.error('Failed to refresh station info:', err.message);
    return 0;
  }
}

async function collectSnapshot() {
  const now = Math.floor(Date.now() / 1000);
  try {
    const { data } = await axios.get(GBFS_STATION_STATUS, { timeout: 15000 });
    const statuses = data.data.stations;

    const insert = db.prepare(`
      INSERT INTO snapshots
        (station_id, num_bikes_available, num_docks_available, num_ebikes_available, is_installed, is_renting, captured_at)
      VALUES
        (@station_id, @num_bikes_available, @num_docks_available, @num_ebikes_available, @is_installed, @is_renting, @captured_at)
    `);

    const insertMany = db.transaction((statuses) => {
      for (const s of statuses) {
        insert.run({
          station_id: s.station_id,
          num_bikes_available: s.num_bikes_available || 0,
          num_docks_available: s.num_docks_available || 0,
          num_ebikes_available: s.num_ebikes_available || 0,
          is_installed: s.is_installed ? 1 : 0,
          is_renting: s.is_renting ? 1 : 0,
          captured_at: now,
        });
      }
    });

    insertMany(statuses);

    db.prepare(`
      INSERT INTO collection_log (collected_at, station_count, success)
      VALUES (?, ?, 1)
    `).run(now, statuses.length);

    console.log(`Snapshot collected: ${statuses.length} stations at ${new Date(now * 1000).toISOString()}`);

    // Prune snapshots older than 60 days
    const cutoff = now - 60 * 24 * 60 * 60;
    const deleted = db.prepare('DELETE FROM snapshots WHERE captured_at < ?').run(cutoff);
    if (deleted.changes > 0) {
      console.log(`Pruned ${deleted.changes} old snapshot rows`);
    }

    return statuses.length;
  } catch (err) {
    console.error('Snapshot collection failed:', err.message);
    db.prepare(`
      INSERT INTO collection_log (collected_at, station_count, success, error_msg)
      VALUES (?, 0, 0, ?)
    `).run(now, err.message);
    return 0;
  }
}

function recomputeAverages() {
  const now = Math.floor(Date.now() / 1000);
  console.log('Recomputing hourly averages...');

  // Use last 30 days of data
  const cutoff = now - 30 * 24 * 60 * 60;

  const rows = db.prepare(`
    SELECT
      station_id,
      CAST(strftime('%w', datetime(captured_at, 'unixepoch')) AS INTEGER) AS day_of_week,
      CAST(strftime('%H', datetime(captured_at, 'unixepoch')) AS INTEGER) AS hour_of_day,
      AVG(num_bikes_available) AS avg_bikes,
      AVG(num_docks_available) AS avg_docks,
      COUNT(*) AS sample_count
    FROM snapshots
    WHERE captured_at >= ?
    GROUP BY station_id, day_of_week, hour_of_day
  `).all(cutoff);

  const upsert = db.prepare(`
    INSERT INTO hourly_averages
      (station_id, day_of_week, hour_of_day, avg_bikes_available, avg_docks_available, sample_count, computed_at)
    VALUES
      (@station_id, @day_of_week, @hour_of_day, @avg_bikes, @avg_docks, @sample_count, @computed_at)
    ON CONFLICT(station_id, day_of_week, hour_of_day) DO UPDATE SET
      avg_bikes_available = excluded.avg_bikes_available,
      avg_docks_available = excluded.avg_docks_available,
      sample_count = excluded.sample_count,
      computed_at = excluded.computed_at
  `);

  const insertAll = db.transaction((rows) => {
    for (const row of rows) {
      upsert.run({ ...row, computed_at: now });
    }
  });

  insertAll(rows);
  console.log(`Recomputed ${rows.length} hourly average records`);
}

function getSnapshotCount() {
  return db.prepare('SELECT COUNT(*) as cnt FROM snapshots').get().cnt;
}

function getCollectionStats() {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM snapshots').get().cnt;
  const oldest = db.prepare('SELECT MIN(captured_at) as t FROM snapshots').get().t;
  const newest = db.prepare('SELECT MAX(captured_at) as t FROM snapshots').get().t;
  const avgCount = db.prepare(`
    SELECT AVG(sample_count) as avg FROM hourly_averages WHERE sample_count > 0
  `).get().avg;
  return { total, oldest, newest, avgSampleCount: avgCount };
}

module.exports = { initDB, getDB, refreshStationInfo, collectSnapshot, recomputeAverages, getSnapshotCount, getCollectionStats };
