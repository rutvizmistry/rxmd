// Ingest pipeline — the server-side equivalent of the browser scan.js.
//
// A file arrives either from a watched inbox (copy it into the library, mirroring
// its subfolder path) or is already sitting in the library (reconcile on startup /
// after an upload written straight into the library). Either way we hash it for a
// stable content id, extract metadata + a thumbnail, and upsert a catalog row.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { copyIntoLibrary, sha256File, typeOf } from './fsutil.js';
import { extractMetadata } from './extract.js';
import { hasItem, getItem, upsertItem } from './db.js';

function categoryCfg(key) {
  const c = loadConfig().categories[key];
  if (!c) throw new Error(`Unknown category: ${key}`);
  return c;
}

export function thumbPathFor(categoryKey, id) {
  return path.join(categoryCfg(categoryKey).library, '.rxmd', 'thumbs', `${id}.jpg`);
}

// Build the catalog row + write the thumbnail for a file that already lives in
// the library at `absPath` with library-relative segments `relPath`.
async function catalogLibraryFile(categoryKey, absPath, relPath, id) {
  const fileName = relPath[relPath.length - 1];
  const type = typeOf(fileName) || 'doc';
  const stat = await fsp.stat(absPath);
  const meta = await extractMetadata(absPath, type, {
    useCrossref: loadConfig().useCrossref,
    mtimeMs: stat.mtimeMs
  });

  let hasThumb = false;
  if (meta.thumb) {
    const tp = thumbPathFor(categoryKey, id);
    await fsp.mkdir(path.dirname(tp), { recursive: true });
    await fsp.writeFile(tp, meta.thumb);
    hasThumb = true;
  }

  return upsertItem({
    id,
    category: categoryKey,
    folder: relPath.slice(0, -1),
    relPath,
    fileName,
    type,
    title: meta.title,
    authors: meta.authors,
    abstract: meta.abstract,
    journal: meta.journal,
    doi: meta.doi,
    size: stat.size,
    read: getItem(id)?.read ?? false,
    hasThumb,
    publishedAt: meta.publishedAt
  });
}

// A new file appeared in a watched folder. `relFromWatch` is its path relative to
// the watched root (subfolders + filename). Copy it into the library (mirroring
// that path) and catalog it. Idempotent by content hash.
export async function ingestFromWatch(categoryKey, srcAbs, relFromWatch) {
  const fileName = relFromWatch[relFromWatch.length - 1];
  if (!typeOf(fileName)) return { skipped: 'type' };

  let id;
  try { id = await sha256File(srcAbs); } catch { return { skipped: 'unreadable' }; }
  if (hasItem(id)) return { skipped: 'duplicate', id };

  const folder = relFromWatch.slice(0, -1);
  const { relPath, absPath } = await copyIntoLibrary(categoryCfg(categoryKey).library, folder, fileName, srcAbs, id);
  const item = await catalogLibraryFile(categoryKey, absPath, relPath, id);
  return { added: true, item };
}

// Reconcile a file that's already in the library (startup scan / upload). Skips
// if its content id is already cataloged.
export async function ingestExisting(categoryKey, absPath, relPath) {
  const fileName = relPath[relPath.length - 1];
  if (!typeOf(fileName)) return { skipped: 'type' };
  let id;
  try { id = await sha256File(absPath); } catch { return { skipped: 'unreadable' }; }
  if (hasItem(id)) return { skipped: 'duplicate', id };
  const item = await catalogLibraryFile(categoryKey, absPath, relPath, id);
  return { added: true, item };
}
