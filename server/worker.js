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

// ---- every minute: put due adhan / reminder notifications into the outbox ----
async function queueDueAdhans(env, minute) {
  const S = await loadSchedule(env);
  const N = S.config.notifications || {};
  const inMinute = (d) => d && d.getTime() >= minute && d.getTime() < minute + 60000;
  const rows = [];
  for (const p of S.timeline(new Date(minute))) {
    if (inMinute(p.adhan)) {
      rows.push({
        id: `adhan-${p.ymd}-${p.key}`,
        // only prayers the imam ticked as held at the masjid mention the iqamah
        payload: p.name === "Jumu'ah"
          ? { title: "Jumu'ah — the khutbah is starting", body: `Iqamah at ${S.hm(p.iqamah)}. Come to the masjid.`, tag: "adhan", kind: "adhan", url: "./" }
          : { title: `${p.name} — adhan`, body: p.atMasjid ? `Iqamah at ${S.hm(p.iqamah)}. Come to the masjid.` : `It is time for ${p.name}.`, tag: "adhan", kind: "adhan", url: "./" },
        opts: { ttl: Math.max(120, Math.round((p.iqamah - p.adhan) / 1000) + 300), urgency: "high", topic: "adhan" }
      });
    }
    if (N.reminderBeforeAdhan && inMinute(S.addMin(p.adhan, -N.reminderBeforeAdhan))) {
      rows.push({
        id: `remind-${p.ymd}-${p.key}`,
        payload: { title: `${p.name} in ${N.reminderBeforeAdhan} minutes`, body: p.atMasjid ? `Adhan ${S.hm(p.adhan)} · Iqamah ${S.hm(p.iqamah)}. Make wudu and head to the masjid.` : `Adhan at ${S.hm(p.adhan)}.`, tag: "adhan", kind: "reminder", url: "./" },
        opts: { ttl: N.reminderBeforeAdhan * 60, urgency: "high", topic: "adhan" }
      });
    }
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
    const col = row.topic === "adhan" ? "adhan" : "status";
    const { results: subs } = await env.DB.prepare(`SELECT endpoint, p256dh, auth FROM subs WHERE ${col} = 1`).all();
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
  if (gone.length) await env.DB.batch(gone.map((ep) => env.DB.prepare("DELETE FROM subs WHERE endpoint = ?").bind(ep)));
}

async function tidy(env, minute) {
  const d = new Date(minute);
  if (d.getUTCHours() !== 2 || d.getUTCMinutes() !== 7) return;
  const cutoff = new Date(minute - 3 * 86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM outbox WHERE done = 1 AND created < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM log WHERE id NOT IN (SELECT id FROM log ORDER BY id DESC LIMIT 300)"),
    env.DB.prepare("DELETE FROM fails WHERE since < ?").bind(minute - 86400000)
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
