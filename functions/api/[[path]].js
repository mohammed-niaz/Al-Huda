// Mešita Al-huda — API on Cloudflare Pages (served at /api/*)
//
// Public:   GET  /api/state         imam's status change, announcement, reminder of the day
//           GET  /api/push-key      public key phones need to sign up for notifications
//           POST /api/subscribe     save a phone's notification address + topics
//           POST /api/unsubscribe
// Accounts: GET  /api/auth/mode       has the imam's account been set up?
//           POST /api/auth/login      username + password + this browser's device key → session
//           POST /api/auth/signup     invite code + name + username + password → waits for the imam
// Admins:   GET  /api/admin/me | /api/admin/stats
//           POST /api/admin/status | /api/admin/reminder | /api/admin/announcement | /api/admin/jamaah
//           POST /api/admin/password | /api/admin/logout
// Imam:     GET  /api/admin/people    requests, admins, their devices, alerts, invite code
//           POST /api/admin/people    approve / reject / remove / reset / allow-device / ...
//           POST /api/admin/push      this phone gets account alerts (new request, blocked device)
//
// Notifications are not sent from here: a row goes into the `outbox` table and the
// background worker (server/worker.js) sends it within seconds (or within a minute at most).

import { hashPassword, verifyPassword, randomToken, friendlyCode, sha256hex, USERNAME_RE, MIN_PASSWORD } from "../../lib/password.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const KEYS = { override: "override", announcement: "announcement", reminder: "reminder", jamaah: "jamaah" };
const JAMAAH_PRAYERS = ["fajr", "dhuhr", "asr", "maghrib", "isha"];
const PRAYER_NAMES = { fajr: "Fajr", dhuhr: "Dhuhr", asr: "Asr", maghrib: "Maghrib", isha: "Isha" };

async function kvGet(db, key) {
  const row = await db.prepare("SELECT value FROM kv WHERE key = ?").bind(key).first();
  return row ? JSON.parse(row.value) : null;
}
async function kvSet(db, key, value) {
  if (value == null) return db.prepare("DELETE FROM kv WHERE key = ?").bind(key).run();
  return db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, JSON.stringify(value)).run();
}
const expired = (v) => v && v.until && new Date(v.until) <= new Date();

// Queue a notification for everyone who chose this topic ("status", "adhan", or "all" = either one)
const topicWhere = (topic) => (topic === "all" ? "(adhan = 1 OR status = 1)" : topic === "adhan" ? "adhan = 1" : "status = 1");
async function broadcast(env, topic, payload, opts = {}) {
  const id = `${topic}-${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
  await env.DB.prepare("INSERT INTO outbox (id, topic, payload, opts, created, done) VALUES (?, ?, ?, ?, ?, 0)")
    .bind(id, topic, JSON.stringify(payload), JSON.stringify(opts), new Date().toISOString()).run();
  if (env.PUSHQ) { try { await env.PUSHQ.send({ type: "kick" }); } catch (e) { /* the every-minute job will send it */ } }
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM subs WHERE ${topicWhere(topic)}`).first();
  return r ? r.n : 0;
}

async function logAction(env, who, action) {
  await env.DB.prepare("INSERT INTO log (at, who, action) VALUES (?, ?, ?)").bind(new Date().toISOString(), who, action).run();
}

const clip = (s, n) => String(s || "").trim().slice(0, n);
const isoOrNull = (s) => { if (!s) return null; const d = new Date(s); return isNaN(d) ? null : d.toISOString(); };

// ---------------- accounts ----------------
// The imam (role "owner") is created by the setup job. Others sign up with the invite code,
// wait for his approval, and are tied to one device (the imam: two). A "device" is one browser
// on one phone: it keeps a random secret, and the server only knows its hash.
const DAY = 86400000, SESSION_MS = 30 * DAY, HOUR = 3600000;
const ipOf = (request) => request.headers.get("cf-connecting-ip") || "local";
const bearer = (request, scheme) => {
  const h = request.headers.get("authorization") || "";
  return h.toLowerCase().startsWith(scheme.toLowerCase() + " ") ? h.slice(scheme.length + 1).trim() : "";
};

