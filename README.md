# Masjid Košice — Salah Times

A small web app for the jama'ah: adhan and iqamah times for Košice, a live iqamah countdown that starts the moment the adhan is due, adhan alerts, an open/closed indicator for the masjid, and a daily Qur'an verse.

No server, no database, no build step. It is plain files you can host for free.

## What's in the folder

```
masjid-app/
├── index.html                  The app (layout, styles, logic)
├── config.js                   ← THE ONLY FILE YOU NORMALLY EDIT
├── data/
│   ├── times.json              Adhan timetable copied from IslamicFinder
│   └── verses.js               Daily verses (Arabic + Saheeh International)
├── adhan.min.js                Backup calculator (used if a date is missing from times.json)
├── sw.js                       Offline support + notification clicks
├── manifest.webmanifest        Lets people "Add to Home Screen"
├── icon.svg                    App icon
├── scripts/update-times.mjs    Fetches the new month from IslamicFinder
└── .github/workflows/update-times.yml   Runs that script automatically (1st & 15th)
```

## Where the times come from

1. **`data/times.json`**: the timetable from the IslamicFinder Košice page
   (Muslim World League, Fajr 18°, Isha 17°, Shafi Asr). October 2026 is already filled in.
   The GitHub Action refreshes it on the 1st and 15th of every month.
2. **Backup**: if a date isn't in `times.json` (e.g. the update hasn't run yet), the phone
   calculates the times itself with the same method IslamicFinder uses, tuned to within about a minute.
   The timetable footer says which source is in use.

## Changing iqamah times, Jumu'ah, open hours (config.js)

```js
iqamah: {
  fajr:    { after: 20 },        // 20 minutes after adhan
  dhuhr:   { time: "13:30" },    // fixed clock time
  ...
},
jumuah: { enabled: true, khutbah: "12:30", iqamah: "13:00" },
openStatus: { mode: "auto", opensBeforeAdhan: 15, closesAfterIqamah: 30 },
announcement: "Tarawih begins Saturday after Isha",
```

- `openStatus.mode`: `"auto"` (open around each prayer), `"open"` or `"closed"` (manual override).
- `extraHours` adds open windows such as a weekend class.
- `notifications.adhanAudio`: link to an adhan recording you have permission to use; leave empty for a soft chime.

Save the file on GitHub (pencil icon → Commit). Phones pick up the change on their next refresh; masjid screens reload every 6 hours.

## Announcements (imam.html)

The imam writes the announcement in English, Slovak and Arabic at **/imam.html** and taps **Publish**.
The page saves `data/announcement.json` to GitHub, Cloudflare republishes, and phones pick it up within about 5 minutes.
The home screen shows two lines (cycling through the languages); tapping opens all three.

One-time setup on the imam's phone: create a GitHub **fine-grained token** limited to this repository with
**Contents: Read and write** only, and paste it into the page. It is stored only on that phone.

## Hosting (Cloudflare Pages)

Live at **https://mesita-alhuda.pages.dev**

- Cloudflare Pages is connected to this repository and republishes the site on every
  commit to `main`, including the timetable job's commits. Nothing to upload by hand.
- Project settings: framework preset *None*, build command empty, output directory `/`.
- The repository can stay **private**; Cloudflare still deploys it.
- GitHub Pages is not used (it would show the owner's username in the address).

### Monthly timetable

`.github/workflows/update-times.yml` runs on the 1st and 15th of each month, copies the month
from IslamicFinder into `data/times.json` and commits it; Cloudflare then republishes.
Needs **Settings → Actions → General → Workflow permissions: Read and write**.
To run it by hand: **Actions → Update prayer times → Run workflow**.

Optional: buy a domain (e.g. `alhuda-kosice.sk`) and add it in Cloudflare under the project's **Custom domains**.

## Sharing it with the brothers

- Print a QR code of the link and put it at the masjid entrance.
- Ask people to open the link and **Add to Home Screen** (Android: Chrome menu; iPhone: Safari share button).
  On iPhone, notifications only work after it is added to the Home Screen (iOS 16.4+).
- Then tap **Turn on adhan alerts**.
- For a TV in the masjid: open the link in the TV's browser and tap **Masjid screen mode** (full screen, keeps the screen awake).

## Good to know about notifications

Alerts (adhan, a reminder 10 minutes before, and 1 minute before iqamah) fire while the app is open
or running in the background. Phones may pause a closed web app, so alerts are not guaranteed
when the app is fully closed. Guaranteed alerts need a push service (for example OneSignal's free plan)
that sends from a server at each adhan. That can be added later without changing the design.

## Testing a specific moment

Add `?t=2026-10-20T15:08` to the link to see the app as it would look at that time (iqamah countdown, Jumu'ah, closed at night, and so on).

## Credits

Prayer times: IslamicFinder (islamicfinder.org). Calculation: adhan-js (MIT).
Qur'an text: quranenc.com; English translation: Saheeh International via tanzil.net.
