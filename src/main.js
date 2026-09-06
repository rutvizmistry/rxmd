import './styles.css';
import * as api from './api.js';
import { AuthError } from './api.js';
import { Reader } from './viewer.js';
import { EpubReader } from './epub.js';

const $ = (id) => document.getElementById(id);

const state = {
  categories: [],
  nav: { category: null, path: [] }, // category null → landing (3 cards)
  search: '',
  reader: null,
  epub: null,
  prefs: loadPrefs()
};

function loadPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem('rxmd.prefs') || '{}'); } catch { /* ignore */ }
  return { theme: p.theme || null, pdfDark: p.pdfDark ?? null, pdfDarkShade: p.pdfDarkShade || 'charcoal' };
}
function savePrefs() { try { localStorage.setItem('rxmd.prefs', JSON.stringify(state.prefs)); } catch { /* ignore */ } }

// ---------------------------------------------------------------- boot
async function boot() {
  initTheme();
  let session;
  try { session = await api.getSession(); }
  catch { session = { authed: false }; }

  if (!session.authed) { showLogin(); return; }
  await enterApp();
}

function showLogin() {
  $('login').hidden = false;
  $('app').hidden = true;
  const form = $('loginForm');
  form.onsubmit = async (e) => {
    e.preventDefault();
    $('loginErr').hidden = true;
    try {
      await api.login($('loginPw').value);
      $('login').hidden = true;
      await enterApp();
    } catch (err) {
      $('loginErr').textContent = err instanceof AuthError || /wrong/i.test(err.message) ? 'Wrong password.' : err.message;
      $('loginErr').hidden = false;
    }
  };
  $('loginPw').focus();
}

async function enterApp() {
  $('app').hidden = false;
  buildReaders();
  wireChrome();
  await loadCategories();
  render();
}

function buildReaders() {
  if (state.reader) return;
  state.reader = new Reader({
    root: $('reader'), container: $('viewerContainer'), viewer: $('viewer'),
    title: $('readerTitle'), close: $('readerClose'),
    tools: [...document.querySelectorAll('#reader .tool[data-tool]')],
    swatches: $('annSwatches'), color: $('annColor'), params: $('annParams'),
    thickness: $('annThickness'), thicknessWrap: $('thicknessWrap'),
    opacity: $('annOpacity'), opacityWrap: $('opacityWrap'),
    fontSize: $('annFontSize'), fontSizeWrap: $('fontSizeWrap'),
    underlineOptsBtn: $('underlineOptsBtn'), underlineDialog: $('underlineDialog'),
    ulDescenderRatio: $('ulDescenderRatio'), ulDescenderRatioVal: $('ulDescenderRatioVal'),
    ulClearance: $('ulClearance'), ulClearanceVal: $('ulClearanceVal'),
    ulResetBtn: $('ulResetBtn'), ulDefaultBtn: $('ulDefaultBtn'), ulPdfName: $('ulPdfName'),
    zoomIn: $('zoomIn'), zoomOut: $('zoomOut'), zoomLevel: $('zoomLevel'),
    pdfDarkBtn: $('pdfDarkBtn'), pdfShade: $('pdfShade'),
    undo: $('undoBtn'), redo: $('redoBtn'), del: $('deleteBtn'), save: $('saveAnnBtn')
  });
  const r = state.reader;
  r.pdfDark = state.prefs.pdfDark ?? (state.prefs.theme === 'dark');
  r.pdfShade = state.prefs.pdfDarkShade;
  $('pdfShade').value = r.pdfShade;
  r.onPdfDarkChange = (on) => { state.prefs.pdfDark = on; savePrefs(); };
  r.onPdfShadeChange = (name) => { state.prefs.pdfDarkShade = name; savePrefs(); };
  r.loadUnderlineOpts = (id) => api.getUnderlineOpts(id).catch(() => null);
  r.saveUnderlineOpts = (id, opts, asDefault) => api.saveUnderlineOpts(id, opts, asDefault).catch(() => {});
  r.saveBytes = (article, bytes) => api.saveFileBytes(article.id, bytes);
  $('pdfShade').addEventListener('change', (e) => r.setPdfShade(e.target.value, true));

  state.epub = new EpubReader({
    root: $('epubReader'), close: $('epubClose'), title: $('epubTitle'),
    area: $('epubArea'), prev: $('epubPrev'), next: $('epubNext'),
    progress: $('epubProgress'), highlightBtn: $('epubHighlight')
  });
  state.epub.onClose = () => refreshCurrent();
}

