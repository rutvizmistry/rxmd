// RxMD HTTP API. Everything except /api/session and /api/login sits behind
// requireAuth. The browser is a thin client: it browses the catalog, streams file
// bytes, and PUTs annotated PDF bytes back for the server to write into the
// library copy on disk.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import multer from 'multer';
import { loadConfig, saveConfig, ensureDirs, CATEGORY_ORDER } from './config.js';
import {
  allItems, getItem, itemsInCategory, setRead,
  getEpubAnn, setEpubAnn, getUnderlineOpts, setUnderlineOpts
} from './db.js';
import { resolveInLibrary } from './fsutil.js';
import { thumbPathFor, ingestFromWatch, ingestExisting } from './ingest.js';
import {
  requireAuth, isAuthed, verifyPassword, hashPassword,
  issueSessionCookie, clearSessionCookie
} from './auth.js';
import { reconcile, startWatchers } from './watcher.js';

const upload = multer({ dest: path.join(os.tmpdir(), 'rxmd-uploads') });

// ---- helpers ----
function dtoOf(it) {
  return {
    id: it.id, category: it.category, folder: it.folder || [], relPath: it.relPath,
    fileName: it.fileName, type: it.type, title: it.title, authors: it.authors,
    abstract: it.abstract, journal: it.journal, size: it.size, read: !!it.read,
    hasThumb: !!it.hasThumb, publishedAt: it.publishedAt,
    fileUrl: `/api/file/${it.id}`,
    thumbUrl: it.hasThumb ? `/api/thumb/${it.id}` : null
  };
}
function absOf(it) {
  const c = loadConfig().categories[it.category];
  if (!c) return null;
  return resolveInLibrary(c.library, it.relPath);
}
const unreadCount = (list) => list.filter((a) => !a.read).length;

