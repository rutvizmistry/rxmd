// Set (or change) the shared LAN password.
//   npm run set-password              → prompts for a password
//   npm run set-password -- mypass    → sets it non-interactively
import readline from 'node:readline';
import { loadConfig, saveConfig } from './config.js';
import { hashPassword } from './auth.js';

function ask(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); resolve(a); });
  });
}

const arg = process.argv[2];
const pw = arg || (await ask('New RxMD shared password: '));
if (!pw || pw.length < 4) {
  console.error('Password must be at least 4 characters.');
  process.exit(1);
}
const cfg = loadConfig();
cfg.passwordHash = hashPassword(pw);
saveConfig(cfg);
console.log('✓ Password updated. Restart the server for it to take effect on new logins.');
process.exit(0);
