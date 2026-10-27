// Copies this month's prayer timetable from IslamicFinder into data/times.json.
// Run: node scripts/update-times.mjs        (Node 18+)
// The GitHub Action in .github/workflows runs it on the 1st and 15th of each month.
import { readFile, writeFile } from "node:fs/promises";

// Show the real reason in GitHub's red error box (the "annotations" at the top of a failed run)
const fail = (msg) => { console.log("::error title=Timetable update failed::" + String(msg).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")); process.exit(1); };
process.on("uncaughtException", (e) => fail(e && e.message ? e.message : e));
process.on("unhandledRejection", (e) => fail(e && e.message ? e.message : e));
const peek = (t) => String(t).replace(/\s+/g, " ").slice(0, 220);


const URL = "https://www.islamicfinder.org/world/slovak-republic/46626508/kosice-prayer-times/";
const FILE = new globalThis.URL("../data/times.json", import.meta.url);
const ORDER = ["fajr", "sunrise", "dhuhr", "asr", "maghrib", "isha"];

const to24 = (t) => {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!m) throw new Error("Bad time " + t);
  let h = +m[1] % 12; if (m[3].toUpperCase() === "PM") h += 12;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
};

const res = await fetch(URL, { headers: { "User-Agent": "MasjidKosiceTimetable/1.0 (monthly update)" } });
const html = await res.text();
console.log(`IslamicFinder answered ${res.status}, ${res.headers.get("content-type")}, ${html.length} characters, ${(html.match(/<tr[\s>]/gi) || []).length} table rows`);
if (!res.ok) throw new Error(`IslamicFinder answered ${res.status}. Start of reply: ${peek(html)}`);

// --- Read the day rows from the table -------------------------------------
// Each row looks like: "01 Thu | 20 | Thu | 04:49 AM | 06:32 AM | 12:27 PM | 03:36 PM | 06:18 PM | 07:55 PM | 01:17 AM"
// (day + weekday, hijri day, weekday, Fajr, Sunrise, Dhuhr, Asr, Maghrib, Isha, Qiyam)
const clean = (t) => t.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;|&#xa0;/gi, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const rows = new Map();   // day number -> { wd, times }
const samples = [];
const body = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
for (const row of body.split(/<tr\b[^>]*>/i).slice(1)) {
  const text = clean(row);
  const times = text.match(/\d{1,2}:\d{2}\s*[AP]M/gi);
  if (times && samples.length < 3) samples.push(text.slice(0, 160));
  const m = text.match(/^(\d{1,2})\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/i);
  if (!m || !times || times.length < 6) continue;
  const day = +m[1];
  if (day < 1 || day > 31) continue;
  if (!rows.has(day)) rows.set(day, { wd: m[2].slice(0, 1).toUpperCase() + m[2].slice(1, 3).toLowerCase(), times: times.slice(0, 6).map(to24) });
}

// --- Work out which month the table is for -----------------------------------
// Don't rely on a date line in the page. Try this month, last month and next month (Košice time)
// and take the one where the number of days AND every weekday label match the calendar.
const today = process.env.TODAY ? new Date(process.env.TODAY) : new Date();
const tp = {}; new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bratislava", year: "numeric", month: "2-digit" })
  .formatToParts(today).forEach((x) => (tp[x.type] = x.value));
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const candidates = [0, -1, 1].map((d) => {
  let y = +tp.year, m = +tp.month + d;
  if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; }
  return { y, m };
});
const pick = candidates.find(({ y, m }) => rows.size === daysIn(y, m) &&
  [...rows].every(([d, r]) => WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] === r.wd));
if (!pick) {
  throw new Error(`Found ${rows.size} day rows but they do not match this, last or next month ` +
    `(${candidates.map((c) => `${c.y}-${String(c.m).padStart(2, "0")}`).join(", ")}). ` +
    `Weekdays seen: ${[...rows].slice(0, 4).map(([d, r]) => d + " " + r.wd).join(", ")}. Sample rows: ${samples.join(" || ")}`);
}
const { y: year, m: month } = pick;
const monthName = new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
const days = {};
for (const [d, r] of rows) days[`${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`] = r.times;
const n = rows.size;

let data = { days: {} };
try { data = JSON.parse(await readFile(FILE, "utf8")); } catch {}
// keep the last 2 months of history, add the new month
const cutoff = new Date(Date.UTC(year, month - 3, 1)).toISOString().slice(0, 10);
for (const k of Object.keys(data.days || {})) if (k < cutoff) delete data.days[k];
data = {
  source: URL,
  method: "Muslim World League (Fajr 18°, Isha 17°), Shafi Asr",
  updated: new Date().toISOString().slice(0, 10),
  order: ORDER,
  days: { ...(data.days || {}), ...days }
};
await writeFile(FILE, JSON.stringify(data, null, 1) + "\n");
console.log(`Saved ${n} days for ${monthName} ${year}.`);
