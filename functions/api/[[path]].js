// Mešita Al-huda — API on Cloudflare Pages (served at /api/*)
//
// Public:   GET  /api/state         imam's status change, announcement, reminder of the day
//           GET  /api/push-key      public key phones need to sign up for notifications
//           POST /api/subscribe     save a phone's notification address + topics
//           POST /api/unsubscribe
// Imam:     GET  /api/admin/me | /api/admin/stats
//           POST /api/admin/status | /api/admin/reminder | /api/admin/announcement
//
// Notifications are not sent from here: a row goes into the `outbox` table and the
// background worker (server/worker.js) sends it within seconds (or within a minute at most).

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const KEYS = { override: "override", announcement: "announcement", reminder: "reminder" };

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

async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Queue a notification for everyone who chose this topic ("status" or "adhan")
async function broadcast(env, topic, payload, opts = {}) {
  const id = `${topic}-${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
  await env.DB.prepare("INSERT INTO outbox (id, topic, payload, opts, created, done) VALUES (?, ?, ?, ?, ?, 0)")
    .bind(id, topic, JSON.stringify(payload), JSON.stringify(opts), new Date().toISOString()).run();
  if (env.PUSHQ) { try { await env.PUSHQ.send({ type: "kick" }); } catch (e) { /* the every-minute job will send it */ } }
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM subs WHERE ${topic === "adhan" ? "adhan" : "status"} = 1`).first();
  return r ? r.n : 0;
}

async function logAction(env, who, action) {
  await env.DB.prepare("INSERT INTO log (at, who, action) VALUES (?, ?, ?)").bind(new Date().toISOString(), who, action).run();
}

// ---- imam sign-in: personal access codes, stored hashed by the setup job ----
async function adminName(request, env) {
  const ip = request.headers.get("cf-connecting-ip") || "local";
  const now = Date.now();
  const f = await env.DB.prepare("SELECT n, since FROM fails WHERE ip = ?").bind(ip).first();
  if (f && f.n >= 10 && now - f.since < 3600000) return { error: "Too many wrong codes. Try again in an hour.", status: 429 };
  const code = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (code) {
    const salt = (await kvGet(env.DB, "admin_salt")) || "";
    const hash = await sha256hex(`${salt}:${code}`);
    const row = await env.DB.prepare("SELECT name FROM admins WHERE hash = ?").bind(hash).first();
    if (row) {
      if (f) await env.DB.prepare("DELETE FROM fails WHERE ip = ?").bind(ip).run();
      return { name: row.name };
    }
  }
  const fresh = !f || now - f.since >= 3600000;
  await env.DB.prepare("INSERT INTO fails (ip, n, since) VALUES (?, 1, ?) ON CONFLICT(ip) DO UPDATE SET n = ?, since = ?")
    .bind(ip, now, fresh ? 1 : f.n + 1, fresh ? now : f.since).run();
  return { error: "That access code is not recognised.", status: 401 };
}

const clip = (s, n) => String(s || "").trim().slice(0, n);
const isoOrNull = (s) => { if (!s) return null; const d = new Date(s); return isNaN(d) ? null : d.toISOString(); };

export async function onRequest({ request, env, params }) {
  const path = "/" + [].concat(params.path || []).join("/");
  const method = request.method;
  if (!env.DB) return json({ error: "The server is not set up yet.", setup: false }, 503);

  try {
    // ---------------- public ----------------
    if (path === "/state" && method === "GET") {
      const [override, announcement, reminder] = await Promise.all([
        kvGet(env.DB, KEYS.override), kvGet(env.DB, KEYS.announcement), kvGet(env.DB, KEYS.reminder)
      ]);
      return json({
        override: expired(override) ? null : override,
        announcement,
        reminder: expired(reminder) ? null : reminder,
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

    // ---------------- imam ----------------
    if (path.startsWith("/admin/")) {
      const auth = await adminName(request, env);
      if (auth.error) return json({ error: auth.error }, auth.status);
      const who = auth.name;

      if (path === "/admin/me" && method === "GET") return json({ name: who });

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
        const override = { mode, message, by: who, at: new Date().toISOString(), until };
        await kvSet(env.DB, KEYS.override, override);
        await logAction(env, who, `${mode === "open" ? "Opened" : "Closed"} the masjid${message ? `: ${message}` : ""}`);
        if (b.notify) {
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
