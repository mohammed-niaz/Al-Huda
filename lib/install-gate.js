// Install page: opened in a normal browser tab, the app shows only "install me" instructions.
// Opened from the home-screen icon (standalone) it goes straight in. "Continue in browser" is
// remembered per device, so the masjid TV and unsupported phones can still use the site.
//
//   <script src="lib/install-gate.js" data-name="Mešita Al-huda" data-icon="icons/icon-192.png" data-key="app"></script>
// Place it as the first thing in <body>.
(() => {
  const me = document.currentScript;
  const NAME = me.dataset.name || document.title, ICON = me.dataset.icon || "icon.svg";
  const SUB = me.dataset.sub || "Add it to your home screen. It opens like an app, full screen, with adhan alerts.";
  const KEY = `install-gate-${me.dataset.key || "app"}`;

  const standalone = matchMedia("(display-mode: standalone)").matches || matchMedia("(display-mode: fullscreen)").matches || navigator.standalone === true;
  let skip = false;
  try { skip = localStorage.getItem(KEY) === "browser"; } catch (e) {}
  if (standalone || skip || new URLSearchParams(location.search).has("browser")) return;

  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const inApp = /FBAN|FBAV|FB_IAB|Instagram|WhatsApp|Line\/|Messenger|Snapchat|TikTok|MicroMessenger/.test(ua) || (android && /; wv\)/.test(ua));

  const share = `<svg class="ig-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-label="Share"><path d="M12 15V3M7.5 7.5 12 3l4.5 4.5"/><path d="M8 10H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-2"/></svg>`;
  const plus = `<svg class="ig-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-label="Add"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/></svg>`;
  const dots = `<svg class="ig-i" viewBox="0 0 24 24" fill="currentColor" aria-label="Menu"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>`;

  let steps;
  if (inApp) {
    steps = `<p class="ig-lead">This link opened inside another app, which can't install it.</p>
      <ol><li>Tap ${dots} or the <b>…</b> menu in the corner.</li><li>Choose <b>Open in ${ios ? "Safari" : "Chrome"}</b> (or “Open in browser”).</li><li>Then follow the install steps there.</li></ol>
      <button class="ig-btn ig-ghost" id="ig-copy">Copy link</button>`;
  } else if (ios) {
    steps = `<ol><li>Tap the Share button ${share} ${/CriOS|FxiOS|EdgiOS/.test(ua) ? "in the address bar" : "at the bottom of Safari"}.</li>
      <li>Scroll down and tap <b>Add to Home Screen</b> ${plus}.</li><li>Tap <b>Add</b>. Then open <b>${NAME}</b> from your home screen.</li></ol>`;
  } else {
    steps = `<button class="ig-btn" id="ig-install" hidden>Add to Home Screen</button>
      <div id="ig-manual"><ol><li>Open the browser menu ${dots}.</li><li>Tap <b>Install app</b> or <b>Add to Home screen</b>.</li><li>Then open <b>${NAME}</b> from your home screen.</li></ol></div>`;
  }

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
  .ig-btn:focus-visible, .ig-skip:focus-visible { outline: 2px solid #f1cf85; outline-offset: 2px; }
  .ig-done { margin: 0; color: #63d394; font-weight: 600; }
  .ig-skip { font: inherit; background: none; border: none; color: #6f8a83; font-size: 0.85rem; text-decoration: underline; cursor: pointer; padding: 6px; }`;
  const style = document.createElement("style"); style.textContent = css; document.head.append(style);

  const gate = document.createElement("div");
  gate.className = "ig"; gate.setAttribute("role", "dialog"); gate.setAttribute("aria-modal", "true"); gate.setAttribute("aria-labelledby", "ig-title");
  gate.innerHTML = `<div class="ig-card">
    <img class="ig-logo" src="${ICON}" alt="">
    <h1 id="ig-title">Install ${NAME}</h1>
    <p class="ig-sub">${SUB}</p>
    <div class="ig-box" id="ig-box">${steps}</div>
    <button class="ig-skip" id="ig-skip">Continue in browser</button>
  </div>`;
  document.documentElement.classList.add("ig-on");
  document.body.prepend(gate);
  const $ = (id) => gate.querySelector("#" + id);

  $("ig-skip").addEventListener("click", () => {
    try { localStorage.setItem(KEY, "browser"); } catch (e) {}
    gate.remove(); document.documentElement.classList.remove("ig-on");
  });
  if ($("ig-copy")) $("ig-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href.split("#")[0]); $("ig-copy").textContent = "Link copied"; }
    catch (e) { $("ig-copy").textContent = location.href.split("#")[0]; }
  });

  // Android / computer: the browser offers a one-tap install once it is ready
  let prompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); prompt = e;
    if ($("ig-install")) { $("ig-install").hidden = false; $("ig-manual").hidden = true; }
  });
  if ($("ig-install")) $("ig-install").addEventListener("click", async () => {
    if (!prompt) return;
    prompt.prompt();
    const { outcome } = await prompt.userChoice; prompt = null;
    if (outcome !== "accepted") { $("ig-install").hidden = true; $("ig-manual").hidden = false; }
  });
  window.addEventListener("appinstalled", () => {
    $("ig-box").innerHTML = `<p class="ig-done">Installed. Open <b>${NAME}</b> from your home screen.</p>`;
  });
})();
