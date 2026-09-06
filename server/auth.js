// Shared-password auth. The clinic sets one password; any device on the LAN logs
// in with it and receives a signed session cookie (HMAC over an expiry, keyed by
// the config's sessionSecret — no server-side session store needed).

import crypto from 'node:crypto';
import { loadConfig } from './config.js';

const COOKIE = 'rxmd_session';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ---- password hashing (scrypt) ----
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
export function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = crypto.scryptSync(pw, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// ---- signed session token ----
function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verify(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function issueSessionCookie(res) {
  const cfg = loadConfig();
  const token = sign({ exp: Date.now() + MAX_AGE_MS }, cfg.sessionSecret);
  // Not "Secure" so it works over plain http on the LAN; SameSite=Lax is fine
  // for a same-origin SPA. HttpOnly keeps it out of page JS.
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(MAX_AGE_MS / 1000)}`);
}
export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

export function isAuthed(req) {
  const cfg = loadConfig();
  // If no password is configured yet, the app is open (first-run) so the admin
  // can reach settings and set one.
  if (!cfg.passwordHash) return true;
  const token = parseCookies(req)[COOKIE];
  return !!verify(token, cfg.sessionSecret);
}

// Express middleware guarding the API.
export function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'auth required' });
}
