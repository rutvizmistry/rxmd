# RxMD — a QxMD-style journal library server

RxMD is an **always-on reader for research articles, magazines, e-books and PDF dumps**.
A small Node server runs on an always-on PC (e.g. a clinic PC), watches inbox folders,
copies each new file into a **safe library** that **mirrors your folder structure**, and
serves a web app to **any browser on the LAN** — desktop, iPad, or iPhone — behind a
single shared password. PDFs open in a full annotator; annotations are saved straight
back into the library copy on disk.

Files live only on the server's disk. The browser is a thin client.

## Landing page

Three category cards, each mirroring a set of folders on disk:

- **Research Articles**
- **E-books**
- **Others**

Each category has its own watched inbox folder(s) and a separate library folder. Drop a
file into an inbox (or use **＋ Add**) and it's copied into that category's library,
mirroring any subfolders.

## Supported files

| Type | Experience |
|------|-----------|
| **PDF** | Full pdf.js reader: highlight, underline, freehand ink, text notes, stamps, dark mode. Annotations burned into the file and saved back to the library copy. |
| **EPUB** | Paginated epub.js reader with highlights (stored as sidecar data). Cover + metadata extracted from the book. |
| **Images** | Inline preview. |
| **Other** (Office, txt…) | Tile + download. |

## Requirements

- **Server:** Node.js 20+ on an always-on PC. No C/C++ build tools needed — the one
  native dependency (`@napi-rs/canvas`) ships prebuilt.
- **Clients:** any modern browser (Chrome, Edge, **Safari on iPad/iPhone**, Firefox).

## Quick start (development)

```bash
npm install
npm run server:dev     # API + folder watchers on http://localhost:8787
npm run dev            # Vite client on http://localhost:5173 (proxies /api)
# or both at once:
npm run dev:all
```

On first run the server writes a starter `config.json`. Edit its folder paths, then set a
password: `npm run set-password`.

## Production / clinic deployment

**One-click (recommended):** on the clinic PC (Node.js 20+ and Git for Windows installed),
`git clone` the repo and double-click **`install.bat`**. It installs, builds, optionally
sets the password + auto-start, and launches a **system-tray controller** (blue **Rx**
icon) with Start/Stop/Restart, the server status, and copyable **LAN** + **Tailscale**
addresses for iPad/iPhone/other PCs. Double-click **`update.bat`** to pull future changes
and restart. See **[DEPLOY.md](DEPLOY.md)** for details (and the manual/Windows-service
alternative).

## How it works

- **Watching** — the server uses [chokidar](https://github.com/paulmillr/chokidar) to watch
  each category's inbox folder(s). This runs on the server itself, so ingestion happens
  whether or not any browser is open. On startup it also reconciles the catalog against disk.
- **Filing (mirror)** — each new file is copied into its category's library at the same
  relative path it had in the inbox. De-duplicated by SHA-256 content hash; identical
  re-imports are reused, never duplicated as `name (2).pdf`.
- **Metadata & thumbnails** — extracted on the server: pdf.js + a Node canvas render PDF
  first-page thumbnails and read title/authors/abstract/XMP; EPUB title/cover come from the
  OPF; images are scaled down. Thumbnails are cached under `<library>/.rxmd/thumbs/`. An
  optional Crossref toggle enriches PDF metadata from a DOI.
- **Catalog** — a single durable JSON file, `data/catalog.json`, on the server. It holds
  every item's folder path, metadata, read/unread state, and EPUB highlights. Rebuildable
  from disk any time via **⚙ Settings → Rescan now**.
- **Reading & annotating** — the browser fetches file bytes over HTTP and renders/annotates
  with pdf.js. **Save** burns the annotations into the PDF bytes and PUTs them to the server,
  which overwrites the library copy on disk — so annotations are there on every device.
- **Access** — one shared password → a signed session cookie. LAN-only by design.

## Project layout

```
server/                Node backend
  index.js             bootstrap: config, catalog, static app, watchers, reconcile
  config.js            load/validate config.json; ensure folders
  db.js                JSON-backed catalog (items, read-state, prefs, epub highlights)
  fsutil.js            sanitize / mirror / idempotent copy-into-library / sha256 / walk
  extract.js           server-side metadata + thumbnails (pdf.js, EPUB OPF, images)
  ingest.js            copy-into-library + extract + upsert catalog row
  watcher.js           chokidar watchers + startup reconcile + prune
  auth.js              shared-password login + signed session cookie
  routes.js            HTTP API (session, browse, search, file, thumb, upload, config)
  set-password.js      set/change the shared password
  service.js           install/uninstall the Windows service (node-windows)

src/                   web client
  main.js              login, 3-card landing, folder browse, upload, settings
  api.js               fetch wrappers for the server API
  viewer.js            pdf.js reader + annotation editor (save() → HTTP PUT)
  markup.js            underline text-markup (burned into the PDF with pdf-lib)
  epub.js              epub.js reader + sidecar highlights
  styles.css           styling (light/dark, mobile)

index.html             app shell (login, topbar, readers, dialogs)
config.example.json    documented config template
DEPLOY.md              clinic-PC install + Windows service guide
```
