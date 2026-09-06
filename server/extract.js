// Server-side metadata + thumbnail extraction. This is the Node port of the
// browser src/extract.js: the DOM-free parsing logic is identical, but pdf.js
// runs under Node (legacy build) and thumbnails render onto an @napi-rs/canvas
// instead of a browser <canvas>. Also handles EPUB (OPF metadata + cover) and
// images (thumbnail via canvas). Thumbnails are returned as JPEG Buffers.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import AdmZip from 'adm-zip';

const require = createRequire(import.meta.url);
const PDFJS_DIR = path.dirname(require.resolve('pdfjs-dist/package.json'));
// pdf.js needs file:// URLs (not raw Windows paths) for the worker + font data.
const STANDARD_FONTS = pathToFileURL(path.join(PDFJS_DIR, 'standard_fonts') + path.sep).href;

pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(PDFJS_DIR, 'legacy', 'build', 'pdf.worker.mjs')).href;

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const CONTACT = 'rutvizmistry@gmail.com';
export function monthName(m) { return MONTHS[(m || 1) - 1] || 'Unknown'; }

// ---------- shared parsing helpers (identical logic to the browser module) ----------
function parsePdfDate(d) {
  if (!d) return null;
  const m = String(d).match(/(\d{4})(\d{2})?(\d{2})?/);
  if (!m) return null;
  const year = +m[1];
  if (year < 1900 || year > 2100) return null;
  return { year, month: m[2] ? Math.min(12, Math.max(1, +m[2])) : null };
}
function parseAnyDate(s) {
  if (!s) return null;
  const str = String(s);
  let m = str.match(/(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (m) return { year: +m[1], month: Math.min(12, Math.max(1, +m[2])) };
  const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  m = str.match(/([A-Za-z]{3,})\.?\s+(\d{4})|(\d{4})\s+([A-Za-z]{3,})/);
  if (m) {
    const name = (m[1] || m[4] || '').slice(0, 3).toLowerCase();
    const year = +(m[2] || m[3]);
    const idx = monthNames.indexOf(name);
    if (idx >= 0 && year >= 1900 && year <= 2100) return { year, month: idx + 1 };
  }
  m = str.match(/\b(19|20)\d{2}\b/);
  if (m) return { year: +m[0], month: null };
  return null;
}
const cleanText = (s) => (s || '').replace(/\s+/g, ' ').trim();
function looksLikeTitle(t) {
  if (!t) return false;
  const s = cleanText(t);
  return s.length >= 8 && s.length <= 320 && !/^untitled/i.test(s) && !/\.(pdf|docx?)$/i.test(s);
}
function linesFromText(textContent) {
  const rows = new Map();
  for (const item of textContent.items) {
    if (!item.str || !item.str.trim()) continue;
    const y = Math.round(item.transform[5]);
    const size = Math.hypot(item.transform[0], item.transform[1]);
    const key = Math.round(y / 2) * 2;
    if (!rows.has(key)) rows.set(key, { y, size: 0, parts: [] });
    const row = rows.get(key);
    row.size = Math.max(row.size, size);
    row.parts.push(item.str);
  }
  return [...rows.values()]
    .map((r) => ({ y: r.y, size: r.size, text: cleanText(r.parts.join(' ')) }))
    .filter((r) => r.text)
    .sort((a, b) => b.y - a.y);
}
function guessTitle(lines) {
  const top = lines.slice(0, 18);
  if (!top.length) return null;
  const maxSize = Math.max(...top.map((l) => l.size));
  const chosen = [];
  for (const l of top) {
    if (l.size >= maxSize - 0.6 && l.text.length > 2 && !/^\d+$/.test(l.text)) {
      chosen.push(l.text);
      if (chosen.join(' ').length > 200) break;
    } else if (chosen.length) break;
  }
  const t = cleanText(chosen.join(' '));
  return looksLikeTitle(t) ? t : null;
}
function guessAuthors(lines, title) {
  const idx = lines.findIndex((l) => title && l.text && title.startsWith(l.text.slice(0, 12)));
  const after = lines.slice(idx >= 0 ? idx + 1 : 1, (idx >= 0 ? idx + 1 : 1) + 4);
  for (const l of after) {
    const t = l.text;
    if (/[A-Z][a-z]+/.test(t) && (t.includes(',') || /\band\b/.test(t)) && t.length < 240 && !/abstract|introduction|university|department|@/i.test(t)) return t;
  }
  return '';
}
function guessAbstract(fullText) {
  const m = fullText.match(/abstract[\s:.\-]*([\s\S]{60,1600}?)(?:\n\s*\n|introduction|keywords|©|\bdoi\b|methods\b)/i);
  if (m) return cleanText(m[1]);
  const body = cleanText(fullText).slice(0, 500);
  return body.length > 80 ? body : '';
}
function decodeEntities(s) {
  if (!s) return s;
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&(?:apos|#39);/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, '&');
}
const stripJats = (s) => decodeEntities(cleanText((s || '').replace(/<[^>]+>/g, ' ')));

async function crossref(doi) {
  try {
    const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(CONTACT)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const { message } = await res.json();
    if (!message) return null;
    const dp = (message.issued || message.published || message['published-online'] || message['published-print'] || {})['date-parts'];
    const parts = dp && dp[0] ? dp[0] : [];
    const authors = (message.author || []).map((a) => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean);
    return {
      journal: decodeEntities((message['container-title'] || [])[0] || (message['short-container-title'] || [])[0] || null),
      title: decodeEntities((message.title || [])[0] || null),
      authors: authors.length ? authors.map(decodeEntities) : null,
      abstract: stripJats(message.abstract) || null,
      year: parts[0] || null, month: parts[1] || null,
      volume: message.volume || null, issue: message.issue || null
    };
  } catch { return null; }
}

// ---------- thumbnails ----------
async function renderPdfThumb(page) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(1.6, 320 / base.width);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toBuffer('image/jpeg', 0.72);
}

// Scale an image buffer down to a <=320px-wide JPEG thumbnail.
async function imageThumb(buf) {
  const img = await loadImage(buf);
  const scale = Math.min(1, 320 / img.width);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toBuffer('image/jpeg', 0.72);
}

// ---------- per-type extraction ----------
async function extractPdf(absPath, useCrossref) {
  const result = { title: '', authors: '', abstract: '', journal: '', doi: '', year: null, month: null, volume: null, issue: null, thumb: null };
  const data = new Uint8Array(await fsp.readFile(absPath));
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true, standardFontDataUrl: STANDARD_FONTS }).promise;
  try {
    const meta = await doc.getMetadata().catch(() => null);
    const info = (meta && meta.info) || {};
    const xmpMap = {};
    try {
      const md = meta && meta.metadata;
      const all = md && typeof md.getAll === 'function' ? md.getAll() : null;
      if (all) for (const k of Object.keys(all)) xmpMap[k.toLowerCase()] = all[k];
    } catch { /* no XMP */ }
    const xmp = (k) => xmpMap[k.toLowerCase()] ?? null;
    const xmpJournal = cleanText(xmp('prism:publicationName') || '');
    const xmpDateStr = xmp('prism:coverDate') || xmp('prism:publicationDate') || xmp('prism:coverDisplayDate') || '';
    const xmpVolume = xmp('prism:volume');
    const xmpIssue = xmp('prism:number');
    let xmpCreator = xmp('dc:creator');
    if (Array.isArray(xmpCreator)) xmpCreator = xmpCreator.join(', ');

    const page1 = await doc.getPage(1);
    const tc1 = await page1.getTextContent();
    const lines = linesFromText(tc1);
    let fullText = tc1.items.map((i) => i.str).join(' ');
    if (doc.numPages > 1) {
      const p2 = await doc.getPage(2);
      fullText += ' ' + (await p2.getTextContent()).items.map((i) => i.str).join(' ');
    }

    if (xmpJournal) result.journal = xmpJournal;
    if (xmpVolume) result.volume = xmpVolume;
    if (xmpIssue) result.issue = xmpIssue;
    result.title = looksLikeTitle(info.Title) ? cleanText(info.Title)
      : (looksLikeTitle(xmp('dc:title')) ? cleanText(xmp('dc:title')) : (guessTitle(lines) || ''));
    result.authors = cleanText(info.Author) || cleanText(xmpCreator) || guessAuthors(lines, result.title);
    result.abstract = guessAbstract(fullText);
    const doiMatch = fullText.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
    if (doiMatch) result.doi = doiMatch[0].replace(/[.,;)]+$/, '');
    const xmpDate = parseAnyDate(xmpDateStr);
    if (xmpDate) { result.year = xmpDate.year; result.month = xmpDate.month; }
    if (!result.year) {
      const pd = parsePdfDate(info.CreationDate || info.ModDate);
      if (pd) { result.year = pd.year; result.month = pd.month; }
    }
    result.thumb = await renderPdfThumb(page1).catch(() => null);

    if (useCrossref && result.doi) {
      const cr = await crossref(result.doi);
      if (cr) {
        if (cr.journal) result.journal = cr.journal;
        if (cr.title && (!result.title || cr.title.length > result.title.length * 0.6)) result.title = cr.title;
        if (cr.authors) result.authors = cr.authors.join(', ');
        if (cr.abstract) result.abstract = cr.abstract;
        if (cr.year) result.year = cr.year;
        if (cr.month) result.month = cr.month;
        result.volume = cr.volume; result.issue = cr.issue;
      }
    }
  } finally {
    await doc.destroy();
  }
  return result;
}

