# Mešita Al-huda — Salah Times

The app for the jama'ah at Mešita Al-huda, Košice: adhan and iqamah times, a live iqamah countdown,
an open/closed indicator the imam controls from his phone, a reminder of the day, and notifications
with sound that arrive even when the app is closed.

Live at **https://mesita-alhuda.pages.dev** · Imam page: **https://mesita-alhuda.pages.dev/admin.html**

## Who does what

| Person | Uses | Does |
|---|---|---|
| Brothers | the app | Add it to the Home Screen, tap the bell, turn on alerts |
| Imam (or a trusted brother) | `/admin.html` | Open / close the masjid, set the reminder of the day, post an announcement. Everyone can be notified. |
| Developer | GitHub | `config.js` (iqamah, Jumu'ah, opening hours), who gets an imam code |

## What's in the repository

```
index.html                The app
admin.html                Imam controls (needs a personal access code)
config.js                 ← iqamah, Jumu'ah, opening hours: the file you normally edit
data/times.json           Adhan timetable from IslamicFinder (updated automatically)
data/verses.js            Verses for the automatic reminder of the day
sw.js                     Receives notifications while the app is closed; offline support
lib/schedule.js           Prayer and opening-hours logic shared by the imam page and the worker
lib/webpush.js            Encrypts and signs notifications (standard Web Push, works on iPhone)
functions/api/[[path]].js The site's API on Cloudflare Pages (/api/...)
server/worker.js          Background worker: adhan notifications every minute, sends in batches
server/schema.sql         Database tables
scripts/update-times.mjs  Copies the month from IslamicFinder
scripts/setup-server.mjs  Sets up everything on Cloudflare (run by the "Set up server" job)
.github/workflows/        update-times.yml (1st and 15th of each month), server.yml (setup)
wrangler.toml             Created by the setup job: connects the site to the database. Don't edit.
```

## How it fits together

```
 Imam's phone ──► /admin.html ──► /api (Pages) ──► database (D1)
                                      │                 ▲
                                      ▼                 │ every minute: is an adhan due?
 Brothers' phones ◄── Google / Apple push ◄── worker ◄──┘  + anything the imam queued
```

- **Masjid open/closed**: the timetable in `config.js` decides, unless the imam changes it. His change
  lasts until the time he picks (1 hour, 2 hours, a set time) or until the timetable next opens or closes.
- **Reminder of the day**: a different verse each day automatically, or one the imam picks or writes
  (with optional Arabic and a source). It shows until midnight, or until he changes it.
- **Notifications**: each phone chooses *Adhan + 10-minute reminder* and/or *Masjid open/closed,
  reminder of the day and news*.

## One-time server setup (about 15 minutes, no command line)

**1. Cloudflare API token** (lets GitHub set things up for you)
1. dash.cloudflare.com → your profile icon (top right) → **My Profile → API Tokens → Create Token**.
2. **Create Custom Token**. Name it `masjid setup`. Add these permissions (all *Account*):
   - Workers Scripts — Edit
   - D1 — Edit
   - Queues — Edit
   - Account Settings — Read
3. Account Resources: *Include* your account. **Continue to summary → Create Token**. Copy it.
4. Your **Account ID**: on the dashboard home page or Workers & Pages, in the right-hand column
   (also the long code in the address bar after `dash.cloudflare.com/`).

**2. GitHub secrets** — repository **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | the account ID |
| `ADMIN_CODES` | `{"Imam Yusuf":"noor-sabr-4821-huda"}` — one entry per person, codes at least 8 characters |

**3. Run it** — **Actions → Set up server → Run workflow**. It takes about a minute and:
creates the database and queue, makes the notification keys, saves the imam codes (hashed),
deploys the background worker (no public address), and commits `wrangler.toml` so Pages connects
the site to the database. Pages then redeploys by itself (about a minute).

**4. Check** — open `/admin.html`, sign in with the code, tap *Open the masjid* with
*Send a notification* ticked, and see it arrive on a phone that has alerts on.

The job is safe to run again at any time; it never deletes data and never changes the
notification keys once made (changing them would turn everyone's alerts off).

## Adding or removing an imam

Edit the `ADMIN_CODES` secret (all people in one line, e.g.
`{"Imam Yusuf":"noor-sabr-4821-huda","Br. Ali":"salam-ilm-5617-dua"}`), then run
**Actions → Set up server** again. Removing someone from the list signs them out.
Ten wrong codes from one connection are blocked for an hour.

## Notifications and sound

- Notifications are sent by the server, so they arrive **with the phone's notification sound even
  when the app is closed**, like WhatsApp messages. The adhan notification also vibrates longer and
  stays on screen until it is seen.
- **iPhone**: iOS 16.4 or newer, and the app must be opened from its Home Screen icon (Share → Add to
  Home Screen). Silent mode and Focus mute it, as with any app.
- **Android**: works from Chrome; installing the app (Chrome menu → *Install app*) is recommended.
- A **full adhan recording** as the notification sound is not possible for a web app: phones only let
  web notifications use the standard notification sound. That needs a native app (a later phase).
  While the app is open, it still plays its own chime.

## Opening hours, iqamah and Jumu'ah (config.js)

```js
iqamah: { fajr: { after: 2 }, dhuhr: { time: "12:20" }, ... },
jumuah: { enabled: true, khutbah: "12:30", iqamah: "12:45" },
openStatus: {
  mode: "auto",            // "open" / "closed" force it, e.g. Ramadan or renovation
  opensAt: "12:00",        // or "" to open opensBeforeDhuhr minutes before Dhuhr
  closesAfterIsha: 10,     // minutes after Isha iqamah
  extraHours: [ { days: [6, 0], from: "10:00", to: "12:00", label: "Weekend class" } ]
}
```

Save on GitHub (pencil → Commit). The site and the notification worker both read the live
`config.js`, so nothing else is needed.

## Announcements

In `/admin.html` the imam writes the announcement in English, Slovak and Arabic (any can be left empty).
The app shows it as a two-line banner that cycles through the languages; tapping opens all three in full.
On the Imam's phone, `/admin.html` can be installed as its own app ("Imam").

## Hosting (Cloudflare Pages)

- Pages is connected to this repository and republishes on every commit to `main`.
- The repository can stay **private**.
- Free plan limits are far above what a masjid needs (100,000 API requests a day, 10,000 queue
  operations a day; about 3 queue operations per 15 phones per notification).

### Monthly timetable

`.github/workflows/update-times.yml` runs on the 1st and 15th, copies the month from IslamicFinder
into `data/times.json` and commits it. If it ever fails, GitHub emails you and the app falls back
to calculated times (accurate to about a minute). To run it by hand: **Actions → Update prayer times**.

## Sharing it with the brothers

- Put a QR code of the link at the masjid entrance.
- Open the link → **Add to Home Screen** → open it from the icon → tap the bell → **Turn on alerts**.
- For a TV in the masjid: open the link and tap the full-screen button (keeps the screen awake).

## Testing

- Add `?t=2026-10-29T13:55` to the app link to see it at that moment.
- Local run: `npm install --prefix server`, create `server/wrangler.toml` from the template in
  `scripts/setup-server.mjs` with `DEV = "1"`, then `npx wrangler pages dev .` and `npx wrangler dev`
  in `server/`. `GET /dev/cron?t=2026-10-29T12:53:00Z` on the worker runs the every-minute job for any time.

## Credits

Prayer times: IslamicFinder (islamicfinder.org). Calculation: adhan-js (MIT).
Qur'an text: quranenc.com; English translation: Saheeh International via tanzil.net.
