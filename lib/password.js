// Password hashing for imam / admin accounts (Web Crypto: works on Cloudflare and in Node).
// Stored as "pbkdf2$<iterations>$<salt>$<hash>". The iteration count is kept in the
// string, so it can be raised later without breaking existing passwords.
// 30,000 rounds keeps a sign-in well inside the free plan's 10 ms CPU limit.

const ITERATIONS = 30000;
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(String(password)), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(await derive(password, salt, ITERATIONS))}`;
}

export async function verifyPassword(password, stored) {
  const [kind, it, salt, hash] = String(stored || "").split("$");
  if (kind !== "pbkdf2" || !salt || !hash) return false;
  const got = new Uint8Array(await derive(password, unb64(salt), +it));
  const want = unb64(hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];   // same time whatever matches
  return diff === 0;
}

// Random strings: session tokens, temporary passwords, invite codes
export const randomToken = (bytes = 32) => b64(crypto.getRandomValues(new Uint8Array(bytes)));
const WORDS = ["noor", "sabr", "huda", "salam", "ilm", "dua", "adl", "falah", "iman", "rahma", "shukr", "taqwa", "ihsan", "barak", "amal", "sidq"];
export function friendlyCode() {
  const r = crypto.getRandomValues(new Uint32Array(3));
  const a = r[0] % WORDS.length, b = (a + 1 + (r[1] % (WORDS.length - 1))) % WORDS.length;   // two different words
  return `${WORDS[a]}-${WORDS[b]}-${1000 + (r[2] % 9000)}`;
}

export async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const USERNAME_RE = /^[a-z0-9._-]{3,30}$/;
export const MIN_PASSWORD = 8;
