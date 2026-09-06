// Folder watching + reconcile. Replaces the browser's in-tab auto-scan timer:
// chokidar watches each category's inbox folder(s) on the clinic PC itself, so
// ingestion happens whether or not any browser is open.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import chokidar from 'chokidar';
import { loadConfig, CATEGORY_ORDER } from './config.js';
import { walkFiles, resolveInLibrary } from './fsutil.js';
import { ingestFromWatch, ingestExisting } from './ingest.js';
import { allItems, deleteItem } from './db.js';

const watchers = [];

function relSegments(root, abs) {
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).filter(Boolean);
}

// One full pass: catalog anything already in the libraries, pull in anything
// sitting in the inboxes, and drop catalog rows whose library file is gone.
export async function reconcile() {
  const cfg = loadConfig();
  let added = 0, pruned = 0;

  for (const key of CATEGORY_ORDER) {
    const c = cfg.categories[key];
    if (!c) continue;

    // 1. Catalog files already present in the library.
    for await (const f of walkFiles(c.library)) {
      const rel = relSegments(c.library, f.abs);
      if (!rel) continue;
      const r = await ingestExisting(key, f.abs, rel).catch((e) => ({ error: e.message }));
      if (r.added) added++;
    }

    // 2. Pull in anything already waiting in the inbox folders.
    for (const w of c.watch || []) {
      for await (const f of walkFiles(w)) {
        const rel = relSegments(w, f.abs);
        if (!rel) continue;
        const r = await ingestFromWatch(key, f.abs, rel).catch((e) => ({ error: e.message }));
        if (r.added) added++;
      }
    }
  }

  // 3. Prune catalog rows whose underlying library file has disappeared.
  for (const it of allItems()) {
    const c = cfg.categories[it.category];
    if (!c) { deleteItem(it.id); pruned++; continue; }
    const abs = resolveInLibrary(c.library, it.relPath);
    if (!abs || !fs.existsSync(abs)) { deleteItem(it.id); pruned++; }
  }

  console.log(`[reconcile] added ${added}, pruned ${pruned}`);
  return { added, pruned };
}

export function startWatchers() {
  stopWatchers();
  const cfg = loadConfig();
  for (const key of CATEGORY_ORDER) {
    const c = cfg.categories[key];
    if (!c || !c.watch?.length) continue;
    const w = chokidar.watch(c.watch, {
      ignoreInitial: true,                 // startup reconcile already handled existing files
      ignored: (p) => path.basename(p).startsWith('.'),
      awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 300 },
      depth: 20
    });
    w.on('add', async (abs) => {
      const root = (c.watch || []).find((r) => abs.startsWith(path.resolve(r)));
      const rel = root ? relSegments(path.resolve(root), path.resolve(abs)) : null;
      if (!rel) return;
      try {
        const r = await ingestFromWatch(key, abs, rel);
        if (r.added) console.log(`[watch:${key}] ingested ${rel.join('/')}`);
      } catch (e) {
        console.warn(`[watch:${key}] failed on ${abs}:`, e.message);
      }
    });
    w.on('error', (e) => console.warn(`[watch:${key}] error:`, e.message));
    watchers.push(w);
  }
  console.log(`[watch] watching ${watchers.length} categor${watchers.length === 1 ? 'y' : 'ies'}`);
}

export function stopWatchers() {
  while (watchers.length) watchers.pop().close();
}
