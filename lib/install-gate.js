// Install page: opened in a normal browser tab, the app shows only "install me" instructions
// (English or Slovak, switch in the top corner). Opened from the home-screen icon (standalone)
// it goes straight in. "Continue in browser" is remembered per device, so the masjid TV and
// unsupported phones can still use the site.
//
//   <script src="lib/install-gate.js" data-name="Mešita Al-huda" data-icon="icons/icon-192.png" data-key="app"
//           data-sub="…" data-name-sk="…" data-sub-sk="…"></script>
// Place it as the first thing in <body>. data-name-sk / data-sub-sk are optional Slovak overrides.
(() => {
  const me = document.currentScript, D = me.dataset;
  const ICON = D.icon || "icon.svg";
  const KEY = `install-gate-${D.key || "app"}`, LANG_KEY = "install-gate-lang";

  const standalone = matchMedia("(display-mode: standalone)").matches || matchMedia("(display-mode: fullscreen)").matches || navigator.standalone === true;
  let skip = false;
  try { skip = localStorage.getItem(KEY) === "browser"; } catch (e) {}
  if (standalone || skip || new URLSearchParams(location.search).has("browser")) return;

  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const inApp = /FBAN|FBAV|FB_IAB|Instagram|WhatsApp|Line\/|Messenger|Snapchat|TikTok|MicroMessenger/.test(ua) || (android && /; wv\)/.test(ua));
  const iosChrome = /CriOS|FxiOS|EdgiOS/.test(ua);

  // ---- language: remembered choice, else the phone's language (Slovak or English) ----
  let lang = "en";
  try { lang = localStorage.getItem(LANG_KEY) || ""; } catch (e) {}
  if (lang !== "en" && lang !== "sk") lang = /^sk\b/i.test(navigator.language || "") ? "sk" : "en";

  const share = `<svg class="ig-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-label="Share"><path d="M12 15V3M7.5 7.5 12 3l4.5 4.5"/><path d="M8 10H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-2"/></svg>`;
  const plus = `<svg class="ig-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-label="Add"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/></svg>`;
  const dots = `<svg class="ig-i" viewBox="0 0 24 24" fill="currentColor" aria-label="Menu"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>`;

  const T = {
    en: {
      title: (n) => `Install ${n}`,
      sub: "Add it to your home screen. It opens like an app, full screen, with adhan alerts.",
      browser: ios ? "Safari" : "Chrome",
      inAppLead: "This link opened inside another app, which can't install it.",
      inApp: (b) => [`Tap ${dots} or the <b>…</b> menu in the corner.`, `Choose <b>Open in ${b}</b> (or “Open in browser”).`, "Then follow the install steps there."],
      copy: "Copy link", copied: "Link copied",
      ios: (n) => [`Tap the Share button ${share} ${iosChrome ? "in the address bar" : "at the bottom of Safari"}.`, `Scroll down and tap <b>Add to Home Screen</b> ${plus}.`, `Tap <b>Add</b>. Then open <b>${n}</b> from your home screen.`],
      add: "Add to Home Screen",
      manual: (n) => [`Open the browser menu ${dots}.`, "Tap <b>Install app</b> or <b>Add to Home screen</b>.", `Then open <b>${n}</b> from your home screen.`],
      skip: "Continue in browser",
      done: (n) => `Installed. Open <b>${n}</b> from your home screen.`
    },
    sk: {
      title: (n) => `Nainštalujte si ${n}`,
      sub: "Pridajte si ju na plochu. Otvára sa ako aplikácia, na celú obrazovku, s upozorneniami na adhán.",
      browser: ios ? "Safari" : "Chrome",
      inAppLead: "Tento odkaz sa otvoril v inej aplikácii, ktorá ho nevie nainštalovať.",
      inApp: (b) => [`Ťuknite na ${dots} alebo na ponuku <b>…</b> v rohu.`, `Vyberte <b>Otvoriť v ${b}</b> (alebo „Otvoriť v prehliadači“).`, "Potom pokračujte podľa pokynov na inštaláciu."],
      copy: "Kopírovať odkaz", copied: "Odkaz skopírovaný",
      ios: (n) => [`Ťuknite na tlačidlo Zdieľať ${share} ${iosChrome ? "v paneli s adresou" : "v spodnej časti Safari"}.`, `Prejdite nižšie a ťuknite na <b>Pridať na plochu</b> ${plus}.`, `Ťuknite na <b>Pridať</b>. Potom otvorte <b>${n}</b> z plochy.`],
      add: "Pridať na plochu",
      manual: (n) => [`Otvorte ponuku prehliadača ${dots}.`, "Ťuknite na <b>Inštalovať aplikáciu</b> alebo <b>Pridať na plochu</b>.", `Potom otvorte <b>${n}</b> z plochy.`],
      skip: "Pokračovať v prehliadači",
      done: (n) => `Nainštalované. Otvorte <b>${n}</b> z plochy.`
    }
  };
  const nameOf = () => (lang === "sk" && D.nameSk) || D.name || document.title;
  const subOf = () => (lang === "sk" ? D.subSk : D.sub) || T[lang].sub;
  const list = (items) => `<ol>${items.map((i) => `<li>${i}</li>`).join("")}</ol>`;

  const css = `
  html.ig-on, html.ig-on body { overflow: hidden !important; }
  html.ig-on .splash { display: none !important; }
  .ig { position: fixed; inset: 0; z-index: 1000; overflow-y: auto; display: grid; place-items: center;
    padding: max(24px, env(safe-area-inset-top)) 20px max(24px, env(safe-area-inset-bottom));
    background: radial-gradient(ellipse 80% 55% at 50% 0%, rgba(217,170,88,0.18), transparent 70%), #0a1f22;
    color: #f1e9d6; font-family: "Manrope", "Segoe UI", system-ui, sans-serif; line-height: 1.5; }
  .ig-card { width: min(420px, 100%); display: grid; gap: 16px; justify-items: center; text-align: center; }
  .ig-logo { width: 96px; height: 96px; border-radius: 22px; box-shadow: 0 14px 40px -12px rgba(0,0,0,0.7), 0 0 0 1px rgba(217,170,88,0.25); }
  .ig h1 { margin: 0; font-family: "Reem Kufi", "Segoe UI", system-ui, sans-serif; font-weight: 600; font-size: 1.6rem; line-height: 1.2; }
  .ig-sub { margin: -8px 0 0; color: #a3b8b0; font-size: 0.95rem; }
  .ig-box { width: 100%; text-align: left; background: rgba(18,50,47,0.85); border: 1px solid rgba(214,167,86,0.22); border-radius: 18px; padding: 18px; display: grid; gap: 12px; }
  .ig-lead { margin: 0; color: #f1cf85; font-weight: 600; }
  .ig ol { margin: 0; padding-left: 22px; display: grid; gap: 10px; }
  .ig li { padding-left: 4px; }
  .ig b { color: #f1cf85; }
  .ig-i { width: 22px; height: 22px; vertical-align: -5px; color: #d9aa58; }
  .ig-btn { font: inherit; font-weight: 700; font-size: 1.05rem; cursor: pointer; width: 100%; padding: 15px 18px; border-radius: 14px; border: 1px solid #d9aa58; background: #d9aa58; color: #0a1f22; }
  .ig-btn[hidden], #ig-manual[hidden] { display: none; }
  .ig-ghost { background: transparent; color: #f1cf85; }
  .ig-done { margin: 0; color: #63d394; font-weight: 600; }
  .ig-skip { font: inherit; background: none; border: none; color: #6f8a83; font-size: 0.85rem; text-decoration: underline; cursor: pointer; padding: 6px; }
  .ig-lang { position: fixed; z-index: 1001; top: max(12px, env(safe-area-inset-top)); right: max(12px, env(safe-area-inset-right));
    display: flex; gap: 2px; padding: 3px; border-radius: 999px; background: rgba(18,50,47,0.9); border: 1px solid rgba(214,167,86,0.22); }
  .ig-lang button { font: inherit; font-size: 0.78rem; font-weight: 700; letter-spacing: 0.06em; cursor: pointer; border: none; border-radius: 999px; padding: 6px 11px; background: none; color: #a3b8b0; }
  .ig-lang button[aria-pressed="true"] { background: #d9aa58; color: #0a1f22; }
  .ig-btn:focus-visible, .ig-skip:focus-visible, .ig-lang button:focus-visible { outline: 2px solid #f1cf85; outline-offset: 2px; }`;
  const style = document.createElement("style"); style.textContent = css; document.head.append(style);

  const gate = document.createElement("div");
  gate.className = "ig"; gate.setAttribute("role", "dialog"); gate.setAttribute("aria-modal", "true"); gate.setAttribute("aria-labelledby", "ig-title");
  const $ = (id) => gate.querySelector("#" + id);

  let prompt = null, installed = false;     // survive a language switch

  function render() {
    const t = T[lang], n = nameOf();
    document.documentElement.classList.add("ig-on");
    let steps;
    if (installed) steps = `<p class="ig-done">${t.done(n)}</p>`;
    else if (inApp) steps = `<p class="ig-lead">${t.inAppLead}</p>${list(t.inApp(t.browser))}<button class="ig-btn ig-ghost" id="ig-copy">${t.copy}</button>`;
    else if (ios) steps = list(t.ios(n));
    else steps = `<button class="ig-btn" id="ig-install" ${prompt ? "" : "hidden"}>${t.add}</button><div id="ig-manual" ${prompt ? "hidden" : ""}>${list(t.manual(n))}</div>`;
    gate.lang = lang;
    gate.innerHTML = `<div class="ig-lang" role="group" aria-label="Language">
        <button data-l="en" aria-pressed="${lang === "en"}">EN</button><button data-l="sk" aria-pressed="${lang === "sk"}">SK</button>
      </div>
      <div class="ig-card">
        <img class="ig-logo" src="${ICON}" alt="">
        <h1 id="ig-title">${t.title(n)}</h1>
        <p class="ig-sub">${subOf()}</p>
        <div class="ig-box" id="ig-box">${steps}</div>
        <button class="ig-skip" id="ig-skip">${t.skip}</button>
      </div>`;

    gate.querySelectorAll(".ig-lang button").forEach((b) => b.addEventListener("click", () => {
      lang = b.dataset.l;
      try { localStorage.setItem(LANG_KEY, lang); } catch (e) {}
      render();
    }));
    $("ig-skip").addEventListener("click", () => {
      try { localStorage.setItem(KEY, "browser"); } catch (e) {}
      gate.remove(); document.documentElement.classList.remove("ig-on");
    });
    if ($("ig-copy")) $("ig-copy").addEventListener("click", async () => {
      const link = location.href.split("#")[0];
      try { await navigator.clipboard.writeText(link); $("ig-copy").textContent = T[lang].copied; }
      catch (e) { $("ig-copy").textContent = link; }
    });
    if ($("ig-install")) $("ig-install").addEventListener("click", async () => {
      if (!prompt) return;
      prompt.prompt();
      const { outcome } = await prompt.userChoice; prompt = null;
      if (outcome !== "accepted") render();
    });
  }

  // Android / computer: the browser offers a one-tap install once it is ready
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); prompt = e; if (gate.isConnected) render(); });
  window.addEventListener("appinstalled", () => { installed = true; if (gate.isConnected) render(); });

  render();
  document.body.prepend(gate);
})();