// EPUB: read title/creator from the OPF and use the cover image as the thumbnail.
async function extractEpub(absPath) {
  const result = { title: '', authors: '', abstract: '', thumb: null };
  try {
    const zip = new AdmZip(absPath);
    const container = zip.getEntry('META-INF/container.xml');
    if (!container) return result;
    const cxml = container.getData().toString('utf8');
    const opfPath = (cxml.match(/full-path="([^"]+)"/) || [])[1];
    if (!opfPath) return result;
    const opfEntry = zip.getEntry(opfPath);
    if (!opfEntry) return result;
    const opf = opfEntry.getData().toString('utf8');
    result.title = cleanText(decodeEntities((opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i) || [])[1] || ''));
    const creators = [...opf.matchAll(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/gi)].map((m) => cleanText(decodeEntities(m[1]))).filter(Boolean);
    result.authors = creators.join(', ');
    result.abstract = cleanText(decodeEntities((opf.match(/<dc:description[^>]*>([\s\S]*?)<\/dc:description>/i) || [])[1] || '')).slice(0, 800);

    // Find a cover image: manifest item with properties="cover-image", or a
    // meta name="cover" pointing at a manifest id, else any image named "cover".
    const opfDir = path.posix.dirname(opfPath);
    const resolveHref = (href) => (opfDir && opfDir !== '.' ? path.posix.join(opfDir, href) : href);
    let coverHref = (opf.match(/<item[^>]*properties="[^"]*cover-image[^"]*"[^>]*href="([^"]+)"/i)
      || opf.match(/<item[^>]*href="([^"]+)"[^>]*properties="[^"]*cover-image[^"]*"/i) || [])[1];
    if (!coverHref) {
      const coverId = (opf.match(/<meta[^>]*name="cover"[^>]*content="([^"]+)"/i) || [])[1];
      if (coverId) coverHref = (opf.match(new RegExp(`<item[^>]*id="${coverId}"[^>]*href="([^"]+)"`, 'i')) || [])[1];
    }
    if (!coverHref) {
      const anyCover = zip.getEntries().find((e) => /cover.*\.(png|jpe?g|webp)$/i.test(e.entryName));
      if (anyCover) coverHref = anyCover.entryName; // already a full zip path
    } else {
      coverHref = resolveHref(coverHref); // manifest href is relative to the OPF
    }
    if (coverHref) {
      const ce = zip.getEntry(coverHref);
      if (ce) result.thumb = await imageThumb(ce.getData()).catch(() => null);
    }
  } catch { /* not a valid epub */ }
  if (!result.title) result.title = path.basename(absPath).replace(EPUB_EXT, '');
  return result;
}
const EPUB_EXT = /\.epub$/i;

