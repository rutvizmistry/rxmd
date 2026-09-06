// Loads and persists RxMD's server configuration (config.json).
//
// The config file lives next to the project root by default; override with the
// RXMD_CONFIG env var. It holds the LAN port, the shared-password hash, a session
// secret, and the three categories — each with its watched source folder(s) and a
// separate library folder that annotated copies are written into.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const CONFIG_PATH = process.env.RXMD_CONFIG
  ? path.resolve(process.env.RXMD_CONFIG)
  : path.join(ROOT, 'config.json');

// Where the SQLite catalog + logs live. Kept next to the config file.
export const DATA_DIR = process.env.RXMD_DATA
  ? path.resolve(process.env.RXMD_DATA)
  : path.join(ROOT, 'data');

export const CATEGORY_ORDER = ['research', 'ebooks', 'others'];

function defaults() {
  const base = path.join(ROOT, 'library');
  const inbox = path.join(ROOT, 'inbox');
  return {
    port: 8787,
    host: '0.0.0.0',
    passwordHash: null,           // set via `npm run set-password`
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    useCrossref: false,
    categories: {
      research: { label: 'Research Articles', watch: [path.join(inbox, 'Research')], library: path.join(base, 'Research') },
      ebooks:   { label: 'E-books',           watch: [path.join(inbox, 'Ebooks')],   library: path.join(base, 'Ebooks') },
      others:   { label: 'Others',            watch: [path.join(inbox, 'Others')],   library: path.join(base, 'Others') }
    }
  };
}

let cache = null;

export function loadConfig() {
  if (cache) return cache;
  let cfg;
  if (fs.existsSync(CONFIG_PATH)) {
    cfg = { ...defaults(), ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    // Merge category defaults so a partial file still validates.
    cfg.categories = { ...defaults().categories, ...(cfg.categories || {}) };
  } else {
    cfg = defaults();
    saveConfig(cfg);
    console.log(`[config] Wrote a starter config to ${CONFIG_PATH}. Edit its folders, then run "npm run set-password".`);
  }
  cache = cfg;
  return cfg;
}

export function saveConfig(cfg) {
  cache = cfg;
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

// Ensure the data dir and every configured library/watch folder exists so the
// watchers and DB have somewhere to work. Watch folders are created too (so a
// fresh install has an obvious inbox to drop files into).
export function ensureDirs(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const key of CATEGORY_ORDER) {
    const c = cfg.categories[key];
    if (!c) continue;
    fs.mkdirSync(c.library, { recursive: true });
    fs.mkdirSync(path.join(c.library, '.rxmd', 'thumbs'), { recursive: true });
    for (const w of c.watch || []) fs.mkdirSync(w, { recursive: true });
  }
}
