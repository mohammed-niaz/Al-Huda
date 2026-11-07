// Mešita Al-huda — notification worker (Cloudflare Worker, no public address)
//
// Every minute: works out whether an adhan (or the reminder before it) is due,
// and sends any notification the imam queued from the imam page.
// Queue: delivers notifications in small batches so any number of phones works
// within the free plan's limits.
//
// Reads config.js and data/times.json straight from the live site, so editing
// config.js on GitHub is all it takes.

import JSON5 from "json5";
import * as adhan from "adhan";
import { createSchedule } from "../lib/schedule.js";
import { sendPush } from "../lib/webpush.js";

const BATCH = 15;           // pushes per queue message (keeps each run well under the free CPU limit)

async function kvGet(db, key) {
  const row = await db.prepare("SELECT value FROM kv WHERE key = ?").bind(key).first();
  return row ? JSON.parse(row.value) : null;
}

async function loadSchedule(env) {
  const base = env.SITE_URL.replace(/\/$/, "");
  const bust = `?m=${Math.floor(Date.now() / 60000)}`;
  const [cfgRes, tRes] = await Promise.all([fetch(`${base}/config.js${bust}`), fetch(`${base}/data/times.json${bust}`)]);
  if (!cfgRes.ok) throw new Error(`Could not load config.js from the site (${cfgRes.status})`);
  const src = await cfgRes.text();
  const config = JSON5.parse(src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1));
  let table = null;
  try { if (tRes.ok) table = await tRes.json(); } catch (e) { table = null; }
  const jamaah = await kvGet(env.DB, "jamaah");
  return createSchedule({ config, table, adhan, jamaah });
}

// ---- every minute: put due adhan notifications into the outbox ----
// One per prayer, at the adhan. Open/closed, news and the reminder of the day are sent by the imam.
async function queueDueAdhans(env, minute) {
  const S = await loadSchedule(env);
  const inMinute = (d) => d && d.getTime() >= minute && d.getTime() < minute + 60000;
  const rows = [];
  for (const p of S.timeline(new Date(minute))) {
    if (!inMinute(p.adhan)) continue;
    // only prayers the imam ticked as held at the masjid have an iqamah
    const mins = Math.round((p.iqamah - p.adhan) / 60000);
    const body = !p.atMasjid ? "Time to pray."
      : mins > 0 ? `Iqamah is in ${mins} minute${mins === 1 ? "" : "s"}.` : "The jama'ah is standing now.";
    rows.push({
      id: `adhan-${p.ymd}-${p.key}`,
      payload: { title: `It's time for ${p.name}`, body, tag: "adhan", kind: "adhan", url: "./" },
      opts: { ttl: Math.max(120, Math.round((p.iqamah - p.adhan) / 1000) + 300), urgency: "high", topic: "adhan" }
    });
  }
  for (const r of rows) {
    // INSERT OR IGNORE: the id is fixed per prayer, so it is never sent twice
    await env.DB.prepare("INSERT OR IGNORE INTO outbox (id, topic, payload, opts, created, done) VALUES (?, 'adhan', ?, ?, ?, 0)")
      .bind(r.id, JSON.stringify(r.payload), JSON.stringify(r.opts), new Date().toISOString()).run();
  }
  return rows.length;
}

// ---- take waiting notifications from the outbox and split them into batches ----
async function drainOutbox(env) {
  const { results } = await env.DB.prepare("SELECT id, topic, payload, opts FROM outbox WHERE done = 0 ORDER BY created LIMIT 5").all();
  let batches = 0;
  for (const row of results) {
    const claim = await env.DB.prepare("UPDATE outbox SET done = 1 WHERE id = ? AND done = 0").bind(row.id).run();
    if (!claim.meta || claim.meta.changes !== 1) continue;      // another run already took it
    // "owner": account alerts (new request, blocked device) go only to the imam's phones
    const sql = row.topic === "owner"
      ? "SELECT a.endpoint, a.p256dh, a.auth FROM admin_subs a JOIN users u ON u.id = a.user_id WHERE u.role = 'owner'"
      : `SELECT endpoint, p256dh, auth FROM subs WHERE ${row.topic === "all" ? "(adhan = 1 OR status = 1)" : row.topic === "adhan" ? "adhan = 1" : row.topic === "status" ? "status = 1" : "0"}`;
    const { results: subs } = await env.DB.prepare(sql).all();
    const payload = JSON.parse(row.payload), opts = JSON.parse(row.opts || "{}");
    const msgs = [];
    for (let i = 0; i < subs.length; i += BATCH) {
      msgs.push({ body: { type: "send", payload, opts, subs: subs.slice(i, i + BATCH).map((s) => ({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } })) } });
    }
    for (let i = 0; i < msgs.length; i += 100) await env.PUSHQ.sendBatch(msgs.slice(i, i + 100));
    batches += msgs.length;
  }
  return batches;
}

// ---- send one batch ----
async function deliver(env, { payload, opts, subs }) {
  const vapid = await kvGet(env.DB, "vapid");
  if (!vapid) throw new Error("Notification keys are missing — run the 'Set up server' job again.");
  const gone = [];
  await Promise.all(subs.map(async (s) => {
    try {
      const status = await sendPush(s, payload, vapid, opts);
      if (status === 404 || status === 410) gone.push(s.endpoint);   // phone uninstalled / turned alerts off
    } catch (e) { /* one bad address must not stop the others */ }
  }));
  if (gone.length) await env.DB.batch(gone.flatMap((ep) => [
    env.DB.prepare("DELETE FROM subs WHERE endpoint = ?").bind(ep),
    env.DB.prepare("DELETE FROM admin_subs WHERE endpoint = ?").bind(ep)
  ]));
}

async function tidy(env, minute) {
  const d = new Date(minute);
  if (d.getUTCHours() !== 2 || d.getUTCMinutes() !== 7) return;
  const cutoff = new Date(minute - 3 * 86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM outbox WHERE done = 1 AND created < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM log WHERE id NOT IN (SELECT id FROM log ORDER BY id DESC LIMIT 300)"),
    env.DB.prepare("DELETE FROM fails WHERE since < ?").bind(minute - 86400000),
    env.DB.prepare("DELETE FROM sessions WHERE expires < ?").bind(minute),
    env.DB.prepare("DELETE FROM alerts WHERE done = 1 AND id NOT IN (SELECT id FROM alerts ORDER BY id DESC LIMIT 200)")
  ]);
}

export async function everyMinute(env, scheduledTime) {
  const minute = Math.floor(scheduledTime / 60000) * 60000;
  let due = 0;
  try { due = await queueDueAdhans(env, minute); }
  catch (e) { console.error("adhan check failed:", e && e.stack ? e.stack : e); }
  const batches = await drainOutbox(env);
  await tidy(env, minute);
  return { due, batches };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(everyMinute(env, event.scheduledTime).catch((e) => console.error("every-minute job failed:", e && e.stack ? e.stack : e)));
  },
  async queue(batch, env) {
    for (const msg of batch.messages) {
      const b = msg.body || {};
      if (b.type === "kick") await drainOutbox(env);
      else if (b.type === "send") await deliver(env, b);
      msg.ack();
    }
  },
  async fetch(request, env) {
    // No public address in production. Local testing only: run the every-minute job for any time.
    const url = new URL(request.url);
    if (env.DEV === "1" && url.pathname === "/dev/cron") {
      return Response.json(await everyMinute(env, Date.parse(url.searchParams.get("t"))));
    }
    return new Response("Not found", { status: 404 });
  }
};