async function extractImage(absPath) {
  let thumb = null;
  try { thumb = await imageThumb(await fsp.readFile(absPath)); } catch { /* ignore */ }
  return { title: path.basename(absPath).replace(/\.[^.]+$/, ''), authors: '', abstract: '', thumb };
}

/**
 * Extract metadata + a JPEG thumbnail Buffer for a library file.
 * @param {string} absPath
 * @param {string} type  pdf | epub | image | doc
 * @param {{useCrossref?:boolean, mtimeMs?:number}} opts
 * @returns {{title,authors,abstract,journal?,doi?,year,month,thumb:Buffer|null,publishedAt}}
 */
export async function extractMetadata(absPath, type, opts = {}) {
  const { useCrossref = false } = opts;
  const fileName = path.basename(absPath);
  const stat = await fsp.stat(absPath).catch(() => null);
  const mtime = opts.mtimeMs || (stat ? stat.mtimeMs : Date.now());

  let r;
  if (type === 'pdf') r = await extractPdf(absPath, useCrossref).catch(() => ({}));
  else if (type === 'epub') r = await extractEpub(absPath).catch(() => ({}));
  else if (type === 'image') r = await extractImage(absPath).catch(() => ({}));
  else r = {};

  const out = {
    title: r.title || '', authors: r.authors || '', abstract: r.abstract || '',
    journal: r.journal || '', doi: r.doi || '',
    year: r.year || null, month: r.month || null,
    volume: r.volume || null, issue: r.issue || null,
    thumb: r.thumb || null, publishedAt: mtime
  };
  const lm = new Date(mtime);
  if (!out.year) out.year = lm.getFullYear();
  if (!out.month) out.month = lm.getMonth() + 1;
  if (!out.title) out.title = fileName.replace(/\.[^.]+$/, '');
  if (out.year && out.month) out.publishedAt = new Date(out.year, out.month - 1, 1).getTime();
  return out;
}