// failed attempts per connection ("ip") or per account ("u:name"): 10 → blocked for an hour
async function blocked(env, key) {
  const f = await env.DB.prepare("SELECT n, since FROM fails WHERE ip = ?").bind(key).first();
  return !!(f && f.n >= 10 && Date.now() - f.since < HOUR);
}
async function failed(env, key) {
  const now = Date.now();
  const f = await env.DB.prepare("SELECT n, since FROM fails WHERE ip = ?").bind(key).first();
  const fresh = !f || now - f.since >= HOUR;
  const n = fresh ? 1 : f.n + 1;
  await env.DB.prepare("INSERT INTO fails (ip, n, since) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET n = excluded.n, since = excluded.since")
    .bind(key, n, fresh ? now : f.since).run();
  return n;
}
const cleared = (env, key) => env.DB.prepare("DELETE FROM fails WHERE ip = ?").bind(key).run();

function deviceLabel(ua) {
  ua = ua || "";
  const os = /iPad/.test(ua) ? "iPad" : /iPhone|iPod/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows"
    : /Macintosh|Mac OS/.test(ua) ? "Mac" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : "Device";
  const br = /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox|FxiOS/.test(ua) ? "Firefox"
    : /CriOS|Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : (os === "iPhone" || os === "iPad") ? "Home Screen app" : "browser";
  return `${os} · ${br}`;
}
const validDeviceKey = (k) => typeof k === "string" && k.length >= 20 && k.length <= 100;
const deviceHash = (key) => sha256hex("device:" + key);
const ownerExists = async (env) => !!(await env.DB.prepare("SELECT 1 AS x FROM users WHERE role = 'owner' LIMIT 1").first());
const publicUser = (u) => ({ name: u.name, username: u.username, role: u.role, mustChange: !!u.must_change });

