// Minimal Web Push sender (RFC 8291 "aes128gcm" encryption + RFC 8292 VAPID),
// built only on Web Crypto so it runs in Cloudflare Workers. Works with
// Chrome/Android (FCM), Firefox, Edge and Safari/iPhone (Apple push).

const enc = new TextEncoder();
const subtle = crypto.subtle;

export const b64url = {
  encode(buf) {
    const b = new Uint8Array(buf); let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(str) {
    const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
};

const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

async function hkdf(salt, ikm, info, length) {
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

// ---- payload encryption (RFC 8291) ----
export async function encryptPayload(payload, p256dh, authSecret) {
  const uaPublic = b64url.decode(p256dh);
  const auth = b64url.decode(authSecret);
  const local = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await subtle.exportKey("raw", local.publicKey));
  const uaKey = await subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(auth, ecdh, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const plain = concat(enc.encode(payload), new Uint8Array([2])); // single, last record
  const aesKey = await subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plain));

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

// ---- VAPID (RFC 8292) ----
const jwtCache = new Map();
async function vapidHeader(endpoint, vapid) {
  const aud = new URL(endpoint).origin;
  const cached = jwtCache.get(aud);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - now > 3600) return cached.header;
  const exp = now + 12 * 3600;
  const head = b64url.encode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64url.encode(enc.encode(JSON.stringify({ aud, exp, sub: vapid.subject })));
  const key = await subtle.importKey("jwk", vapid.privateJWK, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${body}`));
  const header = `vapid t=${head}.${body}.${b64url.encode(sig)}, k=${vapid.publicKey}`;
  jwtCache.set(aud, { exp, header });
  return header;
}

// Returns the HTTP response status: 201 ok, 404/410 = subscription is gone (delete it).
export async function sendPush(subscription, data, vapid, { ttl = 3600, urgency = "high", topic } = {}) {
  const body = await encryptPayload(JSON.stringify(data), subscription.keys.p256dh, subscription.keys.auth);
  const headers = {
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: await vapidHeader(subscription.endpoint, vapid)
  };
  if (topic) headers.Topic = topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  const res = await fetch(subscription.endpoint, { method: "POST", headers, body });
  return res.status;
}
