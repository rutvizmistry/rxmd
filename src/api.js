// Thin fetch wrappers around the RxMD server API. All requests are same-origin
// and rely on the session cookie for auth.

async function j(url, opts = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...opts });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch { /* non-json */ }
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res;
}

export class AuthError extends Error {
  constructor() { super('auth required'); this.name = 'AuthError'; }
}

// ---- session ----
export const getSession = () => j('/api/session');
export const login = (password) => j('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
export const logout = () => j('/api/logout', { method: 'POST' });

// ---- catalog ----
export const getCategories = () => j('/api/categories').then((r) => r.categories);
export const browse = (category, path = []) =>
  j(`/api/browse?category=${encodeURIComponent(category)}&path=${encodeURIComponent(path.join('/'))}`);
export const search = (q) => j(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.items);

// ---- files ----
export const fileUrl = (id) => `/api/file/${id}`;
export const thumbUrl = (id) => `/api/thumb/${id}`;
export async function fetchFileBytes(id) {
  const res = await fetch(`/api/file/${id}`, { credentials: 'same-origin' });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error('Could not load file');
  return res.arrayBuffer();
}
export const saveFileBytes = (id, bytes) =>
  j(`/api/file/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: bytes });

export const setRead = (id, read) =>
  j(`/api/items/${id}/read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ read }) });

// ---- upload ----
export function upload(category, subpath, files, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    const xhr = new XMLHttpRequest();
    const qs = `category=${encodeURIComponent(category)}&subpath=${encodeURIComponent(subpath || '')}`;
    xhr.open('POST', `/api/upload?${qs}`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status === 401) return reject(new AuthError());
      if (xhr.status >= 200 && xhr.status < 300) { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); } }
      else reject(new Error('Upload failed'));
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(form);
  });
}

// ---- epub sidecar annotations ----
export const getEpubAnnotations = (id) => j(`/api/epub/${id}/annotations`).then((r) => r.annotations);
export const saveEpubAnnotations = (id, annotations) =>
  j(`/api/epub/${id}/annotations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ annotations }) });

// ---- per-PDF underline placement (shared across devices) ----
export const getUnderlineOpts = (id) => j(`/api/underline/${id}`).then((r) => r.opts);
export const saveUnderlineOpts = (id, opts, asDefault) =>
  j('/api/underline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, opts, asDefault }) });

// ---- config / admin ----
export const getConfig = () => j('/api/config');
export const saveConfig = (cfg) => j('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
export const setPassword = (current, next) => j('/api/admin/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current, next }) });
export const rescan = () => j('/api/admin/rescan', { method: 'POST' });