// Something for the imam: kept in the alerts list, and sent to his phone(s) that have account alerts on
async function alertOwner(env, kind, { userId = null, text, label = null, keyHash = null, title }) {
  await env.DB.prepare("INSERT INTO alerts (at, kind, user_id, text, label, key_hash, done) VALUES (?, ?, ?, ?, ?, ?, 0)")
    .bind(new Date().toISOString(), kind, userId, text, label, keyHash).run();
  const id = `owner-${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
  await env.DB.prepare("INSERT INTO outbox (id, topic, payload, opts, created, done) VALUES (?, 'owner', ?, ?, ?, 0)")
    .bind(id, JSON.stringify({ title, body: text, tag: "masjid-account-" + kind, kind: "account", url: "admin.html#people" }),
      JSON.stringify({ ttl: 24 * 3600, urgency: "high" }), new Date().toISOString()).run();
  if (env.PUSHQ) { try { await env.PUSHQ.send({ type: "kick" }); } catch (e) { /* the every-minute job will send it */ } }
}

// Is this browser one of the account's devices? If there is room, it becomes one.
// If not, it is blocked and the imam is told (once per device).
async function useDevice(env, user, key, ua) {
  const keyHash = await deviceHash(key), now = new Date().toISOString(), label = deviceLabel(ua);
  const known = await env.DB.prepare("SELECT id FROM devices WHERE user_id = ? AND key_hash = ?").bind(user.id, keyHash).first();
  if (known) {
    await env.DB.prepare("UPDATE devices SET last_seen = ?, label = ? WHERE id = ?").bind(now, label, known.id).run();
    return { id: known.id };
  }
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE user_id = ?").bind(user.id).first();
  if (n < user.max_devices) {
    const id = randomToken(12);
    await env.DB.prepare("INSERT INTO devices (id, user_id, key_hash, label, created, last_seen) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, user.id, keyHash, label, now, now).run();
    return { id };
  }
  const told = await env.DB.prepare("SELECT 1 AS x FROM alerts WHERE kind = 'device' AND user_id = ? AND key_hash = ? AND done = 0").bind(user.id, keyHash).first();
  if (!told) {
    const own = user.role === "owner";
    await alertOwner(env, "device", {
      userId: user.id, label, keyHash,
      title: own ? "Your account: sign-in on a new device was blocked" : `${user.name} tried a new device`,
      text: own ? `Someone signed in to your account on ${label}. It was blocked.` : `${user.name} (${user.username}) tried to sign in on ${label}. It was blocked.`
    });
  }
  return { blocked: true };
}

async function startSession(env, user, deviceId) {
  const token = randomToken(), now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, device_id, expires, seen) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256hex(token), user.id, deviceId, now + SESSION_MS, now).run();
  return token;
}

async function forgetDevice(env, deviceId) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE device_id = ?").bind(deviceId),
    env.DB.prepare("DELETE FROM admin_subs WHERE device_id = ?").bind(deviceId),
    env.DB.prepare("DELETE FROM devices WHERE id = ?").bind(deviceId)
  ]);
}
async function forgetUser(env, userId) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM admin_subs WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM devices WHERE user_id = ?").bind(userId),
    env.DB.prepare("UPDATE alerts SET done = 1 WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId)
  ]);
}

// Who is calling /api/admin/...: a signed-in account ("Session <token>"), or — only until the
// imam's account exists — one of the old personal access codes ("Bearer <code>").
async function whoIsCalling(request, env) {
  const token = bearer(request, "Session");
  if (token) {
    const row = await env.DB.prepare(
      `SELECT s.token_hash, s.device_id, s.expires, s.seen, u.* FROM sessions s
       JOIN users u ON u.id = s.user_id JOIN devices d ON d.id = s.device_id WHERE s.token_hash = ?`
    ).bind(await sha256hex(token)).first();
    const now = Date.now();
    if (!row || row.expires < now || row.status !== "active") return { error: "Please sign in again.", status: 401 };
    if (now - (row.seen || 0) > HOUR) {               // keep the session alive while it is used
      await env.DB.batch([
        env.DB.prepare("UPDATE sessions SET seen = ?, expires = ? WHERE token_hash = ?").bind(now, now + SESSION_MS, row.token_hash),
        env.DB.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").bind(new Date(now).toISOString(), row.device_id)
      ]);
    }
    return { name: row.name, user: row, deviceId: row.device_id, tokenHash: row.token_hash };
  }
  // old access codes
  const ip = ipOf(request);
  if (await ownerExists(env)) return { error: "Please sign in with your username and password.", status: 401 };
  if (await blocked(env, ip)) return { error: "Too many wrong codes. Try again in an hour.", status: 429 };
  const code = bearer(request, "Bearer");
  if (code) {
    const salt = (await kvGet(env.DB, "admin_salt")) || "";
    const row = await env.DB.prepare("SELECT name FROM admins WHERE hash = ?").bind(await sha256hex(`${salt}:${code}`)).first();
    if (row) { await cleared(env, ip); return { name: row.name, legacy: true }; }
  }
  await failed(env, ip);
  return { error: "That access code is not recognised.", status: 401 };
}

async function accountRoutes(path, method, request, env) {
  if (path === "/auth/mode" && method === "GET") return json({ accounts: await ownerExists(env) });

  if (path === "/auth/login" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const ip = ipOf(request), username = clip(b.username, 40).toLowerCase();
    if (!validDeviceKey(b.device)) return json({ error: "This browser can't be identified. Turn off private browsing and try again." }, 400);
    if (await blocked(env, ip) || (username && await blocked(env, "u:" + username)))
      return json({ error: "Too many wrong passwords. Try again in an hour." }, 429);
    const user = username ? await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first() : null;
    if (!user || !(await verifyPassword(String(b.password || ""), user.pass))) {
      await failed(env, ip);
      if (user && (await failed(env, "u:" + username)) === 10)
        await alertOwner(env, "locked", { userId: user.id, title: "Too many wrong passwords", text: `${user.name}'s account (${user.username}) had 10 wrong passwords and is locked for an hour.` });
      return json({ error: "Wrong username or password." }, 401);
    }
    await cleared(env, ip); await cleared(env, "u:" + username);
    if (user.status !== "active") return json({ error: "Your request is waiting for the imam's approval.", pending: true }, 403);
    const dev = await useDevice(env, user, b.device, request.headers.get("user-agent"));
    if (dev.blocked) return json({
      error: user.role === "owner"
        ? "Your account is already used on two devices. Remove one of them in People, from a device you are signed in on."
        : "Your account is tied to another device. The imam has been told, and he can allow this one.",
      device: true
    }, 403);
    return json({ token: await startSession(env, user, dev.id), user: publicUser(user) });
  }

  if (path === "/auth/signup" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const ip = ipOf(request);
    if (await blocked(env, ip)) return json({ error: "Too many attempts. Try again in an hour." }, 429);
    const invite = await kvGet(env.DB, "invite");
    if (!invite || !(await ownerExists(env))) return json({ error: "Sign-up isn't open yet." }, 400);
    if (String(b.invite || "").trim().toLowerCase() !== String(invite).toLowerCase()) {
      await failed(env, ip);
      return json({ error: "That invite code isn't right. Ask the imam for it." }, 400);
    }
    const name = clip(b.name, 60), username = clip(b.username, 40).toLowerCase(), password = String(b.password || "");
    if (name.length < 2) return json({ error: "Write your name." }, 400);
    if (!USERNAME_RE.test(username)) return json({ error: "The username needs 3–30 letters or numbers (dots, dashes and _ are fine, no spaces)." }, 400);
    if (password.length < MIN_PASSWORD) return json({ error: `The password needs at least ${MIN_PASSWORD} characters.` }, 400);
    if (!validDeviceKey(b.device)) return json({ error: "This browser can't be identified. Turn off private browsing and try again." }, 400);
    if (await env.DB.prepare("SELECT 1 AS x FROM users WHERE username = ?").bind(username).first()) return json({ error: "That username is taken. Choose another one." }, 400);
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'").first();
    if (n >= 20) return json({ error: "Too many requests are waiting. Ask the imam to look at them first." }, 429);
    const now = new Date().toISOString();
    const res = await env.DB.prepare("INSERT INTO users (username, name, pass, role, status, must_change, max_devices, created) VALUES (?, ?, ?, 'admin', 'pending', 0, 1, ?)")
      .bind(username, name, await hashPassword(password), now).run();
    const userId = res.meta.last_row_id;
    // the device they signed up on becomes their device
    await env.DB.prepare("INSERT INTO devices (id, user_id, key_hash, label, created, last_seen) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(randomToken(12), userId, await deviceHash(b.device), deviceLabel(request.headers.get("user-agent")), now, now).run();
    await alertOwner(env, "signup", { userId, title: "New request for admin access", text: `${name} (${username}) asked for access to Imam controls.` });
    return json({ ok: true, pending: true });
  }
  return null;
}

