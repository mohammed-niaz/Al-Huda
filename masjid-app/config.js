/* ============================================================
   MASJID SETTINGS — this is the only file you normally edit.
   Save, re-upload (or push to GitHub) and every phone picks it
   up on the next refresh.
   ============================================================ */
window.MASJID_CONFIG = {
  // ---- Identity ------------------------------------------------
  name: "Mešita Al-huda",
  tagline: "Come to prayer. Come to success.",
  address: "Košice, Slovakia",          // shown in the footer
  mapQuery: "",                         // optional exact address/place for the Maps button; empty = name + address
  timezone: "Europe/Bratislava",

  // ---- Prayer times --------------------------------------------
  // 1st choice: data/times.json (copied from IslamicFinder, refreshed
  //             monthly by scripts/update-times.mjs).
  // Fallback:   calculated on the phone with the same method
  //             IslamicFinder uses for Košice, tuned to within ±1 min.
  location: { lat: 48.7164, lng: 21.2611 },
  calculation: {
    method: "MuslimWorldLeague",        // Fajr 18°, Isha 17°
    madhab: "shafi",                    // "shafi" or "hanafi" (Asr)
    adjustments: { fajr: 0, sunrise: -2, dhuhr: 1, asr: 2, maghrib: 4, isha: 2 }
  },

  // ---- Iqamah (when the jama'ah stands) ------------------------
  // For each prayer use EITHER
  //   { after: N }        → iqamah N minutes after the adhan
  //   { time: "HH:MM" }   → iqamah at a fixed clock time
  iqamah: {
    fajr:    { after: 2 },
    dhuhr:   { after: 10 },
    asr:     { after: 10 },
    maghrib: { after: 5 },
    isha:    { after: 10 }
  },

  // Friday: Dhuhr is replaced by Jumu'ah
  jumuah: {
    enabled: true,
    khutbah: "13:30",                  // khutbah start (shown + used as "adhan")
    iqamah:  "13:45"
  },

  // How long the "jama'ah in progress" state shows after iqamah
  jamaahMinutes: 5,

  // ---- Is the masjid open? -------------------------------------
  // mode: "auto"   → open around every prayer (rules below)
  //       "open"   → always show OPEN   (e.g. Ramadan, i'tikaf)
  //       "closed" → always show CLOSED (e.g. renovation)
  openStatus: {
    mode: "auto",
       opensBeforeDhuhr: 20,              // doors open N min before Dhuhr adhan
    closesAfterIsha: 10,               // doors close N min after Isha iqamah
    // Extra open hours, days: 0=Sun … 5=Fri, 6=Sat
    extraHours: [
      // { days: [6, 0], from: "10:00", to: "12:00", label: "Weekend Qur'an class" }
    ],
    closedMessage: ""                  // e.g. "Closed for cleaning until Thursday"
  },

  // ---- Notifications -------------------------------------------
  notifications: {
    reminderBeforeAdhan: 10,           // minutes; 0 to switch off
    iqamahAlert: true,                 // alert when iqamah is about to start
    adhanAudio: ""                     // URL of an adhan .mp3 you have rights to; empty = soft chime
  },

  // ---- Small things --------------------------------------------
  hijriOffset: 0,                      // shift the Hijri date ±1 day to match local sighting
  announcement: ""                     // banner text, e.g. "Tarawih begins Saturday after Isha"
};
