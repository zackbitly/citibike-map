const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const { initDB, refreshStationInfo, collectSnapshot, recomputeAverages } = require('./db');
const apiRouter = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', apiRouter);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function main() {
  initDB();

  console.log('Loading station info...');
  await refreshStationInfo();

  console.log('Collecting first snapshot...');
  await collectSnapshot();

  // Compute initial averages
  recomputeAverages();

  // Collect snapshot every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    await collectSnapshot();
  });

  // Refresh station metadata daily at 3am
  cron.schedule('0 3 * * *', async () => {
    await refreshStationInfo();
  });

  // Recompute averages every 30 minutes
  cron.schedule('*/30 * * * *', () => {
    recomputeAverages();
  });

  app.listen(PORT, () => {
    console.log(`\nCitibike Map running → http://localhost:${PORT}\n`);
  });
}

main().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