// Imam only: people, their devices, alerts, the invite code
async function peopleRoutes(path, method, request, env, me, deviceId) {
  if (path === "/admin/people" && method === "GET") {
    const [users, devices, alerts, invite, push] = await Promise.all([
      env.DB.prepare("SELECT id, username, name, role, status, created, approved_at, approved_by, max_devices FROM users ORDER BY role = 'owner' DESC, name").all(),
      env.DB.prepare("SELECT id, user_id, label, created, last_seen FROM devices ORDER BY created").all(),
      env.DB.prepare("SELECT id, at, kind, user_id, text, label FROM alerts WHERE done = 0 ORDER BY id DESC LIMIT 50").all(),
      kvGet(env.DB, "invite"),
      env.DB.prepare("SELECT COUNT(*) AS n FROM admin_subs WHERE device_id = ?").bind(deviceId).first()
    ]);
    const byUser = {};
    for (const d of devices.results) (byUser[d.user_id] ||= []).push({ id: d.id, label: d.label, created: d.created, lastSeen: d.last_seen, thisDevice: d.id === deviceId });
    return json({
      people: users.results.map((u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, status: u.status, created: u.created,
        approvedAt: u.approved_at, approvedBy: u.approved_by, maxDevices: u.max_devices, devices: byUser[u.id] || [] })),
      alerts: alerts.results, invite, alertsOnThisDevice: push.n > 0
    });
  }

  if (path === "/admin/people" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const now = new Date().toISOString();
    const user = b.user ? await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(+b.user).first() : null;
    const notOwner = () => user && user.role !== "owner";
    switch (b.action) {
      case "approve":
        if (!user || user.status !== "pending") return json({ error: "That request is no longer waiting." }, 400);
        await env.DB.batch([
          env.DB.prepare("UPDATE users SET status = 'active', approved_at = ?, approved_by = ? WHERE id = ?").bind(now, me.name, user.id),
          env.DB.prepare("UPDATE alerts SET done = 1 WHERE user_id = ? AND kind = 'signup'").bind(user.id)
        ]);
        await logAction(env, me.name, `Gave access to ${user.name} (${user.username})`);
        return json({ ok: true });
      case "reject":
        if (!user || user.status !== "pending") return json({ error: "That request is no longer waiting." }, 400);
        await forgetUser(env, user.id);
        await logAction(env, me.name, `Turned down the request from ${user.name} (${user.username})`);
        return json({ ok: true });
      case "remove":
        if (!notOwner()) return json({ error: "That person can't be removed." }, 400);
        await forgetUser(env, user.id);
        await logAction(env, me.name, `Removed ${user.name} (${user.username})`);
        return json({ ok: true });
      case "reset": {
        if (!notOwner() || user.status !== "active") return json({ error: "That password can't be reset here." }, 400);
        const password = friendlyCode();
        await env.DB.batch([
          env.DB.prepare("UPDATE users SET pass = ?, must_change = 1 WHERE id = ?").bind(await hashPassword(password), user.id),
          env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id)
        ]);
        await cleared(env, "u:" + user.username);
        await logAction(env, me.name, `Reset the password of ${user.name}`);
        return json({ ok: true, password });
      }
      case "remove-device": {
        const d = await env.DB.prepare("SELECT d.id, d.label, u.name FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = ?").bind(String(b.device || "")).first();
        if (!d) return json({ error: "That device is already gone." }, 400);
        if (d.id === deviceId) return json({ error: "You are using this device now. Remove it from your other device." }, 400);
        await forgetDevice(env, d.id);
        await logAction(env, me.name, `Removed ${d.label} from ${d.name}'s account`);
        return json({ ok: true });
      }
      case "allow-device": {
        const a = await env.DB.prepare("SELECT * FROM alerts WHERE id = ? AND kind = 'device' AND done = 0").bind(+b.alert).first();
        const u = a && await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(a.user_id).first();
        if (!u) return json({ error: "That request is no longer open." }, 400);
        // make room: the oldest device goes (for the imam's own account, never the one he is using)
        const { results: devs } = await env.DB.prepare("SELECT id FROM devices WHERE user_id = ? AND id != ? ORDER BY last_seen").bind(u.id, deviceId).all();
        const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE user_id = ?").bind(u.id).first();
        for (let i = 0, left = n; left >= u.max_devices && i < devs.length; i++, left--) await forgetDevice(env, devs[i].id);
        await env.DB.batch([
          env.DB.prepare("INSERT INTO devices (id, user_id, key_hash, label, created, last_seen) VALUES (?, ?, ?, ?, ?, ?)").bind(randomToken(12), u.id, a.key_hash, a.label, now, now),
          env.DB.prepare("UPDATE alerts SET done = 1 WHERE id = ?").bind(a.id)
        ]);
        await logAction(env, me.name, `Allowed ${a.label} for ${u.name}`);
        return json({ ok: true });
      }
      case "dismiss":
        await env.DB.prepare("UPDATE alerts SET done = 1 WHERE id = ?").bind(+b.alert).run();
        return json({ ok: true });
      case "new-invite": {
        const invite = friendlyCode();
        await kvSet(env.DB, "invite", invite);
        await logAction(env, me.name, "Made a new invite code");
        return json({ ok: true, invite });
      }
    }
    return json({ error: "Unknown action" }, 400);
  }

  // account alerts on this phone
  if (path === "/admin/push" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (b.off) { await env.DB.prepare("DELETE FROM admin_subs WHERE device_id = ?").bind(deviceId).run(); return json({ ok: true }); }
    const s = b.subscription;
    if (!s || typeof s.endpoint !== "string" || !s.endpoint.startsWith("https://") || s.endpoint.length > 1000 ||
        !s.keys || typeof s.keys.p256dh !== "string" || typeof s.keys.auth !== "string") return json({ error: "Invalid subscription" }, 400);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM admin_subs WHERE device_id = ? AND endpoint != ?").bind(deviceId, s.endpoint),
      env.DB.prepare(`INSERT INTO admin_subs (endpoint, p256dh, auth, user_id, device_id) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user_id = excluded.user_id, device_id = excluded.device_id`)
        .bind(s.endpoint, s.keys.p256dh, s.keys.auth, me.id, deviceId)
    ]);
    return json({ ok: true });
  }
  return null;
}


