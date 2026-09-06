// Node filesystem helpers — the server-side port of the browser src/fs.js.
// Same ideas (sanitize names, mirror a subfolder tree, idempotent copy-into-
// library, sha256 identity) but on top of node:fs/promises instead of the
// File System Access API.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const PDF_RE = /\.pdf$/i;
export const EPUB_RE = /\.epub$/i;
export const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?|svg)$/i;

// File types RxMD ingests. Anything else is skipped by the watcher.
export function typeOf(name) {
  if (PDF_RE.test(name)) return 'pdf';
  if (EPUB_RE.test(name)) return 'epub';
  if (IMAGE_RE.test(name)) return 'image';
  if (/\.(docx?|pptx?|xlsx?|txt|md|rtf|odt|csv)$/i.test(name)) return 'doc';
  return null;
}

// Illegal characters for Windows/most filesystems + trim dots/spaces. Mirrors
// the browser sanitizeName so library paths look identical on both sides.
export function sanitizeName(name, fallback = 'Unknown') {
  if (!name) return fallback;
  let s = String(name)
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/g, '')
    .trim();
  if (s.length > 150) s = s.slice(0, 150).trim();
  return s || fallback;
}

export async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

export function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Recursively yield ingestable files under a root, skipping dot-directories
// (e.g. .rxmd). Returns { abs, relPath: [...segments, fileName], name, type }.
export async function* walkFiles(root) {
  async function* walk(dir, prefix) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        yield* walk(abs, [...prefix, e.name]);
      } else if (e.isFile() && typeOf(e.name)) {
        yield { abs, name: e.name, relPath: [...prefix, e.name], type: typeOf(e.name) };
      }
    }
  }
  yield* walk(root, []);
}

// Resolve/create a nested subdirectory from an array of (raw) path segments.
export async function ensurePath(rootDir, segments) {
  let dir = rootDir;
  for (const raw of segments) {
    dir = path.join(dir, sanitizeName(raw));
  }
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

// Copy a source file into <libraryRoot>/<...segments>/fileName.
// - Identical content already present under that name  → reuse it (idempotent).
// - Name taken by *different* content                  → suffix " (2)", " (3)"…
// Returns { absPath, relPath:[...segments, name], fileName, reused }.
export async function copyIntoLibrary(libraryRoot, segments, fileName, srcAbs, contentHash) {
  const dir = await ensurePath(libraryRoot, segments);
  const cleanSegs = segments.map((s) => sanitizeName(s));
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';

  let target = fileName;
  let i = 1;
  while (await exists(path.join(dir, target))) {
    if (contentHash) {
      try {
        if ((await sha256File(path.join(dir, target))) === contentHash) {
          return { absPath: path.join(dir, target), relPath: [...cleanSegs, target], fileName: target, reused: true };
        }
      } catch { /* fall through */ }
    }
    i++;
    target = `${base} (${i})${ext}`;
  }
  const abs = path.join(dir, target);
  await fsp.copyFile(srcAbs, abs);
  return { absPath: abs, relPath: [...cleanSegs, target], fileName: target, reused: false };
}

// Join a library root + a stored relPath array into an absolute path, guarding
// against traversal outside the root.
export function resolveInLibrary(libraryRoot, relPath) {
  const abs = path.resolve(libraryRoot, ...relPath);
  const rootAbs = path.resolve(libraryRoot);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}
