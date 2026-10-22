// Copies this month's prayer timetable from IslamicFinder into data/times.json.
// Run: node scripts/update-times.mjs        (Node 18+)
// The GitHub Action in .github/workflows runs it on the 1st and 15th of each month.
import { readFile, writeFile } from "node:fs/promises";

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
if (!res.ok) throw new Error(`IslamicFinder answered ${res.status}`);
const html = await res.text();

// Month + year from the page header, e.g. "20 October, 2026"
const hdr = html.match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December),\s+(\d{4})/);
if (!hdr) throw new Error("Could not find the date on the page");
const month = ["January","February","March","April","May","June","July","August","September","October","November","December"].indexOf(hdr[2]) + 1;
const year = +hdr[3];

const days = {};
for (const row of html.split(/<tr[\s>]/i).slice(1)) {
  const text = row.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const dayM = text.match(/^(\d{2})\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/);
  const times = text.match(/\d{1,2}:\d{2}\s*[AP]M/gi);
  if (!dayM || !times || times.length < 6) continue;
  const ymd = `${year}-${String(month).padStart(2, "0")}-${dayM[1]}`;
  days[ymd] = times.slice(0, 6).map(to24);
}
const n = Object.keys(days).length;
if (n < 28) throw new Error(`Only found ${n} days — page layout may have changed; times.json left untouched`);

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
console.log(`Saved ${n} days for ${hdr[2]} ${year}.`);