export async function onRequest({ request, env, params }) {
  const path = "/" + [].concat(params.path || []).join("/");
  const method = request.method;
  if (!env.DB) return json({ error: "The server is not set up yet.", setup: false }, 503);

  try {
    // ---------------- public ----------------
    if (path === "/state" && method === "GET") {
      const [override, announcement, reminder, jamaah] = await Promise.all([
        kvGet(env.DB, KEYS.override), kvGet(env.DB, KEYS.announcement), kvGet(env.DB, KEYS.reminder), kvGet(env.DB, KEYS.jamaah)
      ]);
      return json({
        override: expired(override) ? null : override,
        announcement,
        reminder: expired(reminder) ? null : reminder,
        jamaah,
        serverTime: new Date().toISOString()
      });
    }

    if (path === "/push-key" && method === "GET") {
      const v = await kvGet(env.DB, "vapid");
      return json({ publicKey: v ? v.publicKey : null });
    }

    if (path === "/subscribe" && method === "POST") {
      const b = await request.json().catch(() => null);
      const s = b && b.subscription;
      if (!s || typeof s.endpoint !== "string" || !s.endpoint.startsWith("https://") || s.endpoint.length > 1000 ||
          !s.keys || typeof s.keys.p256dh !== "string" || typeof s.keys.auth !== "string") {
        return json({ error: "Invalid subscription" }, 400);
      }
      const t = b.topics || {};
      await env.DB.prepare(
        `INSERT INTO subs (endpoint, p256dh, auth, adhan, status, created) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, adhan = excluded.adhan, status = excluded.status`
      ).bind(s.endpoint, s.keys.p256dh, s.keys.auth, t.adhan === false ? 0 : 1, t.status === false ? 0 : 1, new Date().toISOString()).run();
      return json({ ok: true });
    }

    if (path === "/unsubscribe" && method === "POST") {
      const b = await request.json().catch(() => null);
      if (b && typeof b.endpoint === "string") await env.DB.prepare("DELETE FROM subs WHERE endpoint = ?").bind(b.endpoint).run();
      return json({ ok: true });
    }

    // ---------------- accounts ----------------
    if (path.startsWith("/auth/")) {
      const res = await accountRoutes(path, method, request, env);
      if (res) return res;
    }

    // ---------------- imam and admins ----------------
    if (path.startsWith("/admin/")) {
      const auth = await whoIsCalling(request, env);
      if (auth.error) return json({ error: auth.error }, auth.status);
      const who = auth.name, me = auth.user;

      if (path === "/admin/me" && method === "GET")
        return json(me ? { ...publicUser(me), legacy: false } : { name: who, role: "admin", legacy: true });

      if (path === "/admin/logout" && method === "POST") {
        if (auth.tokenHash) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(auth.tokenHash).run();
        return json({ ok: true });
      }

      if (path === "/admin/password" && method === "POST") {
        if (!me) return json({ error: "Access codes have no password." }, 400);
        const b = await request.json().catch(() => ({}));
        const ip = ipOf(request);
        if (await blocked(env, ip)) return json({ error: "Too many wrong passwords. Try again in an hour." }, 429);
        if (!(await verifyPassword(String(b.current || ""), me.pass))) { await failed(env, ip); return json({ error: "Your current password isn't right." }, 400); }
        const next = String(b.next || "");
        if (next.length < MIN_PASSWORD) return json({ error: `The new password needs at least ${MIN_PASSWORD} characters.` }, 400);
        if (next === String(b.current)) return json({ error: "Choose a password different from the old one." }, 400);
        await env.DB.batch([
          env.DB.prepare("UPDATE users SET pass = ?, must_change = 0 WHERE id = ?").bind(await hashPassword(next), me.id),
          env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(me.id, auth.tokenHash)   // signed out elsewhere
        ]);
        await logAction(env, who, "Changed their password");
        return json({ ok: true });
      }

      if (me && me.must_change) return json({ error: "Choose a new password first.", mustChange: true }, 403);

      if (path === "/admin/people" || path === "/admin/push") {
        if (!me || me.role !== "owner") return json({ error: "Only the imam can do this." }, 403);
        const res = await peopleRoutes(path, method, request, env, me, auth.deviceId);
        if (res) return res;
      }

      if (path === "/admin/stats" && method === "GET") {
        const r = await env.DB.prepare("SELECT COUNT(*) AS total, SUM(adhan) AS adhan, SUM(status) AS status FROM subs").first();
        const { results } = await env.DB.prepare("SELECT at, who, action FROM log ORDER BY id DESC LIMIT 10").all();
        return json({ subscribers: r.total || 0, adhan: r.adhan || 0, status: r.status || 0, log: results });
      }

      if (path === "/admin/status" && method === "POST") {
        const b = await request.json().catch(() => ({}));
        const mode = ["open", "closed", "auto"].includes(b.mode) ? b.mode : null;
        if (!mode) return json({ error: "Choose open, closed or back to the timetable." }, 400);
        const message = clip(b.message, 140);
        let notified = 0;
        if (mode === "auto") {
          await kvSet(env.DB, KEYS.override, null);
          await logAction(env, who, "Back to the timetable");
          if (b.notify && b.title) notified = await broadcast(env, "status", { title: clip(b.title, 80), body: clip(b.body, 180), tag: "masjid-status", kind: "status", url: "./" }, { ttl: 1800 });
          return json({ ok: true, override: null, notified });
        }
        const until = isoOrNull(b.until);
        // `from` (open only): the imam set the opening time; the masjid stays closed until then. Never notified.
        const from = mode === "open" ? isoOrNull(b.from) : null;
        const override = { mode, message, by: who, at: new Date().toISOString(), until, ...(from ? { from } : {}) };
        await kvSet(env.DB, KEYS.override, override);
        await logAction(env, who, from ? `Set the opening time: ${clip(b.fromLabel, 20) || from}` : `${mode === "open" ? "Opened" : "Closed"} the masjid${message ? `: ${message}` : ""}`);
        if (b.notify && !from) {
          notified = await broadcast(env, "status", {
            title: clip(b.title, 80) || (mode === "open" ? "The masjid is now open" : "The masjid is now closed"),
            body: message || clip(b.body, 180), tag: "masjid-status", kind: "status", url: "./"
          }, { ttl: 1800 });
        }
        return json({ ok: true, override, notified });
      }

      if (path === "/admin/reminder" && method === "POST") {
        const b = await request.json().catch(() => ({}));
        const r = b.reminder;
        if (!r) {
          await kvSet(env.DB, KEYS.reminder, null);
          await logAction(env, who, "Reminder of the day back to automatic");
          return json({ ok: true, reminder: null });
        }
        const reminder = {
          english: clip(r.english, 1200), arabic: clip(r.arabic, 1200), source: clip(r.source, 120),
          ref: clip(r.ref, 20), kind: r.ref ? "verse" : "custom",
          by: who, at: new Date().toISOString(), until: isoOrNull(b.until)
        };
        if (!reminder.english && !reminder.arabic) return json({ error: "Write the reminder text first." }, 400);
        await kvSet(env.DB, KEYS.reminder, reminder);
        await logAction(env, who, `Reminder: ${(reminder.english || reminder.arabic).slice(0, 60)}${reminder.source ? ` (${reminder.source})` : ""}`);
        let notified = 0;
        if (b.notify) {
          const text = reminder.english || reminder.arabic;
          notified = await broadcast(env, "status", {
            title: "Reminder of the day",
            body: (text.length > 170 ? text.slice(0, 167) + "…" : text) + (reminder.source ? ` — ${reminder.source}` : ""),
            tag: "masjid-reminder", kind: "reminder-of-day", url: "./"
          }, { ttl: 6 * 3600, urgency: "normal" });
        }
        return json({ ok: true, reminder, notified });
      }

      // which prayers are held at the masjid, each with an optional fixed iqamah ("HH:MM"; empty = config.js rule)
      if (path === "/admin/jamaah" && method === "POST") {
        const b = await request.json().catch(() => ({}));
        const prayers = {};
        for (const k of JAMAAH_PRAYERS) {
          const p = (b.prayers || {})[k] || {};
          const iqamah = /^([01]\d|2[0-3]):[0-5]\d$/.test(p.iqamah || "") ? p.iqamah : "";
          prayers[k] = { on: !!p.on, iqamah };
        }
        // what changed, worked out on the imam's page in plain words, e.g. "Dhuhr iqamah: 13:00 → 13:30";
        // kept with the setting so the app can mark it for the rest of the day
        const prev = await kvGet(env.DB, KEYS.jamaah);
        const changes = (Array.isArray(b.changes) ? b.changes : []).slice(0, 5)
          .filter((c) => c && JAMAAH_PRAYERS.includes(c.key))
          .map((c) => ({ key: c.key, text: clip(c.text, 120) }));
        const now = new Date().toISOString();
        const jamaah = {
          prayers, by: who, at: now,
          changes: changes.length ? changes : (prev && prev.changes) || [],
          changedAt: changes.length ? now : (prev && prev.changedAt) || null
        };
        await kvSet(env.DB, KEYS.jamaah, jamaah);
        const held = JAMAAH_PRAYERS.filter((k) => prayers[k].on).map((k) => PRAYER_NAMES[k] + (prayers[k].iqamah ? ` ${prayers[k].iqamah}` : ""));
        await logAction(env, who, changes.length ? `Changed: ${changes.map((c) => c.text).join("; ")}` : held.length ? `Prayers at the masjid: ${held.join(", ")}` : "No prayers at the masjid");
        // time-sensitive: goes to everyone who has adhan OR news notifications on
        let notified = 0;
        if (changes.length && b.notify) {
          notified = await broadcast(env, "all", {
            title: changes.length === 1 ? "Iqamah time changed" : "Prayer times at the masjid changed",
            body: changes.map((c) => c.text).join(" · "), tag: "masjid-iqamah", kind: "iqamah-change", url: "./"
          }, { ttl: 12 * 3600, urgency: "high" });
        }
        return json({ ok: true, jamaah, notified });
      }

      if (path === "/admin/announcement" && method === "POST") {
        const b = await request.json().catch(() => ({}));
        // English / Slovak / Arabic; `text` (first filled language) keeps older app versions working
        const langs = { en: clip(b.en ?? b.text, 600), sk: clip(b.sk, 600), ar: clip(b.ar, 600) };
        const text = langs.en || langs.sk || langs.ar;
        await kvSet(env.DB, KEYS.announcement, text ? { text, ...langs, by: who, at: new Date().toISOString() } : null);
        await logAction(env, who, text ? `Announcement: ${text}` : "Removed the announcement");
        let notified = 0;
        if (text && b.notify) notified = await broadcast(env, "status", { title: "Mešita Al-huda", body: text, tag: "masjid-news", kind: "news", url: "./" }, { ttl: 6 * 3600, urgency: "normal" });
        return json({ ok: true, notified });
      }
    }
    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: "Server error: " + (e && e.message ? e.message : e) }, 500);
  }
}