export function makeRouter() {
  const r = express.Router();

  // ---- session / auth ----
  r.get('/api/session', (req, res) => {
    const cfg = loadConfig();
    res.json({ authed: isAuthed(req), needsPassword: !cfg.passwordHash });
  });
  r.post('/api/login', express.json(), (req, res) => {
    const cfg = loadConfig();
    if (!cfg.passwordHash) { issueSessionCookie(res); return res.json({ ok: true }); }
    if (verifyPassword(req.body?.password || '', cfg.passwordHash)) {
      issueSessionCookie(res);
      return res.json({ ok: true });
    }
    res.status(401).json({ error: 'wrong password' });
  });
  r.post('/api/logout', (req, res) => { clearSessionCookie(res); res.json({ ok: true }); });

  // Everything below requires auth.
  r.use('/api', requireAuth);

  // ---- categories (landing cards) ----
  r.get('/api/categories', (req, res) => {
    const cfg = loadConfig();
    const cards = CATEGORY_ORDER.filter((k) => cfg.categories[k]).map((key) => {
      const list = itemsInCategory(key);
      return { key, label: cfg.categories[key].label, count: list.length, unread: unreadCount(list) };
    });
    res.json({ categories: cards });
  });

  // ---- browse a category's mirrored folder tree ----
  r.get('/api/browse', (req, res) => {
    const category = String(req.query.category || '');
    if (!loadConfig().categories[category]) return res.status(404).json({ error: 'unknown category' });
    const p = req.query.path ? String(req.query.path).split('/').filter(Boolean) : [];
    const depth = p.length;
    const pk = p.join(' ');
    const folderOf = (a) => a.folder || [];
    const under = itemsInCategory(category).filter((a) => folderOf(a).slice(0, depth).join(' ') === pk);

    const folders = new Map();
    const files = [];
    for (const a of under) {
      const f = folderOf(a);
      if (f.length > depth) {
        const name = f[depth];
        (folders.get(name) || folders.set(name, []).get(name)).push(a);
      } else {
        files.push(a);
      }
    }
    res.json({
      category, path: p,
      folders: [...folders.entries()].map(([name, list]) => ({ name, count: list.length, unread: unreadCount(list) })),
      files: files.map(dtoOf)
    });
  });

  // ---- search across all categories ----
  r.get('/api/search', (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return res.json({ items: [] });
    const list = allItems().filter((a) =>
      [a.title, a.authors, a.fileName, a.abstract, a.journal, (a.folder || []).join(' ')]
        .some((f) => (f || '').toLowerCase().includes(q))
    );
    res.json({ items: list.map(dtoOf) });
  });

  // ---- stream original file bytes (Range-enabled via sendFile) ----
  r.get('/api/file/:id', (req, res) => {
    const it = getItem(req.params.id);
    if (!it) return res.status(404).end();
    const abs = absOf(it);
    if (!abs || !fs.existsSync(abs)) return res.status(404).end();
    res.sendFile(abs, { headers: { 'Cache-Control': 'private, max-age=60' } });
  });

  // ---- thumbnail ----
  r.get('/api/thumb/:id', (req, res) => {
    const it = getItem(req.params.id);
    if (!it || !it.hasThumb) return res.status(404).end();
    const tp = thumbPathFor(it.category, it.id);
    if (!fs.existsSync(tp)) return res.status(404).end();
    res.type('image/jpeg').set('Cache-Control', 'private, max-age=86400').sendFile(tp);
  });

  // ---- save annotated PDF bytes back into the library copy ----
  r.put('/api/file/:id', express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: '300mb' }), async (req, res) => {
    const it = getItem(req.params.id);
    if (!it) return res.status(404).json({ error: 'unknown item' });
    if (it.type !== 'pdf') return res.status(400).json({ error: 'only PDF files are saved in place' });
    const abs = absOf(it);
    if (!abs) return res.status(404).json({ error: 'file missing' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty body' });
    try {
      const tmp = abs + '.tmp';
      await fsp.writeFile(tmp, req.body);
      await fsp.rename(tmp, abs);
      const stat = await fsp.stat(abs);
      res.json({ ok: true, size: stat.size });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- read/unread ----
  r.post('/api/items/:id/read', express.json(), (req, res) => {
    const it = setRead(req.params.id, !!req.body?.read);
    if (!it) return res.status(404).json({ error: 'unknown item' });
    res.json({ ok: true, read: it.read });
  });

  // ---- EPUB sidecar annotations ----
  r.get('/api/epub/:id/annotations', (req, res) => res.json({ annotations: getEpubAnn(req.params.id) }));
  r.post('/api/epub/:id/annotations', express.json({ limit: '5mb' }), (req, res) => {
    setEpubAnn(req.params.id, req.body?.annotations || []);
    res.json({ ok: true });
  });

  // ---- per-PDF underline placement (shared across devices) ----
  r.get('/api/underline/:id', (req, res) => res.json({ opts: getUnderlineOpts(req.params.id) }));
  r.post('/api/underline', express.json(), (req, res) => {
    setUnderlineOpts(req.body?.id || null, req.body?.opts || null, !!req.body?.asDefault);
    res.json({ ok: true });
  });

  // ---- upload files into a category (fulfills "add articles/pdfs") ----
  r.post('/api/upload', upload.array('files', 50), async (req, res) => {
    const category = String(req.query.category || req.body?.category || '');
    if (!loadConfig().categories[category]) return res.status(400).json({ error: 'unknown category' });
    const subpath = String(req.query.subpath || req.body?.subpath || '').split('/').map((s) => s.trim()).filter(Boolean);
    const results = [];
    for (const f of req.files || []) {
      const original = Buffer.from(f.originalname, 'latin1').toString('utf8'); // multer mangles utf8 names
      try {
        const rel = [...subpath, original];
        const out = await ingestFromWatch(category, f.path, rel);
        results.push({ name: original, ...out, item: out.item ? dtoOf(out.item) : undefined });
      } catch (e) {
        results.push({ name: original, error: e.message });
      } finally {
        fsp.unlink(f.path).catch(() => {});
      }
    }
    res.json({ results });
  });

  // ---- config / admin ----
  r.get('/api/config', (req, res) => {
    const cfg = loadConfig();
    // Never leak the secret or the hash.
    res.json({
      port: cfg.port, useCrossref: cfg.useCrossref,
      hasPassword: !!cfg.passwordHash,
      categories: Object.fromEntries(CATEGORY_ORDER.filter((k) => cfg.categories[k]).map((k) => [k, {
        label: cfg.categories[k].label, watch: cfg.categories[k].watch, library: cfg.categories[k].library
      }]))
    });
  });
  r.put('/api/config', express.json(), (req, res) => {
    const cfg = loadConfig();
    const body = req.body || {};
    if (typeof body.useCrossref === 'boolean') cfg.useCrossref = body.useCrossref;
    if (body.categories) {
      for (const key of CATEGORY_ORDER) {
        const incoming = body.categories[key];
        if (!incoming || !cfg.categories[key]) continue;
        if (typeof incoming.label === 'string') cfg.categories[key].label = incoming.label;
        if (Array.isArray(incoming.watch)) cfg.categories[key].watch = incoming.watch.filter((s) => typeof s === 'string' && s.trim());
        if (typeof incoming.library === 'string' && incoming.library.trim()) cfg.categories[key].library = incoming.library.trim();
      }
    }
    saveConfig(cfg);
    ensureDirs(cfg);
    startWatchers();
    res.json({ ok: true });
  });
  r.post('/api/admin/password', express.json(), (req, res) => {
    const cfg = loadConfig();
    // Require the current password once one is set.
    if (cfg.passwordHash && !verifyPassword(req.body?.current || '', cfg.passwordHash)) {
      return res.status(403).json({ error: 'current password incorrect' });
    }
    const next = String(req.body?.next || '');
    if (next.length < 4) return res.status(400).json({ error: 'password too short' });
    cfg.passwordHash = hashPassword(next);
    saveConfig(cfg);
    issueSessionCookie(res);
    res.json({ ok: true });
  });
  r.post('/api/admin/rescan', async (req, res) => {
    const stats = await reconcile();
    res.json({ ok: true, ...stats });
  });

  return r;
}
