// JSON-backed catalog — the server-side replacement for the browser's IndexedDB
// store plus the old .rxmd/index.json backup. Everything lives in one durable
// file on the clinic PC's disk (data/catalog.json), held in memory for fast
// browse/search and written back atomically (temp file + rename), debounced.
//
// Scale note: this is a single-clinician library (hundreds–low thousands of
// files). A flat in-memory map with linear search is more than fast enough and
// keeps deployment dependency-free (no native SQLite build on the clinic PC).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'catalog.json');
const VERSION = 1;

const state = {
  items: new Map(),          // id -> item record
  prefs: {},                 // ui prefs shared across devices (e.g. underlineOpts)
  epubAnn: {}                // itemId -> epub sidecar annotations (array)
};

export function initDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      for (const it of data.items || []) state.items.set(it.id, it);
      state.prefs = data.prefs || {};
      state.epubAnn = data.epubAnn || {};
    } catch (e) {
      console.warn('[db] catalog.json unreadable, starting fresh:', e.message);
    }
  }
}

let saveTimer = null;
let saving = false;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 500);
}
export async function flush() {
  if (saving) { scheduleSave(); return; }
  saving = true;
  try {
    const payload = {
      version: VERSION,
      updatedAt: Date.now(),
      items: [...state.items.values()],
      prefs: state.prefs,
      epubAnn: state.epubAnn
    };
    const tmp = FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(payload));
    await fsp.rename(tmp, FILE);
  } catch (e) {
    console.error('[db] failed to persist catalog:', e.message);
  } finally {
    saving = false;
  }
}

// ---- items ----
export function allItems() { return [...state.items.values()]; }
export function getItem(id) { return state.items.get(id) || null; }
export function hasItem(id) { return state.items.has(id); }

export function upsertItem(item) {
  const prev = state.items.get(item.id);
  const merged = { ...prev, ...item, updatedAt: Date.now() };
  if (!merged.addedAt) merged.addedAt = Date.now();
  state.items.set(item.id, merged);
  scheduleSave();
  return merged;
}

export function setRead(id, read) {
  const it = state.items.get(id);
  if (!it) return null;
  it.read = !!read;
  it.updatedAt = Date.now();
  scheduleSave();
  return it;
}

export function deleteItem(id) {
  const ok = state.items.delete(id);
  if (state.epubAnn[id]) delete state.epubAnn[id];
  if (ok) scheduleSave();
  return ok;
}

// Items belonging to a category.
export function itemsInCategory(category) {
  return [...state.items.values()].filter((i) => i.category === category);
}

// ---- ui prefs (shared across devices) ----
export function getPrefs() { return state.prefs; }
export function setPref(key, val) { state.prefs[key] = val; scheduleSave(); }

// Per-item + default underline placement, keyed like the old browser kvStore.
export function getUnderlineOpts(id) {
  const map = state.prefs.underlineOpts || {};
  return map[id] || map._default || null;
}
export function setUnderlineOpts(id, opts, asDefault) {
  const map = state.prefs.underlineOpts || (state.prefs.underlineOpts = {});
  if (id) map[id] = opts;
  if (asDefault) map._default = opts;
  scheduleSave();
}

// ---- epub sidecar annotations ----
export function getEpubAnn(id) { return state.epubAnn[id] || []; }
export function setEpubAnn(id, annotations) {
  state.epubAnn[id] = annotations || [];
  scheduleSave();
}