// ---------------------------------------------------------------- theme
function initTheme() {
  if (!state.prefs.theme) {
    state.prefs.theme = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  applyTheme(state.prefs.theme);
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $('themeBtn');
  if (btn) { btn.textContent = theme === 'dark' ? '☀️' : '🌙'; btn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'; }
}
function toggleTheme() {
  state.prefs.theme = state.prefs.theme === 'dark' ? 'light' : 'dark';
  applyTheme(state.prefs.theme);
  savePrefs();
}

// ---------------------------------------------------------------- status
let statusTimer;
function status(msg, kind = 'warn', sticky = false) {
  const el = $('statusBar');
  el.className = 'statusbar' + (kind === 'error' ? ' err' : kind === 'ok' ? ' ok' : '');
  el.innerHTML = msg;
  el.hidden = false;
  clearTimeout(statusTimer);
  if (!sticky) statusTimer = setTimeout(() => (el.hidden = true), 5000);
}

// ---------------------------------------------------------------- data
async function loadCategories() {
  try { state.categories = await api.getCategories(); }
  catch (e) { if (e instanceof AuthError) return showLogin(); state.categories = []; }
}

// ---------------------------------------------------------------- chrome wiring
function wireChrome() {
  $('brandHome').addEventListener('click', () => go({ category: null, path: [] }));
  $('themeBtn').addEventListener('click', toggleTheme);
  $('settingsBtn').addEventListener('click', openSettings);
  $('uploadBtn').addEventListener('click', openUpload);
  $('searchBox').addEventListener('input', (e) => { state.search = e.target.value.trim(); render(); });
  wireUpload();
  wireSettings();
}

// ---------------------------------------------------------------- navigation
function go(nav) { state.nav = nav; render(); }

function crumbBar() {
  const bc = $('breadcrumbs');
  bc.innerHTML = '';
  const add = (label, onClick, current) => {
    if (bc.children.length) { const s = document.createElement('span'); s.className = 'sep'; s.textContent = '›'; bc.appendChild(s); }
    const el = document.createElement('span');
    el.className = 'crumb' + (current ? ' current' : '');
    el.textContent = label;
    if (onClick && !current) el.addEventListener('click', onClick);
    bc.appendChild(el);
  };
  if (state.search) { add('Library', () => go({ category: null, path: [] }), false); add('Search', null, true); return; }
  add('Library', () => go({ category: null, path: [] }), state.nav.category === null);
  if (state.nav.category) {
    const cat = state.categories.find((c) => c.key === state.nav.category);
    const label = cat ? cat.label : state.nav.category;
    const path = state.nav.path || [];
    add(label, () => go({ category: state.nav.category, path: [] }), path.length === 0);
    path.forEach((seg, i) => add(seg, () => go({ category: state.nav.category, path: path.slice(0, i + 1) }), i === path.length - 1));
  }
}

// ---------------------------------------------------------------- rendering
async function render() {
  crumbBar();
  const view = $('view');
  if (state.search) return renderSearch(view);
  if (!state.nav.category) return renderLanding(view);
  return renderFolder(view);
}

async function refreshCurrent() {
  await loadCategories();
  render();
}

const CARD_ICON = { research: '📚', ebooks: '📖', others: '🗂' };

function renderLanding(view) {
  view.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'grid cards';
  for (const c of state.categories) {
    const el = document.createElement('div');
    el.className = 'cat-card';
    el.innerHTML = `<div class="cc-icon">${CARD_ICON[c.key] || '📁'}</div>
      <div class="cc-title">${esc(c.label)}</div>
      <div class="cc-meta">
        <span class="badge">${c.count} item${c.count === 1 ? '' : 's'}</span>
        ${c.unread ? `<span class="badge-unread">${c.unread} unread</span>` : ''}
      </div>`;
    el.addEventListener('click', () => go({ category: c.key, path: [] }));
    grid.appendChild(el);
  }
  if (!state.categories.length) view.innerHTML = `<div class="empty"><h2>No categories</h2><p>Check the server configuration.</p></div>`;
  else view.appendChild(grid);
}

async function renderFolder(view) {
  let data;
  try { data = await api.browse(state.nav.category, state.nav.path); }
  catch (e) { if (e instanceof AuthError) return showLogin(); view.innerHTML = `<div class="empty"><h2>Error</h2><p>${esc(e.message)}</p></div>`; return; }

  view.innerHTML = '';
  if (data.folders.length) {
    const grid = document.createElement('div');
    grid.className = 'grid folders';
    for (const f of [...data.folders].sort((a, b) => natCmp(b.name, a.name))) {
      const el = document.createElement('div');
      el.className = 'folder-card';
      el.innerHTML = `<div class="fc-title">📁 ${esc(f.name)}</div>
        <div class="fc-meta"><span class="badge">${f.count} item${f.count === 1 ? '' : 's'}</span>
        ${f.unread ? `<span class="badge-unread">${f.unread} unread</span>` : ''}</div>`;
      el.addEventListener('click', () => go({ category: state.nav.category, path: [...state.nav.path, f.name] }));
      grid.appendChild(el);
    }
    view.appendChild(grid);
  }
  if (data.files.length) {
    data.files.sort((a, b) => natCmp(a.title || a.fileName, b.title || b.fileName));
    view.appendChild(tileGridEl(data.files));
  }
  if (!data.folders.length && !data.files.length) {
    view.innerHTML = `<div class="empty"><h2>Empty</h2><p>Nothing here yet. Drop files into this category's watched folder, or use <b>＋ Add</b>.</p></div>`;
  }
}

async function renderSearch(view) {
  let list;
  try { list = await api.search(state.search); }
  catch (e) { if (e instanceof AuthError) return showLogin(); view.innerHTML = `<div class="empty"><h2>Error</h2><p>${esc(e.message)}</p></div>`; return; }
  view.innerHTML = '';
  if (!list.length) { view.innerHTML = `<div class="empty"><h2>No matches</h2><p>Nothing matched “${esc(state.search)}”.</p></div>`; return; }
  view.appendChild(tileGridEl(list));
}

function tileGridEl(list) {
  const grid = document.createElement('div');
  grid.className = 'grid tiles';
  for (const a of list) grid.appendChild(tile(a));
  return grid;
}

const TYPE_ICON = { pdf: '📄', epub: '📗', image: '🖼', doc: '📃' };

function tile(a) {
  const el = document.createElement('div');
  el.className = 'tile' + (a.read ? ' read' : '');
  const thumbHtml = a.thumbUrl
    ? `<img src="${a.thumbUrl}" alt="" loading="lazy" />`
    : `<span>${TYPE_ICON[a.type] || '📄'}</span>`;
  const f = a.folder || [];
  const label = f.length ? f[f.length - 1] : '';
  el.innerHTML = `
    ${a.read ? '' : '<span class="unread-dot" title="Unread"></span>'}
    <div class="thumb">${thumbHtml}</div>
    <div class="tile-body">
      ${label ? `<div class="t-journal">${esc(label)}</div>` : ''}
      <div class="t-title">${esc(a.title || a.fileName)}</div>
      ${a.authors ? `<div class="t-authors">${esc(a.authors)}</div>` : ''}
      ${a.abstract ? `<div class="t-abstract">${esc(a.abstract)}</div>` : ''}
      <div class="t-foot">
        <span class="t-file">${esc(a.fileName)}</span>
        <span class="t-actions">
          <button class="mini" data-act="read">${a.read ? 'Mark unread' : 'Mark read'}</button>
        </span>
      </div>
    </div>`;
  el.addEventListener('click', (e) => {
    if (e.target.dataset.act === 'read') { e.stopPropagation(); toggleRead(a, el); return; }
    openItem(a);
  });
  return el;
}

async function toggleRead(a, el) {
  a.read = !a.read;
  try { await api.setRead(a.id, a.read); } catch { /* ignore */ }
  el.classList.toggle('read', a.read);
  el.querySelector('.unread-dot')?.remove();
  if (!a.read) {
    const dot = document.createElement('span'); dot.className = 'unread-dot'; dot.title = 'Unread';
    el.prepend(dot);
  }
  const btn = el.querySelector('[data-act="read"]');
  if (btn) btn.textContent = a.read ? 'Mark unread' : 'Mark read';
}

// ---------------------------------------------------------------- open item
async function openItem(a) {
  try {
    if (a.type === 'pdf') {
      const buf = await api.fetchFileBytes(a.id);
      state.reader.pdfDark = state.prefs.pdfDark ?? (state.prefs.theme === 'dark');
      await state.reader.open(a, buf, () => status('Annotations saved.', 'ok'));
    } else if (a.type === 'epub') {
      await state.epub.open(a);
    } else if (a.type === 'image') {
      openMedia(a, `<img src="${api.fileUrl(a.id)}" alt="${esc(a.title || a.fileName)}" />`);
    } else {
      openMedia(a, `<div class="media-fallback"><div class="mf-icon">${TYPE_ICON[a.type] || '📄'}</div>
        <p>${esc(a.fileName)}</p><p class="muted">Preview isn't available for this file type — use Download to open it in another app.</p></div>`);
    }
    if (!a.read) { a.read = true; api.setRead(a.id, true).catch(() => {}); }
  } catch (e) {
    if (e instanceof AuthError) return showLogin();
    status('Could not open: ' + e.message, 'error');
  }
}

function openMedia(a, innerHtml) {
  $('mediaTitle').textContent = a.title || a.fileName;
  $('mediaBody').innerHTML = innerHtml;
  const dl = $('mediaDownload');
  dl.href = api.fileUrl(a.id);
  dl.setAttribute('download', a.fileName);
  $('mediaViewer').hidden = false;
  $('mediaClose').onclick = () => { $('mediaViewer').hidden = true; $('mediaBody').innerHTML = ''; refreshCurrent(); };
}

// ---------------------------------------------------------------- upload
function openUpload() {
  const sel = $('uploadCategory');
  sel.innerHTML = state.categories.map((c) => `<option value="${c.key}">${esc(c.label)}</option>`).join('');
  if (state.nav.category) sel.value = state.nav.category;
  $('uploadSubpath').value = (state.nav.path || []).join('/');
  $('uploadList').textContent = 'No files chosen.';
  $('uploadList').dataset.count = '0';
  $('uploadGoBtn').disabled = true;
  $('uploadProgress').hidden = true;
  $('uploadDialog').showModal();
}

let pendingFiles = [];
function wireUpload() {
  const input = $('fileInput');
  $('uploadPickBtn').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    pendingFiles = [...input.files];
    $('uploadList').textContent = pendingFiles.length ? pendingFiles.map((f) => f.name).join(', ') : 'No files chosen.';
    $('uploadGoBtn').disabled = !pendingFiles.length;
  });
  $('uploadGoBtn').addEventListener('click', async () => {
    if (!pendingFiles.length) return;
    const category = $('uploadCategory').value;
    const subpath = $('uploadSubpath').value.trim();
    const prog = $('uploadProgress'); prog.hidden = false;
    const bar = prog.querySelector('.bar');
    try {
      const res = await api.upload(category, subpath, pendingFiles, (p) => { bar.style.width = Math.round(p * 100) + '%'; });
      const added = (res.results || []).filter((r) => r.added).length;
      const dup = (res.results || []).filter((r) => r.skipped === 'duplicate').length;
      const failed = (res.results || []).filter((r) => r.error).length;
      const parts = [];
      if (added) parts.push(`${added} added`);
      if (dup) parts.push(`${dup} already in library`);
      if (failed) parts.push(`${failed} failed`);
      status(`Upload complete — ${parts.join(', ') || 'nothing new'}.`, failed ? 'warn' : 'ok');
      $('uploadDialog').close();
      pendingFiles = []; $('fileInput').value = '';
      await refreshCurrent();
    } catch (e) {
      if (e instanceof AuthError) { $('uploadDialog').close(); return showLogin(); }
      status('Upload failed: ' + e.message, 'error');
    } finally {
      bar.style.width = '0%';
    }
  });
}

