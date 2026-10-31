// Prayer schedule and opening hours, shared by the imam page (admin.html) and the
// notification worker (server/worker.js). Mirrors the logic inside index.html, so the
// app, the imam page and the notifications always agree.
//
//   const S = createSchedule({ config: window.MASJID_CONFIG, table: timesJson, adhan, jamaah });
//
// `jamaah` is the imam's choice of prayers held at the masjid (from the server):
//   { prayers: { dhuhr: { on: true, iqamah: "13:30" }, ... } }   iqamah "" = the config.js rule.
// Each prayer gets `atMasjid`; Jumu'ah is always at the masjid.

export const PRAYERS = [
  { key: "fajr", name: "Fajr", ar: "الفجر" },
  { key: "dhuhr", name: "Dhuhr", ar: "الظهر" },
  { key: "asr", name: "Asr", ar: "العصر" },
  { key: "maghrib", name: "Maghrib", ar: "المغرب" },
  { key: "isha", name: "Isha", ar: "العشاء" }
];

export function createSchedule({ config: C, table, adhan: A, jamaah = null }) {
  const TZ = C.timezone || "Europe/Bratislava";

  // ---------- time-zone helpers (all times are masjid-local) ----------
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  });
  const parts = (d) => { const o = {}; fmt.formatToParts(d).forEach((p) => (o[p.type] = p.value)); return o; };
  const offsetMs = (d) => {
    const p = parts(d);
    return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(d.getTime() / 1000) * 1000;
  };
  function zoned(ymd, hm) {
    const [y, m, d] = ymd.split("-").map(Number), [h, mi] = hm.split(":").map(Number);
    const guess = Date.UTC(y, m - 1, d, h, mi);
    let t = guess - offsetMs(new Date(guess));
    t = guess - offsetMs(new Date(t));
    return new Date(t);
  }
  const ymdOf = (d) => { const p = parts(d); return `${p.year}-${p.month}-${p.day}`; };
  const addDays = (ymd, n) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const weekday = (ymd) => new Date(ymd + "T12:00:00Z").getUTCDay();
  const hmFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const hm = (d) => (d ? hmFmt.format(d) : "—");
  const addMin = (d, m) => new Date(d.getTime() + m * 60000);

  // ---------- prayer times: IslamicFinder table first, calculation as fallback ----------
  function calcTimes(ymd) {
    if (!A) return null;
    const [y, m, d] = ymd.split("-").map(Number);
    const cal = C.calculation || {};
    const params = A.CalculationMethod[cal.method || "MuslimWorldLeague"]();
    params.madhab = cal.madhab === "hanafi" ? A.Madhab.Hanafi : A.Madhab.Shafi;
    params.adjustments = Object.assign({ fajr: 0, sunrise: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 }, cal.adjustments);
    const pt = new A.PrayerTimes(new A.Coordinates(C.location.lat, C.location.lng), new Date(y, m - 1, d, 12), params);
    return { fajr: pt.fajr, sunrise: pt.sunrise, dhuhr: pt.dhuhr, asr: pt.asr, maghrib: pt.maghrib, isha: pt.isha };
  }
  const cache = {};
  function day(ymd) {
    if (cache[ymd]) return cache[ymd];
    let raw = null, src = "calc";
    const row = table && table.days && table.days[ymd];
    if (row) {
      src = "islamicfinder"; raw = {};
      (table.order || ["fajr", "sunrise", "dhuhr", "asr", "maghrib", "isha"]).forEach((k, i) => (raw[k] = zoned(ymd, row[i])));
    } else raw = calcTimes(ymd);
    if (!raw) return null;
    const friday = weekday(ymd) === 5 && C.jumuah && C.jumuah.enabled;
    const list = PRAYERS.map((p) => {
      let adhanT = raw[p.key], iq, name = p.name, ar = p.ar, atMasjid;
      const held = (jamaah && jamaah.prayers && jamaah.prayers[p.key]) || {};
      if (p.key === "dhuhr" && friday) {
        name = "Jumu'ah"; ar = "الجمعة";
        adhanT = zoned(ymd, C.jumuah.khutbah);
        iq = zoned(ymd, C.jumuah.iqamah);
        atMasjid = true;
      } else {
        const rule = held.on && held.iqamah ? { time: held.iqamah } : (C.iqamah && C.iqamah[p.key]) || { after: 10 };
        iq = rule.time ? zoned(ymd, rule.time) : addMin(adhanT, rule.after || 0);
        if (iq < adhanT) iq = adhanT;
        atMasjid = !!held.on;
      }
      return { key: p.key, name, ar, adhan: adhanT, iqamah: iq, ymd, atMasjid };
    });
    return (cache[ymd] = { ymd, src, sunrise: raw.sunrise, list, friday });
  }
  const timeline = (n) => {
    const t = ymdOf(n);
    return [addDays(t, -1), t, addDays(t, 1)].flatMap((d) => (day(d) ? day(d).list : []));
  };

  // ---------- opening hours (same rules as index.html) ----------
  function openWindows(n) {
    const o = C.openStatus || {};
    const before = o.opensBeforeDhuhr ?? 20, after = o.closesAfterIsha ?? 30;
    const today = ymdOf(n);
    const out = [];
    for (const ymd of [addDays(today, -1), today, addDays(today, 1), addDays(today, 2)]) {
      const d = day(ymd); if (!d) continue;
      const dh = d.list.find((p) => p.key === "dhuhr"), is = d.list.find((p) => p.key === "isha");
      out.push({ from: o.opensAt ? zoned(ymd, o.opensAt) : addMin(dh.adhan, -before), to: addMin(is.iqamah, after), label: "" });
      for (const x of o.extraHours || []) {
        if (!x.days || x.days.includes(weekday(ymd))) out.push({ from: zoned(ymd, x.from), to: zoned(ymd, x.to), label: x.label || "" });
      }
    }
    return out.sort((a, b) => a.from - b.from);
  }
  function scheduleOpen(t) {
    const mode = (C.openStatus || {}).mode || "auto";
    if (mode === "open") return true;
    if (mode === "closed") return false;
    return openWindows(t).some((w) => t >= w.from && t < w.to);
  }
  // Next moment (after n) when the timetable alone changes between open and closed
  function nextScheduleChange(n) {
    const now = scheduleOpen(n);
    const edges = openWindows(n).flatMap((w) => [w.from, w.to]).filter((t) => t > n).sort((a, b) => a - b);
    for (const e of edges) if (scheduleOpen(new Date(e.getTime() + 1000)) !== now) return e;
    return null;
  }
  // Timetable + the imam's manual change = what everyone sees
  // An "open" change may have `from`: the imam set when the doors open; closed until then.
  const overrideActive = (ov, t) => !!(ov && (ov.mode === "open" || ov.mode === "closed") && (!ov.until || t < new Date(ov.until)));
  const effectiveOpen = (t, ov) => (overrideActive(ov, t) ? ov.mode === "open" && (!ov.from || t >= new Date(ov.from)) : scheduleOpen(t));
  function effectiveStatus(n, ov) {
    const open = effectiveOpen(n, ov);
    const edges = openWindows(n).flatMap((w) => [w.from, w.to]);
    if (overrideActive(ov, n) && ov.until) edges.push(new Date(ov.until));
    if (overrideActive(ov, n) && ov.from) edges.push(new Date(ov.from));
    let change = null;
    for (const e of edges.filter((t) => t > n).sort((a, b) => a - b)) {
      if (effectiveOpen(new Date(e.getTime() + 1000), ov) !== open) { change = e; break; }
    }
    return { open, manual: overrideActive(ov, n), change };
  }

  return { config: C, TZ, zoned, ymdOf, addDays, weekday, hm, addMin, day, timeline,
    openWindows, scheduleOpen, nextScheduleChange, effectiveStatus, overrideActive };
}
