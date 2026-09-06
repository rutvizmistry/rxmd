# Deploying RxMD on the clinic PC

RxMD is now a small **Node server** that watches folders, stores files, and serves a
web reader to every device on the clinic LAN (iPad, iPhone, any desktop browser),
gated by one shared password. Files live only on the clinic PC's disk.

## Architecture in one picture

```
Clinic PC (always on)
  RxMD server (Node, port 8787)
    • watches each category's inbox folder  → copies new files into the library
    • extracts titles/authors/thumbnails    (pdf.js + canvas, EPUB OPF, images)
    • serves the built web app + JSON API over the LAN, behind a shared password
    • annotated PDFs are written back into the library copy on disk
        │
   iPad / iPhone / any browser  →  http://<clinic-pc-ip>:8787
```

Three categories — **Research Articles / E-books / Others** — each with its own
watched inbox folder(s) and a separate library folder. Dropping a file in an inbox (or
using the in-app **＋ Add** button) copies it into that category's library, mirroring
any subfolder structure.

---

## One-click install (recommended)

On the clinic PC, with **Node.js 20+** and **Git for Windows** installed:

1. Clone the repo (once):
   ```bash
   git clone https://github.com/rutvizmistry/rxmd.git
   ```
2. Double-click **`install.bat`**. It installs dependencies, builds the app, optionally
   sets the shared password, optionally adds RxMD to Windows startup, and launches the
   **tray controller** — a blue **Rx** icon in the system tray (bottom-right).

**Right-click the tray icon** to:
- see whether the server is **Running/Stopped**,
- **Open in browser** (double-clicking the icon also opens it),
- copy the **LAN** address and the **Tailscale** address for iPad/iPhone/other PCs
  (both work automatically — the server listens on all interfaces; Tailscale is shown
  when a tailnet IP or the `tailscale` CLI is detected),
- **Start / Stop / Restart** the server,
- **Update RxMD** (runs `update.bat`), or view the server log,
- **Exit** (stops the server).

To get future changes, double-click **`update.bat`** — it runs `git pull`, reinstalls,
rebuilds, and tells the tray to restart the server with the new version.

> The tray runs in the logged-in desktop session — ideal for an always-on PC that stays
> logged in. If you'd rather run it headless as a Windows **service** (no login needed),
> use the manual steps below instead.

---

## Manual / service install

## 1. Build (on your dev machine)

```bash
npm install
npm run build
```

This produces `dist/` (the web app). Copy the whole project folder to the clinic PC —
you need at least: `server/`, `dist/`, `package.json`, `package-lock.json`,
`config.example.json`, `vite.config.js`.

## 2. Install on the clinic PC

Install Node.js 20+ (LTS) on the clinic PC, then in the project folder:

```bash
npm install --omit=dev
```

All native pieces (`@napi-rs/canvas`) ship as prebuilt binaries — **no Visual Studio
or Python build tools required**.

## 3. Configure the folders

On first run the server writes a starter `config.json`. Edit it (or copy
`config.example.json` → `config.json`) so each category points at real folders, e.g.:

```json
"research": {
  "label": "Research Articles",
  "watch": ["D:\\RxMD\\Inbox\\Research"],
  "library": "D:\\RxMD\\Library\\Research"
}
```

- `watch` — one or more inbox folders the server watches (e.g. a WhatsApp download folder).
- `library` — where safe, annotated copies live (this mirrors the inbox subfolders).

You can also edit these later from the in-app **⚙ Settings** dialog.

## 4. Set the shared password

```bash
npm run set-password
```

(or `npm run set-password -- yourPassword` non-interactively). Everyone signs in with
this one password on the LAN.

## 5. Run it 24×7 as a Windows service

```bash
npm i node-windows
npm run service:install
```

This registers an auto-starting **RxMD** Windows service that launches on boot and
restarts on crash. To remove it: `npm run service:uninstall`.

**Fallbacks** if you prefer not to use node-windows:
- **NSSM** (`nssm install RxMD "C:\Program Files\nodejs\node.exe" "F:\RxMD\server\index.js"`), or
- **Task Scheduler** → *Create Task* → trigger *At log on* / *At startup*, action
  `node F:\RxMD\server\index.js`, "Run whether user is logged on or not".

## 6. Reach it from iPad / iPhone / other PCs

1. Find the clinic PC's LAN IP (`ipconfig` → IPv4 Address, e.g. `192.168.1.50`).
   The server also prints its `Network:` URLs on startup.
2. Allow the port through Windows Firewall (first run usually prompts; otherwise add an
   inbound rule for TCP `8787`).
3. On any device on the same Wi-Fi: open `http://192.168.1.50:8787`, sign in, done.
   On iPad/iPhone use Safari's *Share → Add to Home Screen* for an app-like icon.

---

## Notes & limits

- **PDF annotations** are burned into the file and saved back to the library copy on disk.
  **EPUB highlights** are stored as sidecar data in the catalog (EPUB files are never rewritten).
- **De-duplication is by file content** (SHA-256). The exact same file can't be cataloged
  twice, even across categories — it stays wherever it was first ingested.
- The catalog is a single JSON file at `data/catalog.json` on the clinic PC (durable, and
  rebuildable from disk via **⚙ Settings → Rescan now**). Back up `config.json`,
  `data/`, and your library folders.
- LAN-only by design. Do **not** port-forward this to the internet without adding HTTPS
  and stronger auth.

## Development

```bash
npm run server:dev     # API + watchers on :8787 (auto-restart)
npm run dev            # Vite client on :5173, proxies /api to :8787
```

Or run both at once: `npm run dev:all`.