// ---------------------------------------------------------------- settings
async function openSettings() {
  let cfg;
  try { cfg = await api.getConfig(); }
  catch (e) { if (e instanceof AuthError) return showLogin(); status('Could not load settings: ' + e.message, 'error'); return; }
  $('useCrossref').checked = !!cfg.useCrossref;
  const box = $('catSettings');
  box.innerHTML = '';
  for (const [key, c] of Object.entries(cfg.categories)) {
    const div = document.createElement('div');
    div.className = 'cat-setting';
    div.dataset.key = key;
    div.innerHTML = `
      <div class="cs-label">${esc(c.label)}</div>
      <label class="field"><span>Watched inbox folder(s) <span class="muted">(one per line)</span></span>
        <textarea class="cs-watch" rows="2">${esc((c.watch || []).join('\n'))}</textarea></label>
      <label class="field"><span>Library folder <span class="muted">(annotated copies)</span></span>
        <input class="cs-library" type="text" value="${esc(c.library)}" /></label>`;
    box.appendChild(div);
  }
  $('settingsDialog').showModal();
}

function wireSettings() {
  $('rescanBtn').addEventListener('click', async () => {
    status('<span class="spinner"></span> Rescanning…', 'warn', true);
    try { const r = await api.rescan(); status(`Rescan complete — ${r.added} added, ${r.pruned} removed.`, 'ok'); await refreshCurrent(); }
    catch (e) { status('Rescan failed: ' + e.message, 'error'); }
  });
  $('saveCfgBtn').addEventListener('click', async () => {
    const categories = {};
    for (const div of document.querySelectorAll('.cat-setting')) {
      categories[div.dataset.key] = {
        watch: div.querySelector('.cs-watch').value.split('\n').map((s) => s.trim()).filter(Boolean),
        library: div.querySelector('.cs-library').value.trim()
      };
    }
    try {
      await api.saveConfig({ useCrossref: $('useCrossref').checked, categories });
      status('Settings saved.', 'ok');
      $('settingsDialog').close();
      await refreshCurrent();
    } catch (e) { status('Could not save settings: ' + e.message, 'error'); }
  });
  $('pwSaveBtn').addEventListener('click', async () => {
    try {
      await api.setPassword($('pwCurrent').value, $('pwNext').value);
      status('Password updated.', 'ok');
      $('pwCurrent').value = ''; $('pwNext').value = '';
    } catch (e) { status('Could not update password: ' + e.message, 'error'); }
  });
  $('logoutBtn').addEventListener('click', async () => {
    try { await api.logout(); } catch { /* ignore */ }
    location.reload();
  });
}

// ---------------------------------------------------------------- utils
const natCmp = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

boot();
