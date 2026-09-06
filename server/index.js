// RxMD server bootstrap. Owns the files on the clinic PC: loads config, opens the
// catalog, serves the built SPA + API over the LAN, watches the inbox folders, and
// reconciles the catalog against disk on startup.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadConfig, ensureDirs } from './config.js';
import { initDb, flush } from './db.js';
import { makeRouter } from './routes.js';
import { startWatchers, stopWatchers, reconcile } from './watcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

function lanAddresses(port) {
  const nets = os.networkInterfaces();
  const urls = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) urls.push(`http://${net.address}:${port}`);
    }
  }
  return urls;
}

async function main() {
  const cfg = loadConfig();
  ensureDirs(cfg);
  initDb();

  const app = express();
  app.disable('x-powered-by');
  app.use(makeRouter());

  // Serve the built client. In dev the client is served by Vite (npm run dev)
  // which proxies /api here, so a missing dist/ is only a warning.
  if (fs.existsSync(DIST)) {
    app.use(express.static(DIST));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(DIST, 'index.html'));
    });
  } else {
    console.warn('[server] dist/ not found — run "npm run build". API is up; use "npm run dev" for the client in development.');
  }

  const server = app.listen(cfg.port, cfg.host, () => {
    console.log(`\n  RxMD server running`);
    console.log(`  Local:   http://localhost:${cfg.port}`);
    for (const u of lanAddresses(cfg.port)) console.log(`  Network: ${u}`);
    if (!cfg.passwordHash) console.log(`\n  ⚠ No password set — run "npm run set-password" to lock it down.`);
    console.log('');
  });

  // Start watching first (ignores existing files), then reconcile existing
  // library + inbox contents in the background.
  startWatchers();
  reconcile().catch((e) => console.error('[reconcile] failed:', e.message));

  const shutdown = async () => {
    console.log('\n[server] shutting down…');
    stopWatchers();
    await flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { console.error('[server] fatal:', e); process.exit(1); });
