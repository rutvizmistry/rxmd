// Install/uninstall RxMD as an auto-starting Windows service (runs 24x7, restarts
// on boot/crash), using node-windows.
//   npm run service:install
//   npm run service:uninstall
// Requires: npm i node-windows  (optionalDependency; installed on the clinic PC).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let Service;
try {
  ({ Service } = require('node-windows'));
} catch {
  console.error('node-windows is not installed. Run:  npm i node-windows');
  process.exit(1);
}

const svc = new Service({
  name: 'RxMD',
  description: 'RxMD journal library server (watches folders, serves the LAN reader).',
  script: path.join(__dirname, 'index.js'),
  nodeOptions: [],
  wait: 2,
  grow: 0.5
});

const action = process.argv[2];
if (action === 'install') {
  svc.on('install', () => { console.log('✓ RxMD service installed. Starting…'); svc.start(); });
  svc.on('alreadyinstalled', () => console.log('RxMD service already installed.'));
  svc.on('start', () => console.log('✓ RxMD service started.'));
  svc.install();
} else if (action === 'uninstall') {
  svc.on('uninstall', () => console.log('✓ RxMD service uninstalled.'));
  svc.uninstall();
} else {
  console.error('Usage: node server/service.js <install|uninstall>');
  process.exit(1);
}
