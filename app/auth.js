'use strict';

const crypto = require('crypto');

const USERNAME = process.env.AUTH_USERNAME || 'admin';

let generatedPassword = null;
let password = process.env.AUTH_PASSWORD || '';
if (!password) {
  password = crypto.randomBytes(9).toString('base64url');
  generatedPassword = password; // mostrato una volta nei log per non restare chiusi fuori
}

const SALT = crypto.randomBytes(16);
const HASH = crypto.scryptSync(password, SALT, 64);

function safeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function verify(username, pass) {
  const userOk = safeEqualStr(username || '', USERNAME);
  let passOk = false;
  try {
    passOk = crypto.timingSafeEqual(crypto.scryptSync(String(pass || ''), SALT, 64), HASH);
  } catch {
    passOk = false;
  }
  return userOk && passOk;
}

/* Limite tentativi di login: max 6 falliti in 15 minuti per IP */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 6;
const fails = new Map();

function recent(ip) {
  const now = Date.now();
  const list = (fails.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length) fails.set(ip, list);
  else fails.delete(ip);
  return list;
}
function tooMany(ip) {
  return recent(ip).length >= MAX_FAILS;
}
function noteFailure(ip) {
  const list = recent(ip);
  list.push(Date.now());
  fails.set(ip, list);
}
function clearFailures(ip) {
  fails.delete(ip);
}

module.exports = { USERNAME, verify, tooMany, noteFailure, clearFailures, generatedPassword };
