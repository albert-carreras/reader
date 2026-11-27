// reader — library, book page, and the read-along player. No build step.
const $ = (sel, el = document) => el.querySelector(sel);
const app = $("#app");
const audio = $("#audio");

const ICON = {
  spin: '<svg class="spin" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="34 60"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>',
  prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 5.5L8 12l6.5 6.5"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 5.5L16 12l-6.5 6.5"/></svg>',
  back15: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/><text x="12" y="15.5" font-size="7.5" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui" font-weight="700">15</text></svg>',
  fwd15: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4h-4"/><text x="12" y="15.5" font-size="7.5" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui" font-weight="700">15</text></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  type: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19l5-14 5 14M6 14h6M15 19l3-8 3 8M16 16.5h4"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
};

// what went wrong on the phone, kept on the server (data/client.log): errors, recoveries, stalls, chapter changes
const clogQueue = [];
let clogTimer = 0;
const clog = (kind, detail = "") => {
  try {
    clogQueue.push({ at: Date.now(), kind, detail: String(detail).slice(0, 300), book: player.book?.id, ch: player.ch?.index,
      t: player.ch ? Math.round(player.chapterTime()) : null, paused: audio.paused, vis: document.visibilityState, online: navigator.onLine });
    if (clogQueue.length > 200) clogQueue.shift();
    clearTimeout(clogTimer);
    clogTimer = setTimeout(() => {
      const batch = clogQueue.splice(0);
      fetch("/api/log", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch), keepalive: true })
        .then((r) => { if (!r.ok) throw 0; }).catch(() => clogQueue.unshift(...batch.slice(-100)));
    }, 2000);
  } catch {}
};
addEventListener("error", (e) => clog("js-error", `${e.message} @${e.lineno}`));
addEventListener("unhandledrejection", (e) => clog("js-reject", e.reason?.message || e.reason));

const KEEP_OFFLINE = /^\/api\/books(\/[a-z0-9-]+)?$/;      // library + book pages are always kept for offline use
const api = async (path, opts = {}) => {
  const isGet = !opts.method || opts.method === "GET";
  let r;
  try {
    r = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  } catch (e) {          // no network: serve what this device has
    if (isGet) { const v = await idb.get(path).catch(() => null); if (v?.type === "json") return v.data; }
    throw new Error("You're offline");
  }
  if (!r.ok) {
    if (isGet && r.status >= 500) { const v = await idb.get(path).catch(() => null); if (v?.type === "json") return v.data; }   // server restarting
    throw Object.assign(new Error((await r.json().catch(() => ({}))).detail || r.statusText), { status: r.status });
  }
  const j = await r.json();
  if (isGet && KEEP_OFFLINE.test(path)) idb.put(path, { type: "json", data: j }).catch(() => {});
  return j;
};
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
};
const fmt = (s) => {
  s = Math.max(0, Math.round(s || 0));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${mm}:${String(ss).padStart(2, "0")}`;
};
const human = (s) => { s = Math.round(s || 0); const hh = Math.floor(s / 3600), mm = Math.round((s % 3600) / 60); return hh ? `${hh} h ${mm} min` : `${mm} min`; };
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
const NUMERAL = /^([IVXLCDM]+|\d+)\.?$/i;
const SMALL_WORDS = new Set("a an and as at but by for in of on or the to vs via de del el la las lo los y e o u en con por para al".split(" "));
const titleCase = (t, lang = "en") => {      // Spanish uses sentence case: "Sobre la autora"
  const letters = t.replace(/[^\p{L}]/gu, "");
  if (letters.length < 4 || letters !== letters.toUpperCase()) return t;
  let first = true;
  return t.toLowerCase().replace(/[\p{L}'’]+/gu, (w, at, all) => {
    const up = w.toUpperCase();
    if (/[:.!?—–-]\s*$/.test(all.slice(0, at))) first = true;      // "Year 102: The Most…"
    const out = /^[IVXLCDM]+$/.test(up) && up.length <= 4 && up !== "MIL" ? up
      : !first && (lang === "es" || SMALL_WORDS.has(w)) ? w : w[0].toUpperCase() + w.slice(1);
    first = false;
    return out;
  });
};
const chapterLabel = (title, lang) => (NUMERAL.test((title || "").trim()) ? `${lang === "es" ? "Capítulo" : "Chapter"} ${title.trim().replace(/\.$/, "")}` : titleCase(title || "", lang));
const toast = (msg, ms = 2800) => { const t = h("div", { class: "toast" }, msg); document.body.append(t); setTimeout(() => t.remove(), ms); };
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem("reader:" + k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem("reader:" + k, JSON.stringify(v)),
};
const coverEl = (b) => {
  const c = h("div", { class: "cover" });
  const img = h("img", { src: `/api/books/${b.id}/cover`, alt: "", loading: "lazy" });
  img.onerror = async () => {
    const local = await idb.get(`/api/books/${b.id}/cover`).catch(() => null);
    if (local?.data && !img.dataset.local) { img.dataset.local = "1"; img.src = URL.createObjectURL(local.data); return; }
    img.remove();
    c.classList.add("gen");
    const hue = [...b.title].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 360;
    c.style.background = `linear-gradient(160deg, hsl(${hue} 45% 38%), hsl(${(hue + 40) % 360} 50% 22%))`;
    c.append(h("div", {}, b.title, h("div", { style: "font:400 .8rem var(--ui-font);opacity:.8;margin-top:.5rem" }, b.author || "")));
  };
  c.append(img);
  return c;
};

// iOS only starts audio inside a tap: the reader preloads the right file, so a tap on play starts it synchronously.
const realPlaying = () => !audio.paused;

// theme & text size
const applyLook = () => {
  requestAnimationFrame(() => {
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", bg));
  });
  const theme = store.get("theme", "auto");
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.style.setProperty("--text-size", store.get("size", window.innerWidth < 640 ? 19 : 21) + "px");
};
applyLook();

// positions: server is the source of truth, a local copy covers offline gaps (car, metro) and syncs later
const positions = {
  local: (id) => store.get(`pos:${id}`, null),
  remember(id, p) { store.set(`pos:${id}`, { ...p, at: Date.now(), synced: false }); },
  async push(id) {
    const p = this.local(id);
    if (!p || p.synced) return;
    try {
      await api(`/api/books/${id}/position`, { method: "PUT", body: JSON.stringify({ chapter: p.chapter, unit: p.unit, t: p.t, at: p.at, block: p.block, start: p.start, du: p.du }) });
      store.set(`pos:${id}`, { ...p, synced: true });
    } catch {}
  },
  // newest of server and local
  best(id, server) {
    const l = this.local(id);
    const s = server ? { ...server, at: (server.updated || 0) * 1000 } : null;
    if (l && (!s || l.at > s.at + 1000)) return l;
    return s;
  },
};
addEventListener("online", () => Object.keys(localStorage).filter((k) => k.startsWith("reader:pos:")).forEach((k) => positions.push(k.slice(11))));

// ------------------------------------------------------------------ offline: IndexedDB store + download manager
// Audio is kept as Blobs in IndexedDB and played through blob: URLs (more reliable on iOS than serving media
// from a service worker). Book/chapter/timeline JSON is kept alongside so reading-along works offline too.
const idb = (() => {
  let dbp;
  const open = () => (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open("reader", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("files");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction("files", mode);
      const req = fn(t.objectStore("files"));
      t.oncomplete = () => res(req && "result" in req ? req.result : undefined);
      t.onerror = t.onabort = () => rej(t.error);
    });
  };
  return {
    get: (k) => run("readonly", (s) => s.get(k)),
    put: (k, v) => run("readwrite", (s) => s.put(v, k)),
    del: (k) => run("readwrite", (s) => s.delete(k)),
    keys: () => run("readonly", (s) => s.getAllKeys()),
  };
})();

const DL_WINDOW = 3 * 3600;   // "next 3 hours"
// A downloaded chapter is its stream file (fragmented MP4, fed to the player as is), that file's fragment table and
// timeline, and the chapter text, each stored under the path the app fetches it from.
const dlKeys = (id, n) => [`/api/books/${id}/stream/${n}/full.mp4`, `/api/books/${id}/stream/${n}/full.json`, `/api/books/${id}/chapters/${n}`];
const offline = {
  busy: {},          // bookId -> {done, total, label}
  listeners: new Set(),
  emit() { for (const f of this.listeners) try { f(); } catch {} },
  mode: (id) => store.get(`dl:${id}`, "off"),
  index: (id) => store.get(`dlx2:${id}`, {}),           // {chapterIndex: {b: bytes, v: stream version}}
  bytes(id) { return Object.values(this.index(id)).reduce((a, x) => a + (x.b || 0), 0); },
  has(id, n) { return n in this.index(id); },
  version(id, n) { return this.index(id)[n]?.v; },
  async setMode(id, m) {
    store.set(`dl:${id}`, m);
    if (m !== "off" && navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    await this.sync(id);
  },
  async blob(id, n) {
    if (!this.has(id, n)) return null;
    const v = await idb.get(dlKeys(id, n)[0]).catch(() => null);
    return v?.data || null;
  },
  // which chapters should be on the phone right now
  wanted(b, mode) {
    const chs = b.chapters.filter((c) => c.include && c.n_units);
    if (mode === "whole") return chs.map((c) => c.index);
    if (mode !== "next") return [];
    const pos = positions.best(b.id, b.position);
    let i = Math.max(0, pos ? chs.findIndex((c) => c.index === pos.chapter) : 0), acc = 0;
    const out = [];
    for (; i < chs.length && acc < DL_WINDOW; i++) { out.push(chs[i].index); acc += chs[i].est; }
    return out;
  },
  async drop(id, n) {
    for (const k of dlKeys(id, n)) await idb.del(k).catch(() => {});
    const ix = this.index(id); delete ix[n]; store.set(`dlx2:${id}`, ix);
  },
  async dropAll(id) { for (const n of Object.keys(this.index(id))) await this.drop(id, n); this.emit(); },
  async sync(id) {
    if (this.busy[id] || !navigator.onLine) return;
    const mode = this.mode(id);
    let b;
    try { b = await api(`/api/books/${id}`); } catch { return; }
    api("/api/books").catch(() => {});      // keep the library list on the phone too
    const want = new Set(this.wanted(b, mode));
    for (const n of Object.keys(this.index(id)).map(Number)) if (!want.has(n)) await this.drop(id, n);
    const todo = b.chapters.filter((c) => want.has(c.index) && (!this.has(id, c.index) || (c.v && c.v !== this.version(id, c.index))));
    const ready = todo.filter((c) => c.full);
    if (!ready.length) { this.emit(); return; }
    this.busy[id] = { done: 0, total: ready.length, label: "" };
    this.emit();
    const json = (r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); };
    try {
      if (!(await idb.get(`/api/books/${id}/cover`).catch(() => null))) {
        const r = await fetch(`/api/books/${id}/cover`);
        if (r.ok) await idb.put(`/api/books/${id}/cover`, { type: "blob", data: await r.blob() });
      }
      for (const c of ready) {
        this.busy[id].label = c.title;
        this.emit();
        const [mp4, ixKey, chKey] = dlKeys(id, c.index);
        const [cj, ix] = await Promise.all([fetch(chKey).then(json), fetch(ixKey).then(json)]);
        const data = await fetch(`${mp4}?v=${ix.v}`).then((r) => { if (!r.ok) throw new Error(r.statusText); return r.blob(); });
        await idb.put(chKey, { type: "json", data: cj });
        await idb.put(ixKey, { type: "json", data: ix });
        await idb.put(mp4, { type: "blob", data });
        store.set(`dlx2:${id}`, { ...this.index(id), [c.index]: { b: data.size, v: ix.v } });
        this.busy[id].done++;
        this.emit();
      }
    } catch (e) {
      toast("Download paused: " + (e.message || "network"), 4000);
    } finally { delete this.busy[id]; this.emit(); }
  },
  async syncAll() {
    const ids = Object.keys(localStorage).filter((k) => k.startsWith("reader:dl:")).map((k) => k.slice(10));
    for (const id of ids) if (this.mode(id) !== "off") await this.sync(id);
  },
};
// downloads from before the continuous player were plain .m4a files: drop them; sync fetches the new format
for (const k of Object.keys(localStorage).filter((k) => k.startsWith("reader:dlx:"))) {
  const id = k.slice(11);
  for (const n of Object.keys(store.get(`dlx:${id}`, {}))) for (const p of [`/api/books/${id}/chapter-audio/${n}.m4a`, `/api/books/${id}/chapters/${n}/timeline`]) idb.del(p).catch(() => {});
  localStorage.removeItem(k);
}
addEventListener("online", () => offline.syncAll());
setInterval(() => offline.syncAll(), 10 * 60 * 1000);

// ------------------------------------------------------------------ preferences (this device)
const PREFS = { rewind: "normal", skip: 15, autoNext: true, highlight: "both", follow: true, wake: false };
const prefs = new Proxy({}, {
  get: (_, k) => ({ ...PREFS, ...store.get("prefs", {}) })[k],
  set: (_, k, v) => { store.set("prefs", { ...store.get("prefs", {}), [k]: v }); return true; },
});
const REWIND_SCALE = { off: 0, short: 0.5, normal: 1, long: 1.75 };
const bytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round((n || 0) / 1e3)} kB`);
const eta = (s) => (s == null ? "" : s < 90 ? "under 2 min" : human(s));
const short = (s) => { s = Math.round(s || 0); const hh = Math.floor(s / 3600), mm = Math.round((s % 3600) / 60); return hh ? `${hh}h ${String(mm).padStart(2, "0")}m` : s < 90 ? "< 2m" : `${mm}m`; };
const pct = (a, b) => Math.round((100 * (a || 0)) / Math.max(b || 1, 1));
const switchEl = (on, onchange, label) => {
  const el = h("button", { class: "switch" + (on ? " on" : ""), role: "switch", "aria-checked": String(on), "aria-label": label || "", onclick: (e) => { e.stopPropagation(); onchange(!on); } }, h("i"));
  return el;
};
const seg = (options, value, onpick) => h("div", { class: "segctl" }, options.map(([v, label]) =>
  h("button", { class: v === value ? "on" : "", onclick: () => onpick(v) }, label)));

// ------------------------------------------------------------------ header + renderer chip
const ICON2 = {
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 20h14"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 8v5M12 16.5v.5"/><path d="M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
};
let chipTimer = 0;
const renderChip = () => {
  const chip = h("a", { class: "chip-status skeleton", href: "#/system", title: "Rendering & storage" }, h("span", { class: "chip-ico" }), h("span", { class: "chip-txt" }, "Renderer"));
  const tick = async (first) => {
    if (!first && !chip.isConnected) return clearInterval(chipTimer);
    try {
      const st = await api("/api/status");
      const w = st.worker;
      chip.classList.remove("skeleton");
      const ico = chip.querySelector(".chip-ico"), txt = chip.querySelector(".chip-txt");
      chip.dataset.state = w.state;
      if (w.state === "rendering" && w.job) {
        ico.innerHTML = '<i></i><i></i><i></i>';
        txt.textContent = st.book ? `Rendering · ${pct(st.book.ready, st.book.total)}%` : "Rendering";
      } else if (w.state === "paused") { ico.innerHTML = ICON2.pause; txt.textContent = "Paused"; }
      else if (w.state === "error") { ico.innerHTML = ICON2.warn; txt.textContent = "Needs attention"; }
      else { ico.innerHTML = ICON2.check; txt.textContent = "All rendered"; }
    } catch { chip.dataset.state = "offline"; chip.querySelector(".chip-txt").textContent = "Offline"; }
  };
  clearInterval(chipTimer);
  chipTimer = setInterval(tick, 4000);
  tick(true);
  return chip;
};
const topbar = (left, center, ...right) => h("header", { class: "top" }, h("div", { class: "wrap" }, left, center || h("div", { class: "grow" }), ...right));
const brand = () => h("a", { class: "brand", href: "#/" }, h("i"), "reader");
const back = (href, title) => h("a", { class: "iconbtn", href, title, html: ICON.back });
const gear = () => h("a", { class: "iconbtn", href: "#/settings", title: "Settings", html: ICON2.gear });

// ------------------------------------------------------------------ upload
const importing = new Map();     // job id -> {name, state}
const upload = async (file) => {
  if (!file || !/\.epub$/i.test(file.name)) return toast("That isn't an EPUB file");
  const temp = "t" + Date.now();
  importing.set(temp, { name: file.name.replace(/\.epub$/i, "") });
  if (!location.hash || location.hash === "#/") viewLibrary(); else toast(`Adding “${file.name.replace(/\.epub$/i, "")}”…`);
  const fd = new FormData();
  fd.append("file", file);
  try {
    const r = await fetch("/api/books", { method: "POST", body: fd });
    let job = await r.json();
    if (!r.ok) throw new Error(job.detail || r.statusText);
    while (job.state === "importing") {
      await new Promise((res) => setTimeout(res, 1500));
      job = await api(`/api/imports/${job.id}`);
    }
    if (job.state === "error") throw new Error(job.error);
    importing.delete(temp);
    location.hash = `#/book/${job.book}`;
  } catch (e) {
    importing.delete(temp);
    if (!location.hash || location.hash === "#/") viewLibrary();
    toast(`Couldn't add “${file.name}”: ${e.message}`, 6000);
  }
};
const picker = () => {
  const inp = h("input", { type: "file", accept: ".epub,application/epub+zip", hidden: true, onchange: () => upload(inp.files[0]) });
  document.body.append(inp);
  inp.click();
  setTimeout(() => inp.remove(), 60000);
};
let dragDepth = 0;
addEventListener("dragenter", (e) => { if ([...e.dataTransfer.types].includes("Files")) { dragDepth++; $("#drop").hidden = false; } });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#drop").hidden = true; } });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => { e.preventDefault(); dragDepth = 0; $("#drop").hidden = true; upload(e.dataTransfer.files[0]); });

// ------------------------------------------------------------------ library
async function viewLibrary() {
  player.hide();
  const books = await api("/api/books");
  const top = topbar(brand(), null, renderChip(), gear(), h("button", { class: "iconbtn add", title: "Add book", onclick: picker, html: ICON.plus }));
  const main = h("main", { class: "wrap" });
  const recent = books.find((b) => positions.best(b.id, b.position));
  if (recent) {                 // the bottom bar offers it (and plays it in place) until something is playing
    const pos = positions.best(recent.id, recent.position);
    const ch = recent.chapters.find((c) => c.index === pos.chapter);
    player.remember(recent, pos.chapter, ch?.title);
  }
  if (!navigator.onLine) main.append(h("div", { class: "offline-note" }, "You're offline · books on this phone still play"));
  main.append(h("div", { class: "lib-head" }, h("h1", {}, "Library"), books.length ? h("span", { class: "muted" }, `${books.length} book${books.length > 1 ? "s" : ""}`) : null));
  if (!books.length && !importing.size) {
    main.append(h("div", { class: "empty" }, h("h2", {}, "No books yet"), h("p", {}, "Drop an EPUB anywhere on this page, or use +."),
      h("button", { class: "btn", onclick: picker }, "Choose an EPUB")));
  } else {
    const grid = h("div", { class: "grid" });
    for (const [, it] of importing) grid.append(h("div", { class: "card importing" }, h("div", { class: "cover" }, h("span", { class: "spinner" }), "Adding book…"),
      h("div", {}, h("div", { class: "t" }, it.name))));
    for (const b of books) {
      const p = b.progress || {};
      const cv = coverEl(b);
      if (offline.bytes(b.id)) cv.append(h("span", { class: "dl-badge", title: "On this phone", html: ICON2.phone }));
      grid.append(h("a", { class: "card", href: `#/book/${b.id}` }, cv,
        h("div", {}, h("div", { class: "t" }, b.title), h("div", { class: "a" }, b.author)),
        h("div", { class: "bar", title: `${human(p.ready_est)} of ${human(p.total_est)} ready` },
          h("i", { class: "ready", style: `width:${pct(p.ready_est, p.total_est)}%` }),
          h("i", { style: `width:${pct(p.heard_est, p.total_est)}%` }))));
    }
    main.append(grid);
  }
  app.replaceChildren(top, main, ...[player.mini()].filter(Boolean));
}

// ------------------------------------------------------------------ book page
async function viewBook(id) {
  player.hide();
  const b = await api(`/api/books/${id}`);
  const pos = positions.best(id, b.position);
  const playable = b.chapters.filter((c) => c.n_units);
  const cur = (pos && b.chapters.find((c) => c.index === pos.chapter)) || playable.find((c) => c.include);
  const p = b.progress;
  const done = p.ready_est >= p.total_est - 1;
  const top = topbar(back("#/", "Library"), null, renderChip(), gear());

  const state = !b.render ? ["off", "Rendering is off for this book"] : done ? ["done", "Fully rendered"]
    : b.rendering_now ? ["on", "Rendering now" + ((c) => c ? ` · ${chapterLabel(c.title, b.lang)}` : "")(b.chapters.find((c) => c.index === b.rendering_at))] : ["queued", "Queued"];
  const toggleRender = async () => { await api(`/api/books/${id}`, { method: "PATCH", body: JSON.stringify({ render: !b.render }) }); viewBook(id); };
  const renderCard = h("section", { class: "card-box" },
    h("div", { class: "row-between" },
      h("div", {}, h("div", { class: "label" }, h("span", { class: `dot ${state[0]}` }), state[1]),
        h("div", { class: "muted small" }, `${human(p.ready_est)} of ${human(p.total_est)} ready` + (b.render && !done && b.eta ? ` · about ${eta(b.eta)} to go` : ""))),
      done ? null : h("button", { class: "btn ghost sm", onclick: toggleRender }, b.render ? "Pause" : "Start")),
    h("div", { class: "bar thick" }, h("i", { class: "ready", style: `width:${pct(p.ready_est, p.total_est)}%` }), h("i", { style: `width:${pct(p.heard_est, p.total_est)}%` })));

  const list = h("ul", { class: "chapters" });
  for (const c of playable) {
    const frac = c.n_segments ? c.ready / c.n_segments : 0;
    list.append(h("li", { class: cur && c.index === cur.index ? "cur" : "", "data-ch": c.index },
      h("a", { href: `#/read/${id}/${c.index}/0` }, h("span", { class: "ct" }, chapterLabel(c.title, b.lang)),
        h("span", { class: "state" }, offline.has(id, c.index) ? h("span", { class: "ok phone", title: "On this phone", html: ICON2.phone })
          : frac >= 1 ? h("span", { class: "ok", html: ICON2.check }) : h("div", { class: "bar" }, h("i", { class: "ready", style: `width:${frac * 100}%` }))),
        h("span", { class: "dur" }, human(c.est)))));
  }

  const dlBox = h("section", { class: "card-box" });
  const paintDl = () => {
    if (dlBox.isConnected === false && dlBox.dataset.mounted) return offline.listeners.delete(paintDl);
    const mode = offline.mode(id), busy = offline.busy[id], have = offline.index(id);
    const n = Object.keys(have).length;
    const waitingFor = offline.wanted(b, mode).filter((i) => !(i in have) && !b.chapters.find((c) => c.index === i)?.full).length;
    const line = mode === "off" ? "Nothing on this phone yet"
      : busy ? `Downloading ${busy.label} · ${busy.done + 1} of ${busy.total}`
      : `${n} chapter${n === 1 ? "" : "s"} on this phone · ${bytes(offline.bytes(id))}` + (waitingFor ? ` · ${waitingFor} more when rendered` : "");
    fill(dlBox, 
      h("div", { class: "row-between stack" },
        h("div", {}, h("div", { class: "label" }, "Download for offline"), h("div", { class: "muted small" }, line)),
        seg([["off", "Off"], ["next", "Next 3 h"], ["whole", "Whole book"]], mode, async (v) => {
          if (v === "off" && n && !confirm("Remove this book's downloads from this phone?")) return;
          store.set(`dl:${id}`, v); paintDl(); await offline.setMode(id, v);
        })),
      busy ? h("div", { class: "bar thick" }, h("i", { class: "ready", style: `width:${pct(busy.done, busy.total)}%` })) : null);
    for (const li of list.querySelectorAll("li[data-ch]")) {
      const on = offline.has(id, +li.dataset.ch), st = li.querySelector(".state");
      if (on && !st.querySelector(".phone")) fill(st, h("span", { class: "ok phone", title: "On this phone", html: ICON2.phone }));
    }
  };
  offline.listeners.add(paintDl);
  paintDl();
  setTimeout(() => { dlBox.dataset.mounted = "1"; offline.sync(id); }, 0);

  const lang = h("select", { onchange: async () => {
    if (!confirm(`Read this book as ${b.langs[lang.value]}? Its audio will be rendered again from scratch.`)) { lang.value = b.lang; return; }
    await api(`/api/books/${id}`, { method: "PATCH", body: JSON.stringify({ lang: lang.value }) });
    toast(`Language: ${b.langs[lang.value]}`); viewBook(id);
  } }, Object.entries(b.langs).map(([k, v]) => h("option", { value: k, selected: k === b.lang }, v)));
  const settingsBox = h("section", { class: "card-box rows" },
    h("div", { class: "row-between" }, h("div", {}, h("div", { class: "label" }, "Language"), h("div", { class: "muted small" }, "How the text is read: numbers, names, narrator")), lang),
    h("div", { class: "row-between" }, h("div", {}, h("div", { class: "label" }, "Remove book"), h("div", { class: "muted small" }, "Deletes the book, its audio and your place")),
      h("button", { class: "btn danger sm", onclick: async () => {
        if (!confirm(`Remove “${b.title}”?`)) return;
        await api(`/api/books/${id}`, { method: "DELETE" }); location.hash = "#/";
      } }, "Remove")));

  const main = h("main", { class: "wrap narrow" },
    h("section", { class: "book-hero" }, coverEl(b), h("div", {},
      h("h1", {}, b.title), h("div", { class: "by" }, b.author),
      h("div", { class: "muted small" }, `${b.langs[b.lang]} · ${human(p.total_est)}` + (pos && cur ? ` · at ${chapterLabel(cur.title, b.lang)}` : "")))),
    cur ? h("a", { class: "btn wide", href: `#/read/${id}/${cur.index}?play`, html: ICON.play + `<span>${pos ? "Continue" : "Start listening"}</span>` }) : null,
    renderCard, dlBox,
    h("h2", { class: "section" }, "Chapters"), list,
    h("h2", { class: "section" }, "Book"), settingsBox);
  app.replaceChildren(top, main, ...[player.mini()].filter(Boolean));
}

// ------------------------------------------------------------------ rendering & storage
let sysTimer = 0;
async function viewSystem() {
  player.hide();
  const top = topbar(back("#/", "Library"), h("div", { class: "page-title" }, "Rendering & storage"), gear());
  const main = h("main", { class: "wrap narrow" });
  app.replaceChildren(top, main, ...[player.mini()].filter(Boolean));
  const statusBox = h("section", { class: "card-box" }), queueBox = h("section", { class: "card-box rows" }), storeBox = h("section", { class: "card-box rows" });
  const machineBox = h("section", { class: "card-box rows" });
  main.append(statusBox, h("h2", { class: "section" }, "Laptop"), machineBox, h("h2", { class: "section" }, "Books"), queueBox, h("h2", { class: "section" }, "Storage"), storeBox);

  const paint = async () => {
    if (!main.isConnected) return clearInterval(sysTimer);
    const s = await api("/api/system").catch(() => null);
    if (!s) return;
    const w = s.worker, job = w.job, paused = s.settings.paused;
    const cur = job && s.queue.find((q) => q.id === job.book);
    fill(statusBox, 
      h("div", { class: "row-between" },
        h("div", {}, h("div", { class: "label big" }, h("span", { class: `dot ${paused ? "off" : w.state === "rendering" ? "on" : w.state === "error" ? "err" : "done"}` }),
          paused ? "Paused" : w.state === "rendering" ? "Rendering" : w.state === "error" ? "Something went wrong" : "Idle — nothing left to render"),
          job && !paused ? h("div", { class: "muted small" }, `${job.title} · ${chapterLabel(job.chapter_title, cur?.lang)}, part ${job.segment + 1} of ${job.of}`) : null,
          ...(!paused ? (w.lanes || []).map((l) => h("div", { class: "muted small" }, `Also: ${l.title} · ${chapterLabel(l.chapter_title, s.queue.find((q) => q.id === l.book)?.lang)}, part ${l.segment + 1} of ${l.of}`)) : []),
          w.state === "error" ? h("div", { class: "muted small" }, w.error || "") : null),
        h("button", { class: "btn sm" + (paused ? "" : " ghost"), onclick: async () => { await api("/api/system", { method: "PUT", body: JSON.stringify({ paused: !paused }) }); paint(); } }, paused ? "Resume" : "Pause all")),
      cur ? h("div", { class: "bar thick" }, h("i", { class: "ready", style: `width:${pct(cur.ready, cur.total)}%` })) : null,
      h("div", { class: "stats" },
        h("div", {}, h("b", {}, w.rate ? `${w.rate.toFixed(1)}×` : "—"), h("span", {}, "speed")),
        h("div", {}, h("b", {}, cur ? `${pct(cur.ready, cur.total)}%` : "—"), h("span", {}, "book ready")),
        h("div", {}, h("b", {}, cur && cur.eta != null ? short(cur.eta) : "—"), h("span", {}, "left"))),
      h("div", { class: "row-between stack top-gap" }, h("div", {}, h("div", { class: "label" }, "CPU for rendering"), h("div", { class: "muted small" }, "More is faster, but the laptop gets busier and warmer")),
        seg([[2, "Low"], [4, "Medium"], [8, "High"]], s.settings.threads, async (v) => { await api("/api/system", { method: "PUT", body: JSON.stringify({ threads: v }) }); paint(); })));
    if (s.machine) fill(machineBox, ...machineRows(s.machine, w.state === "rendering" && !paused));
    fill(queueBox, ...(s.queue.length ? s.queue.map((q) => h("div", { class: "row-between" },
      h("a", { class: "grow", href: `#/book/${q.id}` }, h("div", { class: "label" }, q.title),
        h("div", { class: "muted small" }, q.ready >= q.total - 1 ? `Fully rendered · ${human(q.total)}` : `${human(q.ready)} of ${human(q.total)} ready` + (q.render && q.eta != null ? ` · ${eta(q.eta)} to go` : q.render ? "" : " · off")),
        h("div", { class: "bar" }, h("i", { class: "ready", style: `width:${pct(q.ready, q.total)}%` }))),
      q.ready >= q.total - 1 ? null : switchEl(q.render, async (on) => { await api(`/api/books/${q.id}`, { method: "PATCH", body: JSON.stringify({ render: on }) }); paint(); }, "Render this book")))
      : [h("div", { class: "muted" }, "No books yet.")]));
  };
  const paintStorage = async () => {
    fill(storeBox, h("div", { class: "muted small" }, "Measuring…"));
    const st = await api("/api/storage").catch(() => null);
    if (!st) return;
    const rows = [h("div", { class: "row-between" }, h("div", {}, h("div", { class: "label" }, "Free space on the laptop"), h("div", { class: "muted small" }, `${bytes(st.disk_free)} free of ${bytes(st.disk_total)}`)))];
    for (const b of st.books) rows.push(h("div", { class: "row-between" }, h("div", {}, h("div", { class: "label" }, b.title), h("div", { class: "muted small" }, `Audio ${bytes(b.audio)}`)),
      b.audio ? h("button", { class: "btn ghost sm", onclick: async () => {
        if (!confirm(`Delete the rendered audio of “${b.title}”? It will be rendered again when needed.`)) return;
        const r = await api(`/api/books/${b.id}/audio`, { method: "DELETE" }); toast(`Freed ${bytes(r.freed)}`); paintStorage();
      } }, "Clear audio") : null));
    rows.push(h("div", { class: "row-between" }, h("div", {}, h("div", { class: "label" }, "Sentence cache"),
      h("div", { class: "muted small" }, `${bytes(st.cache)} · ${st.cache_stale ? `${bytes(st.cache_stale)} no longer used` : "all in use"}`)),
      st.cache_stale ? h("button", { class: "btn ghost sm", onclick: async () => { const r = await api("/api/storage/clean", { method: "POST" }); toast(`Freed ${bytes(r.freed)}`); paintStorage(); } }, "Clean up") : null));
    fill(storeBox, ...rows);
  };
  clearInterval(sysTimer);
  sysTimer = setInterval(paint, 4000);
  await paint();
  paintStorage();
}

// what the laptop is doing: the reader's share of CPU and memory next to everything else's, swap, heat, power
function machineRows(m, rendering) {
  const gb = (b) => b == null ? "—" : `${(b / 2 ** 30).toFixed(1)} GB`;     // GiB, like the limit in the service file
  const meter = (parts, total, cap) => {    // parts: [[value, class]], drawn left to right; the rest is free
    const el = h("div", { class: "meter" });
    for (const [v, cls] of parts) if (v > 0) el.append(h("i", { class: cls, style: `width:${Math.min(100, 100 * v / total).toFixed(1)}%` }));
    el.append(h("i", { class: "rest" }));
    if (cap) el.append(h("b", { class: "cap", style: `left:${Math.min(100, 100 * cap / total).toFixed(1)}%`, title: "The reader's memory limit" }));
    return el;
  };
  const key = (cls, text) => h("span", { class: "key" }, h("i", { class: `sw ${cls}` }), text);
  const block = (label, value, bar, ...notes) => h("div", { class: "mrow" },
    h("div", { class: "row-between" }, h("div", { class: "label" }, label), h("div", { class: "num" }, value)), bar,
    ...notes.filter(Boolean).map((n) => h("div", { class: "muted small" }, n)));
  const rows = [];
  if (m.cpu != null) {
    const mine = m.cpu_reader ?? 0, other = Math.max(0, m.cpu - mine);
    const hot = m.temp != null && m.temp >= 85;
    rows.push(block("CPU", `${Math.round(m.cpu)}%`, meter([[mine, "me"], [other, "other"]], 100),
      h("span", {}, key("me", `Reader ${Math.round(mine)}%`), key("other", `Everything else ${Math.round(other)}%`)),
      [`${m.cores} cores`, m.temp != null ? `${Math.round(m.temp)} °C${hot ? " · hot: Low rendering would cool it down" : ""}` : null].filter(Boolean).join(" · ")));
  }
  if (m.mem_total) {
    const used = m.mem_total - m.mem_available, mine = Math.min(m.mem_reader || 0, used), other = Math.max(0, used - mine);
    const cap = m.mem_reader_max || m.mem_reader_high;
    rows.push(block("Memory", `${gb(used)} of ${gb(m.mem_total)}`, meter([[mine, "me"], [other, "other"]], m.mem_total, cap),
      h("span", {}, key("me", `Reader ${gb(mine)}${cap ? ` (limit ${gb(cap)})` : ""}`), key("other", `Everything else ${gb(other)}`)),
      `${gb(m.mem_available)} free${m.swap_used > 2e8 ? ` · ${gb(m.swap_used)} of ${gb(m.swap_total)} swapped to disk` : ""}`));
  }
  if (m.power) {
    const p = m.power;
    rows.push(h("div", { class: "row-between" }, h("div", {}, h("div", { class: "label" }, "Power"),
      h("div", { class: "muted small" }, p.plugged ? `Plugged in · battery ${p.battery}%` : `On battery · ${p.battery}%${rendering ? " · rendering drains it faster" : ""}`))));
  }
  return rows;
}

// ------------------------------------------------------------------ settings
function viewSettings() {
  player.hide();
  const top = topbar(back("#/", "Library"), h("div", { class: "page-title" }, "Settings"), h("span", { class: "iconbtn", "aria-hidden": "true" }));
  const row = (label, hint, control) => h("div", { class: "row-between" + (control.classList.contains("segctl") ? " stack" : "") }, h("div", {}, h("div", { class: "label" }, label), hint ? h("div", { class: "muted small" }, hint) : null), control);
  const repaint = () => viewSettings();
  const dlIds = Object.keys(localStorage).filter((k) => k.startsWith("reader:dlx2:")).map((k) => k.slice(12));
  const dlTotal = dlIds.reduce((a, id) => a + offline.bytes(id), 0);
  const dlHint = h("div", { class: "muted small" }, dlTotal ? `${bytes(dlTotal)} of downloaded audio` : "Nothing downloaded");
  navigator.storage?.estimate?.().then((e) => { if (e.quota) dlHint.textContent += ` · room for about ${bytes(Math.max(0, e.quota - e.usage))} more`; }).catch(() => {});
  const dlRow = h("div", { class: "row-between" }, h("div", {}, h("div", { class: "label" }, "Downloads"), dlHint),
    dlTotal ? h("button", { class: "btn ghost sm", onclick: async () => {
      if (!confirm("Remove all downloaded books from this phone? Your place in each book is kept.")) return;
      for (const id of dlIds) { store.set(`dl:${id}`, "off"); await offline.dropAll(id); }
      toast("Downloads removed"); repaint();
    } }, "Remove all") : null);
  const main = h("main", { class: "wrap narrow" },
    h("h2", { class: "section" }, "Listening"),
    h("section", { class: "card-box rows" },
      row("Go back after a stop", "When playback stops (pause, call, navigation), resume a little earlier", seg([["off", "Off"], ["short", "Less"], ["normal", "Normal"], ["long", "More"]], prefs.rewind, (v) => { prefs.rewind = v; repaint(); })),
      row("Skip buttons", null, seg([[10, "10 s"], [15, "15 s"], [30, "30 s"]], prefs.skip, (v) => { prefs.skip = v; repaint(); })),
      row("Continue to the next chapter", null, switchEl(prefs.autoNext, (v) => { prefs.autoNext = v; repaint(); }))),
    h("h2", { class: "section" }, "Reading"),
    h("section", { class: "card-box rows" },
      row("Highlight", null, seg([["both", "Sentence + word"], ["sentence", "Sentence"], ["off", "Off"]], prefs.highlight, (v) => { prefs.highlight = v; repaint(); })),
      row("Follow the narration", "Scroll the text along while listening", switchEl(prefs.follow, (v) => { prefs.follow = v; repaint(); })),
      row("Keep the screen on", "While listening with the text open", switchEl(prefs.wake, (v) => { prefs.wake = v; repaint(); })),
      row("Text size", null, seg([17, 19, 21, 23, 26].map((z) => [z, String(z)]), store.get("size", 21), (v) => { store.set("size", v); applyLook(); repaint(); })),
      row("Theme", null, seg([["auto", "Auto"], ["light", "Light"], ["sepia", "Sepia"], ["dark", "Dark"], ["black", "Black"]], store.get("theme", "auto"), (v) => { store.set("theme", v); applyLook(); repaint(); }))),
    h("h2", { class: "section" }, "This phone"),
    h("section", { class: "card-box rows" }, dlRow),
    h("h2", { class: "section" }, "Rendering"),
    h("section", { class: "card-box rows" }, h("a", { class: "row-between", href: "#/system" }, h("div", {}, h("div", { class: "label" }, "Rendering & storage"), h("div", { class: "muted small" }, "Progress, pause, CPU use, disk space")), h("span", { class: "chev", html: ICON2.chev }))),
    h("p", { class: "muted small center" }, "Preferences on this page are saved on this device."));
  app.replaceChildren(top, main, ...[player.mini()].filter(Boolean));
}

// ------------------------------------------------------------------ reader + player
//
// The audio is one continuous stream per book (MediaSource). The player appends ~2 s fragments of each rendered
// file (a whole chapter, or the ~75 s pieces of a chapter that is still rendering), file after file and chapter
// after chapter, staying about two minutes ahead of the playhead. The <audio> element never ends and never changes
// source between chapters. That matters on the iPhone: when an element ends while the screen is locked, iOS closes
// the web app's audio session and won't let it start the next file until the app is on screen again.
// Anchors map stream time <-> (chapter, file, seconds into the file). Everything the UI shows is chapter time.

const MSE = window.ManagedMediaSource || window.MediaSource;
try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch {}   // Safari: this page plays media, not UI sounds
const MIME = 'audio/mp4; codecs="mp4a.40.2"';
const AHEAD = 120;          // seconds of audio kept buffered past the playhead
const BEHIND = 40;          // ... and kept behind it, so short rewinds are instant
const LEAD = 20;            // a jump starts appending this much earlier than its target, for the same reason
const BATCH = 384 * 1024;   // bytes per request

const skipIcon = (dir) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${dir < 0
  ? '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/>' : '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4h-4"/>'}<text x="12" y="15.5" font-size="7.5" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui" font-weight="700">${prefs.skip}</text></svg>`;
const SPEED_PRESETS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

// how far to go back when playback resumes after stopping (pause, call, Siri, navigation prompt...)
const rewindFor = (ms) => (ms < 1500 ? 0 : ms < 30e3 ? 4 : ms < 5 * 60e3 ? 8 : ms < 60 * 60e3 ? 15 : 30) * (REWIND_SCALE[prefs.rewind] ?? 1);

const player = {
  book: null, ch: null, chs: new Map(), ut: [], clauses: new Map(), curClause: null, unitEls: [], cur: -1, curWord: null, follow: true, tape: null,
  target: null, waiting: null, pollTimer: 0, stallTimer: 0, retryTimer: 0, retry: 0, stoppedAt: 0, startT: 0, raf: 0, root: null, userPaused: true,

  // leaving the reader: its page goes, the audio keeps playing (other screens show the now-playing bar)
  hide() {
    document.body.classList.remove("has-player");
    this.wake(false);
    removeEventListener("scroll", this.onScroll);
    cancelAnimationFrame(this.raf);
    this.root = null;
  },

  async open(bookId, chIndex, unit, autoplay, view = true) {
    this.opening = true;          // until the jump below is under way, the audio may still be in another chapter
    try { await this.openIn(bookId, chIndex, unit, autoplay, view); } finally { this.opening = false; }
  },
  async openIn(bookId, chIndex, unit, autoplay, view) {
    this.hide();
    if (view) document.body.classList.add("has-player");
    this.follow = prefs.follow;
    const same = !!this.tape && this.book?.id === bookId;      // this book's stream is already going: keep it
    if (!same) {                                      // another book: stop this one and its pending retries
      audio.pause();
      for (const k of ["waiting", "retryTimer", "pollTimer", "stallTimer"]) clearTimeout(this[k]);
      this.waiting = null;
    }
    const b = await api(`/api/books/${bookId}`);
    if (!same) this.chs = new Map();
    this.book = b;
    const here = same && this.map(audio.currentTime)?.n === chIndex;
    if (!same) this.newTape();
    const e = await this.entry(chIndex, !here);     // the chapter in the stream keeps its files (anchors point at them)
    this.ch = e.c; this.cur = -1; this.curWord = null;
    this.remember(b, chIndex, e.c.title);
    if (view) this.render(); else { this.unitEls = []; this.paintMini(); }
    this.layout();
    this.speed(store.get(`speed:${bookId}`, 1));
    if (!this.tape) { this.setState("error", "This browser can't play audio streams"); return; }
    this.media();
    if (here && !Number.isFinite(unit)) {            // back to the chapter that is playing: just show it
      this.startT = this.chapterTime();
      this.setCurrent(this.unitAtTime(this.startT)?.i ?? 0, true);
      this.setPlayIcon(audio.paused);
      this.loop();
      if (autoplay && audio.paused) this.toggle();
      return;
    }
    // where to start: an explicit unit, else the saved position (with a rewind for how long we were away)
    const pos = positions.best(bookId, b.position);
    let T = 0;
    if (Number.isFinite(unit)) T = this.timeOfUnit(unit);
    else if (pos && pos.chapter === chIndex) T = this.snapBack(this.resolve(pos), rewindFor(Date.now() - (pos.at || 0)));
    this.startT = T;
    this.setCurrent(this.unitAtTime(T)?.i ?? (Number.isFinite(unit) ? unit : 0), true);
    api(`/api/books/${bookId}/focus`, { method: "POST", body: JSON.stringify({ chapter: chIndex, unit: Math.max(this.cur, 0) }) }).catch(() => {});
    this.loop();
    // loads the audio around T (and plays it if asked), so a later tap on play starts instantly, inside the tap (iOS)
    await this.seek(T, !!autoplay || (same && !audio.paused));
  },

  // ---------- the stream
  newTape() {
    if (this.tape) { this.tape.gen++; this.tape.ctl?.abort(); URL.revokeObjectURL(this.tape.url); this.tape = null; }
    if (!MSE || !MSE.isTypeSupported?.(MIME)) return;
    const ms = new MSE();
    const tp = { ms, sb: null, url: URL.createObjectURL(ms), anchors: [], cur: null, end: 0, top: 0, gen: 0, eos: false, queued: false, ctl: null, blocked: null };
    tp.q = new Promise((res) => ms.addEventListener("sourceopen", () => {
      tp.sb = ms.addSourceBuffer(MIME);
      tp.sb.mode = "sequence";       // each new file continues exactly where the previous one ended
      tp.sb.addEventListener("bufferedchange", () => this.pump());    // ManagedMediaSource evicted something
      res();
    }, { once: true }));
    ms.addEventListener("startstreaming", () => this.pump());
    if (window.ManagedMediaSource && MSE === window.ManagedMediaSource) audio.disableRemotePlayback = true;   // required by ManagedMediaSource
    audio.src = tp.url;
    this.mediaErrors = 0;
    this.tape = tp;
  },

  // chapter n: its text and its audio files ("full" once the chapter is rendered, else its render pieces)
  async entry(n, reload = false) {
    const old = this.chs.get(n);
    if (old && !reload) return old;
    const c = await api(`/api/books/${this.book.id}/chapters/${n}`);
    const e = { n, c, files: c.full ? [{ n, part: "full", ready: true, dur: 0 }]
      : c.segments.map((s, k) => ({ n, part: k, ready: s.ready, dur: s.est, u0: s.u0, u1: s.u1 })) };
    for (const f of e.files) {       // keep fragment tables already loaded (unless that audio was rebuilt since)
      const o = !old?.stale && old?.files.find((x) => x.part === f.part);
      if (o?.idx) Object.assign(f, { idx: o.idx, dur: o.dur, ready: true, init: o.init, blob: o.blob });
    }
    await Promise.all(e.files.filter((f) => f.ready && !f.idx).map((f) => this.loadFile(f).catch(() => {})));
    this.chs.set(n, e);
    const sig = (ch) => ch.units.map((u) => `${u.block}:${u.start}`).join();
    if (this.root && this.ch?.index === n && sig(this.ch) !== sig(c)) { this.ch = c; this.render(); }   // re-segmented meanwhile
    this.relayout(e);
    return e;
  },
  async loadFile(f) {
    const ix = await api(`/api/books/${this.book.id}/stream/${f.n}/${f.part}.json`);
    Object.assign(f, { idx: ix, ready: true, dur: ix.duration });
    return f;
  },
  // a chapter still rendering: pick up newly rendered pieces in place (anchors keep pointing at the same files)
  async refresh(n) {
    const e = this.chs.get(n);
    if (!e || e.c.full) return;
    const c = await api(`/api/books/${this.book.id}/chapters/${n}`);
    c.segments.forEach((s, k) => { if (e.files[k] && s.ready) e.files[k].ready = true; });
    await Promise.all(e.files.filter((f) => f.ready && !f.idx).map((f) => this.loadFile(f).catch(() => {})));
    this.relayout(e);
  },
  relayout(e) {      // file start offsets and the chapter's unit/word times, once real durations are known
    let t = 0;
    for (const f of e.files) { f.offset = t; t += f.dur || 0; }
    e.total = t;
    e.units = [];
    for (const f of e.files) if (f.idx) for (const u of f.idx.units) e.units.push({ i: u.i, t0: u.t0 + f.offset, t1: u.t1 + f.offset,
      words: (u.words || []).map(([a, b, w0, w1]) => [a, b, w0 + f.offset, w1 + f.offset]) });
    if (this.ch && e.n === this.ch.index) this.layout();
  },
  layout() {         // the current chapter's timing changed: unit times, and on the reader its word spans and scrubber
    const e = this.chs.get(this.ch.index);
    this.ut = e?.units || [];
    if (!this.root) return;
    for (const u of this.ut) this.wordify(u);
    this.paintScrub();
  },
  nextChapter(n) {
    const chs = this.book.chapters.filter((c) => c.include && c.n_units);
    const k = chs.findIndex((c) => c.index === n);
    return k >= 0 && k + 1 < chs.length ? chs[k + 1].index : null;
  },
  fileAt(e, t) {
    const k = e.files.findIndex((f) => t < f.offset + (f.dur || 0));
    return k < 0 ? e.files.length - 1 : k;
  },

  // stream time -> {n: chapter, t: seconds into it}
  map(T) {
    const tp = this.tape;
    let a = null;
    for (const x of tp?.anchors || []) { if (x.tape <= T + 1e-3) a = x; else break; }
    const f = a && this.chs.get(a.n)?.files[a.fi];
    if (!f) return null;
    const ft = a.ft + (T - a.tape);
    return { n: a.n, t: f.offset + Math.min(ft, f.dur || ft) };
  },
  // chapter n at t s -> stream time, if that audio is buffered right now
  tapeFor(n, t) {
    const tp = this.tape, e = this.chs.get(n);
    if (!tp?.sb || !e) return null;
    const fi = this.fileAt(e, t), f = e.files[fi];
    const a = tp.anchors.find((x) => x.n === n && x.fi === fi);
    if (!a || t - f.offset < a.ft - 0.01) return null;
    const T = a.tape + (t - f.offset - a.ft);
    return this.buffered(T) ? T : null;
  },
  buffered(T, margin = 0.3) {
    const b = this.tape?.sb?.buffered;
    if (b) for (let i = 0; i < b.length; i++) if (b.start(i) - 0.1 <= T && T < b.end(i) - margin) return true;
    return false;
  },
  aheadOf(T) {
    const b = this.tape?.sb?.buffered;
    if (b) for (let i = 0; i < b.length; i++) if (b.start(i) - 0.1 <= T && T <= b.end(i)) return b.end(i) - T;
    return 0;
  },

  // every SourceBuffer operation runs through this queue, one at a time
  exclusive(fn) {
    const tp = this.tape;
    const run = tp.q.then(fn);
    tp.q = run.catch(() => {});
    return run;
  },
  pump() {
    const tp = this.tape;
    if (!tp || tp.queued || !tp.cur || tp.eos || this.target) return;   // a pending jump does its own appending
    tp.queued = true;
    this.exclusive(async () => { tp.queued = false; await this.fill(tp, tp.gen); }).catch((e) => this.pumpFailed(tp, e));
  },
  // append until AHEAD seconds are buffered past the playhead; with `batches`, append exactly that many and stop
  async fill(tp, gen, batches = 0) {
    for (let k = 0; gen === tp.gen && tp.cur && !tp.eos; k++) {
      if (batches && k >= batches) return;
      if (!batches) {
        const ahead = this.aheadOf(audio.currentTime);
        if (ahead > AHEAD || (tp.ms.streaming === false && ahead > 15)) return;   // ManagedMediaSource: "enough for now"
      }
      const step = await this.nextBatch(tp, gen);
      if (!step || gen !== tp.gen) return;
      await this.appendBatch(tp, gen, step);
      this.retry = 0;
    }
  },
  async nextBatch(tp, gen) {
    for (;;) {
      const c = tp.cur, e = (!this.chs.get(c.n)?.stale && this.chs.get(c.n)) || await this.entry(c.n, true);
      if (gen !== tp.gen) return null;
      const file = e.files[c.fi];
      if (!file) {                   // past the chapter's last file: carry on with the next chapter
        const nx = this.nextChapter(c.n);
        if (nx == null || !prefs.autoNext) { this.endStream(tp); return null; }
        await this.entry(nx);
        tp.cur = { n: nx, fi: 0, f: 0, fresh: true };
        continue;
      }
      if (!file.idx) {
        if (!file.ready) await this.refresh(c.n);
        if (!file.ready) { tp.blocked = file; this.awaitRender(file); return null; }
        await this.loadFile(file);
        this.relayout(e);
      }
      tp.blocked = null;
      const fr = file.idx.frags;
      if (c.f >= fr.length) { tp.cur = { n: c.n, fi: c.fi + 1, f: 0, fresh: true }; continue; }
      let j = c.f + 1;
      while (j < fr.length && fr[j][0] + fr[j][1] - fr[c.f][0] <= BATCH) j++;
      return { e, file, f0: c.f, f1: j };
    }
  },
  async appendBatch(tp, gen, { e, file, f0, f1 }) {
    const fr = file.idx.frags;
    const data = await this.read(tp, file, fr[f0][0], fr[f1 - 1][0] + fr[f1 - 1][1]);
    if (gen !== tp.gen) return;
    if (tp.cur.fresh) {              // a new file: its init segment, and an anchor where its audio starts
      file.init ||= await this.read(tp, file, file.idx.init[0], file.idx.init[1]);
      if (gen !== tp.gen) return;
      await this.append(tp, file.init);
      tp.anchors.push({ tape: tp.end, n: file.n, fi: e.files.indexOf(file), ft: fr[f0][2] });
      tp.cur.fresh = false;
    }
    try { await this.append(tp, data); }
    catch (err) {                    // buffer full (iOS keeps it small): drop more of what was already played, retry once
      if (err.name !== "QuotaExceededError") throw err;
      await this.trim(tp, 5);
      await this.append(tp, data);
    }
    tp.cur.f = f1;
    const b = tp.sb.buffered;
    if (b.length) { tp.end = b.end(b.length - 1); tp.top = Math.max(tp.top, tp.end); }
    await this.trim(tp);
  },
  async read(tp, file, a, b) {
    if (file.part === "full" && offline.version(this.book.id, file.n) === file.idx.v) {   // downloaded: no network
      file.blob ||= await offline.blob(this.book.id, file.n);
      if (file.blob) return file.blob.slice(a, b).arrayBuffer();
    }
    tp.ctl = new AbortController();
    const r = await fetch(`/api/books/${this.book.id}/stream/${file.n}/${file.part}.mp4?v=${file.idx.v}`,
      { headers: { range: `bytes=${a}-${b - 1}` }, signal: tp.ctl.signal });
    if (r.status === 410 || r.status === 404) {   // rebuilt or gone since we loaded its table (new voice, pipeline upgrade)
      const e = this.chs.get(file.n);
      if (e) e.stale = true;
      throw Object.assign(new Error(`audio was rebuilt (${r.status})`), { name: "Stale" });
    }
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { name: r.status >= 500 ? "Server" : "Http" });
    const buf = await r.arrayBuffer();
    return r.status === 206 ? buf : buf.slice(a, b);
  },
  append(tp, buf) {
    return new Promise((res, rej) => {
      const sb = tp.sb;
      const off = () => { sb.removeEventListener("updateend", ok); sb.removeEventListener("error", bad); };
      const ok = () => { off(); res(); }, bad = () => { off(); rej(new Error("append failed")); };
      sb.addEventListener("updateend", ok); sb.addEventListener("error", bad);
      try { sb.appendBuffer(buf); } catch (e) { off(); rej(e); }
    });
  },
  sbDo(tp, fn) {
    return new Promise((res) => {
      const ok = () => { tp.sb.removeEventListener("updateend", ok); res(); };
      tp.sb.addEventListener("updateend", ok);
      try { fn(); } catch { tp.sb.removeEventListener("updateend", ok); res(); }
    });
  },
  async trim(tp, keep = BEHIND) {
    const b = tp.sb.buffered, cut = audio.currentTime - keep;
    if (b.length && b.start(0) < cut - (keep === BEHIND ? 20 : 0)) await this.sbDo(tp, () => tp.sb.remove(b.start(0), cut));
  },
  endStream(tp) {
    tp.eos = true; tp.cur = null;
    if (tp.ms.readyState === "open" && !tp.sb.updating) try { tp.ms.endOfStream(); } catch {}
  },
  // move the stream to chapter n at t s: drop the buffer and append from there.
  // "ok", "stale" (a newer jump took over) or "pending" (that part isn't rendered yet)
  rebase(n, t) {
    const tp = this.tape;
    const gen = ++tp.gen;
    tp.ctl?.abort();
    tp.anchors = [];                 // until the new audio is in, the UI shows the target (startT)
    return this.exclusive(async () => {
      if (gen !== tp.gen) return "stale";
      const e = await this.entry(n, true);
      if (gen !== tp.gen) return "stale";
      const fi = this.fileAt(e, t), file = e.files[fi];
      if (!file.ready) return "pending";
      if (!file.idx) { await this.loadFile(file); this.relayout(e); }
      if (gen !== tp.gen) return "stale";
      const fr = file.idx.frags, ft = t - file.offset;
      const sb = tp.sb;
      if (tp.ms.readyState === "open") try { sb.abort(); } catch {}
      if (sb.buffered.length) await this.sbDo(tp, () => sb.remove(0, tp.top + 3600));
      const P = Math.ceil(tp.top) + 1;              // stream time only grows: anchors never overlap
      sb.timestampOffset = P;
      Object.assign(tp, { end: P, top: P, eos: false, cur: { n, fi, f: Math.max(0, fr.findLastIndex((x) => x[2] <= ft - LEAD)), fresh: true } });
      for (let k = 0; k < 4 && gen === tp.gen && this.tapeFor(n, t) == null && tp.cur; k++) await this.fill(tp, gen, 1);
      if (gen !== tp.gen) return "stale";
      const T = this.tapeFor(n, t);
      if (T == null) throw new Error("couldn't load audio");
      audio.currentTime = T;
      return "ok";
    }).finally(() => this.pump());
  },
  awaitRender(file) {
    clearTimeout(this.pollTimer);
    api(`/api/books/${this.book.id}/focus`, { method: "POST", body: JSON.stringify({ chapter: file.n, unit: file.u0 ?? 0 }) }).catch(() => {});
    this.pollTimer = setTimeout(async () => { if (this.tape) { await this.refresh(file.n).catch(() => {}); this.pump(); } }, 4000);
  },
  pumpFailed(tp, e) {
    if (e?.name === "AbortError" || tp !== this.tape) return;
    clog("stream-error", `${e?.name}: ${e?.message}`);
    clearTimeout(this.retryTimer);
    if (e?.name === "Stale") {        // that audio was rebuilt: stop appending it, reload the chapter where we are
      tp.gen++;                       // anything still in flight for the old audio is dropped
      tp.cur = null;
      this.target ||= { n: this.ch.index, t: this.chapterTime(), play: !audio.paused || !this.userPaused };
      this.retryTimer = setTimeout(() => this.recover(true), 300);
      return;
    }
    if (e?.name === "QuotaExceededError") { this.retryTimer = setTimeout(() => this.recover(), 3000); return; }
    const affected = this.target || this.state === "loading" || (!audio.paused && this.aheadOf(audio.currentTime) < 8);
    if (!navigator.onLine && affected) { this.target = null; return this.setState("error", "You're offline and this part isn't downloaded"); }
    if (this.retry >= 6 && affected) {           // ~1 min of trying: stop and say so; play tries again
      this.target = null; this.retry = 0;
      this.holding = true; audio.pause(); this.holding = false;
      return this.setState("error", "Can't reach the reader server · tap play to try again");
    }
    const wait = Math.min(20000, 1500 * 2 ** this.retry++);
    if (affected) this.setState("loading", e?.name === "Server" || e?.status >= 500 ? "The server is restarting · one moment" : `Connection lost · retrying in ${Math.round(wait / 1000)} s`);
    this.retryTimer = setTimeout(() => this.recover(), wait);
  },
  // after a failure: finish the jump that was interrupted, or get the playhead back onto audio, or just keep buffering
  recover(force = false) {
    const tp = this.tape;
    if (!tp) return;
    const w = this.target;
    clog("recover", w ? `jump to ${Math.round(w.t)}` : force ? "reload" : "pump");
    if (w && w.n === this.ch.index) return this.seek(w.t, w.play, undefined, force);
    if (force || (!audio.paused && !this.buffered(audio.currentTime, 0.05) && !tp.blocked)) return this.seek(this.chapterTime(), !audio.paused || !this.userPaused, undefined, true);
    this.pump();
  },
  // the playhead ran out of audio
  onStall() {
    clearTimeout(this.stallTimer);
    this.stallAt = Date.now();
    this.stallTimer = setTimeout(() => {      // short stalls (a seek, a fragment boundary) never show
      const tp = this.tape;
      if (!tp || audio.paused || this.userPaused || audio.readyState >= 3) return;
      if (tp.blocked) { clog("stall", "waiting for render"); return this.showWaiting(tp.blocked, "ahead"); }
      if (this.state === "playing") this.setState("loading");             // buffering: show it
      if (!this.buffered(audio.currentTime, 0.05) && !tp.queued) {     // evicted or a gap: pick up where we are
        clog("stall", `no audio at the playhead (ahead ${this.aheadOf(audio.currentTime).toFixed(1)} s)`);
        const m = this.map(audio.currentTime);
        this.seek(m ? m.t : this.chapterTime(), true, undefined, true);
      }
    }, 1500);
  },
  onMediaError() {
    if (!this.tape || audio.src !== this.tape.url) return;
    // the stream broke (a decode error): start a fresh one at the same place
    clog("media-error", `${audio.error?.code} ${audio.error?.message || ""}`);
    if (++this.mediaErrors > 3) return this.setState("error", "Playback failed · reopen the chapter");
    const T = this.chapterTime(), play = !this.userPaused, errs = this.mediaErrors;
    this.newTape();
    this.mediaErrors = errs;
    this.seek(T, play);
  },
  // the playhead crossed into the next chapter: show it (synchronous: its data was fetched when it was appended)
  enterChapter(n) {
    const e = this.chs.get(n);
    if (!e) return;
    this.ch = e.c; this.cur = -1; this.curWord = null; this.clauses = new Map();
    clog("chapter", `entered ${n}`);
    this.remember(this.book, n, e.c.title);
    if (this.root) {
      this.render();
      this.layout();
      this.speed(audio.playbackRate);
      this.setPlayIcon(audio.paused);
      history.replaceState(null, "", `#/read/${this.book.id}/${n}`);
    } else this.layout();
    this.media();
    this.paintMini();
    this.save();
    setTimeout(() => offline.sync(this.book.id), 5000);
  },

  // ---------- time
  // a saved position -> chapter time. Positions name their sentence by its place in the text, so they survive a
  // pipeline upgrade (new sentence numbers) and a re-render (new timings); older ones only have unit + seconds.
  resolve(pos) {
    if (pos.block == null) return pos.t ?? this.timeOfUnit(pos.unit);
    const i = this.ch.units.findIndex((u) => u.block === pos.block && u.start <= pos.start && pos.start < Math.max(u.end, u.start + 1));
    if (i < 0) return this.timeOfUnit(pos.unit);
    const ut = this.ut.find((x) => x.i === i);
    return this.timeOfUnit(i) + (i === pos.unit && ut ? Math.min(pos.du || 0, ut.t1 - ut.t0) : 0);
  },
  unitAtTime(T) {
    const us = this.ut;
    let lo = 0, hi = us.length - 1, k = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (us[mid].t0 <= T + 0.02) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    return us[Math.max(0, k)];
  },
  timeOfUnit(i) {
    const u = this.ut.find((x) => x.i === i);
    if (u) return u.t0;
    const f = this.chs.get(this.ch.index)?.files.find((q) => q.u0 != null && q.u0 <= i && i < q.u1);
    return f ? f.offset : 0;
  },
  // go back `sec`, then land on a natural break in the speech (a pause between words), never mid-word
  snapBack(T, sec) {
    if (!sec) return T;
    const target = Math.max(0, T - sec);
    const words = [];
    for (const u of this.ut) for (const w of u.words || []) words.push([w[2], w[3]]);
    let best = null;
    for (let j = 1; j < words.length; j++) {
      const gapStart = words[j - 1][1], next = words[j][0];
      if (next > target) break;
      if (next >= target - 4 && next - gapStart >= 0.18) best = next;
    }
    if (best == null) best = words.findLast((w) => w[0] <= target)?.[0] ?? target;
    return Math.max(0, best - 0.08);
  },
  chapterTime() {
    const m = this.tape && this.map(audio.currentTime);
    return m && m.n === this.ch?.index ? m.t : this.startT || 0;
  },
  chapterTotal() { return this.chs.get(this.ch?.index)?.total || 0; },

  // ---------- DOM
  render() {
    const b = this.book, ch = this.ch;
    this.clauses = new Map(); this.curClause = null;
    const top = h("header", { class: "top reader-top" }, h("div", { class: "wrap" },
      h("a", { class: "iconbtn", href: `#/book/${b.id}`, title: b.title, html: ICON.back }),
      h("div", { class: "titles" }, h("div", { class: "kicker" }, b.title), h("div", { class: "ttl" }, chapterLabel(ch.title, b.lang))),
      h("button", { class: "iconbtn", title: "Text", html: ICON.type, onclick: (e) => this.sheet("look", e) })));
    this.$top = top;
    const page = h("article", { class: "page", lang: b.lang, "data-hl": prefs.highlight });
    const byBlock = new Map();
    ch.units.forEach((u) => { if (!byBlock.has(u.block)) byBlock.set(u.block, []); byBlock.get(u.block).push(u); });
    this.unitEls = [];
    ch.blocks.forEach((blk, bi) => {
      let el;
      if (blk.kind === "scene_break") { page.append(h("hr")); return; }
      if (blk.kind === "heading") el = h("h2");
      else if (blk.kind === "verse") el = h("p", { class: "verse" });
      else if (blk.kind === "quote") el = h("blockquote");
      else el = h("p");
      const text = blk.text, us = (byBlock.get(bi) || []).slice().sort((a, b) => a.start - b.start);
      let pos = 0;
      const put = (target, s) => { s.split("\n").forEach((part, k) => { if (k) target.append(h("br")); if (part) target.append(part); }); };
      for (const u of us) {
        if (u.start > pos) put(el, text.slice(pos, u.start));
        const span = h("span", { class: "u", "data-i": u.i });
        put(span, text.slice(u.start, u.end));
        this.unitEls[u.i] = span;
        el.append(span);
        pos = Math.max(pos, u.end);
      }
      if (pos < text.length) put(el, text.slice(pos));
      page.append(el);
    });
    page.addEventListener("click", (e) => {
      const span = e.target.closest(".u");
      if (span && !getSelection().toString()) { this.playUnit(+span.dataset.i); }
    });

    this.$ = {};
    this.$.track = h("div", { class: "track" });
    this.$.knob = h("div", { class: "knob" });
    this.$.tip = h("div", { class: "tip", hidden: true });
    const scrub = h("div", { class: "scrub", role: "slider", "aria-label": "Position in chapter" }, this.$.track, this.$.knob, this.$.tip);
    this.bindScrub(scrub);
    this.$.elapsed = h("span");
    this.$.remain = h("span");
    this.$.play = h("button", { class: "play", title: "Play (space)", html: ICON.play, onclick: () => this.toggle() });
    const ctrl = (icon, title, fn, cls = "") => h("button", { class: "iconbtn " + cls, title, "aria-label": title, html: icon, onclick: fn });
    this.$.speed = h("button", { class: "speedbtn", title: "Playback speed", onclick: (e) => this.sheet("speed", e) }, `${audio.playbackRate || 1}×`);
    this.$.status = h("div", { class: "float-status" });
    const bar = h("div", { class: "player" },
      scrub, h("div", { class: "times" }, this.$.elapsed, this.$.remain),
      h("div", { class: "ctrls" },
        this.$.speed,
        ctrl(skipIcon(-1), `Back ${prefs.skip} s`, () => this.skip(-1)),
        this.$.play,
        ctrl(skipIcon(1), `Forward ${prefs.skip} s`, () => this.skip(1)),
        ctrl(ICON.list, "Chapters", (e) => this.sheet("chapters", e))));
    this.$.follow = h("button", { class: "follow", hidden: true, onclick: () => { this.follow = true; this.$.follow.hidden = true; this.scrollToCur(true); } }, "Back to narrator");
    const main = h("main", { class: "reader" }, page);
    this.root = main;
    app.replaceChildren(top, main, this.$.follow, this.$.status, bar);
    // the header gets out of the way while reading down, and comes back when scrolling up
    let lastY = scrollY;
    removeEventListener("scroll", this.onScroll);
    this.onScroll = () => {
      const y = scrollY;
      if (y > lastY + 4 && y > 120) top.classList.add("hide");
      else if (y < lastY - 4 || y < 60) top.classList.remove("hide");
      lastY = y;
    };
    addEventListener("scroll", this.onScroll, { passive: true });
    const stopFollow = () => { if (!audio.paused && prefs.follow) { this.follow = false; this.$.follow.hidden = false; } };
    main.addEventListener("wheel", stopFollow, { passive: true });
    main.addEventListener("touchmove", stopFollow, { passive: true });
  },

  sheet(kind, ev) {
    ev.stopPropagation();
    document.querySelector(".sheet")?.remove();
    const s = h("div", { class: "sheet" + (kind === "speed" || kind === "chapters" ? " bottom" : ""), onclick: (e) => e.stopPropagation() });
    if (kind === "chapters") {
      s.append(h("h3", {}, "Chapters"), h("div", { class: "list" }, this.book.chapters.filter((c) => c.n_units).map((c) =>
        h("a", { href: `#/read/${this.book.id}/${c.index}/0`, class: c.index === this.ch.index ? "on" : "" }, h("span", {}, chapterLabel(c.title, this.book.lang)), h("span", { class: "muted" }, human(c.est))))));
    } else if (kind === "speed") {
      const val = h("div", { class: "speed-val" });
      const slider = h("input", { type: "range", min: "0.5", max: "2.5", step: "0.05", value: String(audio.playbackRate), class: "speed-slider",
        oninput: () => { this.speed(+slider.value); paint(); } });
      const chips = h("div", { class: "opts" });
      const paint = () => {
        val.textContent = `${audio.playbackRate.toFixed(2).replace(/0$/, "")}×`;
        slider.value = String(audio.playbackRate);
        chips.replaceChildren(...SPEED_PRESETS.map((v) => h("button", { class: Math.abs(v - audio.playbackRate) < 0.001 ? "on" : "", onclick: () => { this.speed(v); paint(); } }, v === 1 ? "Normal" : `${v}×`)));
      };
      paint();
      s.append(h("h3", {}, "Playback speed"), val, slider, chips);
    } else {
      const sizes = [17, 19, 21, 23, 26];
      const themes = [["auto", "Auto"], ["light", "Light"], ["sepia", "Sepia"], ["dark", "Dark"], ["black", "Black"]];
      const size = store.get("size", 21), theme = store.get("theme", "auto");
      s.append(h("h3", {}, "Text size"), h("div", { class: "opts" }, sizes.map((z) => h("button", { class: z === size ? "on" : "", onclick: () => { store.set("size", z); applyLook(); this.sheet("look", ev); } }, String(z)))),
        h("h3", {}, "Theme"), h("div", { class: "opts" }, themes.map(([k, l]) => h("button", { class: k === theme ? "on" : "", onclick: () => { store.set("theme", k); applyLook(); this.sheet("look", ev); } }, l))));
    }
    document.body.append(s);
    setTimeout(() => addEventListener("click", () => s.remove(), { once: true }), 0);
  },

  wordify(u) {
    const span = this.unitEls[u.i];
    if (!span || span.dataset.w) return;
    span.dataset.w = "1";
    span.classList.remove("pending");
    if (!u.words?.length) return;
    const meta = this.ch.units[u.i], text = this.ch.blocks[meta.block].text;
    span.replaceChildren();
    let pos = meta.start, target = span, since = 0;
    const put = (s) => s.split("\n").forEach((part, k) => { if (k) target.append(h("br")); if (part) target.append(part); });
    // a long sentence is split into clauses (at , ; : dashes and brackets, at least 4 words each): the highlight and
    // sentence steps (AirPods, arrow keys) then move by clause instead of by a whole screen of text
    const long = meta.end - meta.start > 260 && u.words.length > 30;
    const starts = [], els = [];
    const clause = (k) => { target = h("span", { class: "c" }); span.append(target); starts.push(k); els.push(target); since = 0; };
    if (long) { span.classList.add("long"); clause(0); }
    u.words.forEach(([s, e], k) => {
      if (s > pos) {
        const gap = text.slice(pos, s);
        if (long && k > 0 && since >= 4 && /[,;:—–()]/.test(gap)) { put(gap.replace(/\s+$/, "")); span.append(gap.match(/\s*$/)[0]); clause(k); }
        else put(gap);
      }
      target.append(h("span", { class: "w", "data-k": k }, text.slice(s, e)));
      since++;
      pos = e;
    });
    if (pos < meta.end) put(text.slice(pos, meta.end));
    if (long) this.clauses.set(u.i, { starts, els });
  },

  // ---------- playback
  speed(v) {
    v = Math.min(2.5, Math.max(0.5, Math.round(v * 100) / 100));
    audio.playbackRate = v;
    audio.defaultPlaybackRate = v;
    if (this.book) store.set(`speed:${this.book.id}`, v);
    if (this.$?.speed) this.$.speed.textContent = `${v}×`;
    this.positionState();
  },
  playUnit(i) { return this.seek(this.timeOfUnit(i), true, i); },
  play() {
    this.userPaused = false;
    this.ownPlayAt = Date.now();
    if (this.state !== "playing") this.setState("loading");
    audio.play().catch((e) => {
      if (e?.name === "AbortError") return;      // a newer play/pause replaced this one
      clog("play-refused", e?.name);
      this.setState("idle", e?.name === "NotAllowedError" ? "Tap play to start" : "Couldn't start playback · tap play to try again");
    });
    this.wake(true);
  },
  // the one place that moves the playhead (chapter time T in the shown chapter)
  async seek(T, play = realPlaying(), unitHint, force = false) {
    clearTimeout(this.waiting); this.waiting = null;
    if (unitHint != null) { T = this.timeOfUnit(unitHint); this.setCurrent(unitHint); }
    T = Math.max(0, Math.min(T, Math.max(0, this.chapterTotal() - 0.05)));
    this.startT = T;
    this.stoppedAt = 0;               // an explicit move is not a "resume": no automatic rewind
    if (!this.tape) return;
    const n = this.ch.index;
    this.target = { n, t: T, play };   // until this jump lands; a failure retries it (recover)
    if (play && this.state !== "playing" && this.state !== "waiting") this.setState("loading");   // keep a countdown on screen
    const at = force ? null : this.tapeFor(n, T);
    if (at != null) {                 // already buffered: instant, and play() stays inside the user's tap (iOS)
      this.target = null;
      audio.currentTime = at;
      if (play) this.play();
      this.positionState();
      this.pump();
      return;
    }
    let r;
    try { r = await this.rebase(n, T); } catch (e) { this.pumpFailed(this.tape, e); return; }
    if (r === "stale" || this.ch.index !== n) return;       // a newer jump took over
    this.target = null;
    this.pump();
    if (r !== "ok") clog("seek", r);
    if (r === "pending") {            // not rendered yet: wait for it, and make sure the renderer is on it
      this.holding = true; audio.pause(); this.holding = false;
      const e = this.chs.get(n), f = e.files[this.fileAt(e, T)];
      this.awaitRender(f);
      if (play) {
        this.showWaiting(f, "this part");
        this.waiting = setTimeout(() => this.tape && this.state === "waiting" && this.seek(unitHint != null ? this.timeOfUnit(unitHint) : T, true, unitHint), 3000);
      } else { this.setState("idle"); this.note("Not rendered yet · it's next in line, press play to wait for it", 6000); }
      return;
    }
    if (play) this.play();
    else if (this.state !== "playing") this.setState("idle");
    this.positionState();
  },
  async toggle() {
    if (this.state === "loading" || this.state === "waiting") {      // tapping a spinner cancels what it waits for
      clearTimeout(this.waiting); this.waiting = null;
      clearTimeout(this.retryTimer); clearInterval(this.etaTimer);
      this.target = null;
      this.userPaused = true;
      this.holding = true; audio.pause(); this.holding = false;
      this.setState("idle");
      this.note("Stopped");
      return;
    }
    if (!realPlaying()) {
      const away = this.stoppedAt ? Date.now() - this.stoppedAt : 0;
      const T = this.snapBack(this.chapterTime(), rewindFor(away));
      this.stoppedAt = 0;
      await this.seek(T, true);
    } else {
      this.userPaused = true;
      audio.pause();
    }
  },
  // `what`: "this part" (you jumped somewhere not rendered yet) or "ahead" (playback caught up with the renderer).
  // The countdown comes from the renderer itself: which piece it is on, how many of its sentences are done, and its
  // speed on fresh sentences. It only counts down (a new estimate can't make it jump around), and playback starts
  // by itself when the piece lands.
  showWaiting(f, what = "this part") {
    if (!navigator.onLine) return this.setState("error", "You're offline and this part isn't downloaded");
    if (this.book.render === false) {   // rendering was switched off for this book: listening means you want it
      this.book.render = true;
      api(`/api/books/${this.book.id}`, { method: "PATCH", body: JSON.stringify({ render: true }) }).catch(() => {});
      toast("Rendering turned on for this book");
    }
    const key = f ? `${f.n}:${f.part}` : "?";
    if (this.state === "waiting" && this.waitKey === key && this.etaTimer) return;   // already counting down for it
    const label = what === "ahead" ? "Rendering ahead" : "Rendering this part";
    const eta = { shown: null, at: 0 };
    const show = (st) => {
      if (this.state !== "waiting" || this.waitKey !== key) return;
      const w = st?.worker || {}, job = w.job, speed = Math.max(w.speed || w.rate || 1, 0.3);
      if (st?.settings?.paused)
        return this.setState("waiting", "Rendering is paused", { label: "Resume", run: () => api("/api/system", { method: "PUT", body: JSON.stringify({ paused: false }) }).then(() => { eta.shown = null; this.note("Rendering resumed"); }).catch(() => {}) });
      if (w.state === "error") return this.setState("waiting", `${label} · the renderer hit a problem, retrying`);
      const k = this.chs.get(f?.n)?.files.findIndex((x) => x.part === f?.part) ?? -1;
      const here = job && job.book === this.book.id && job.chapter === f?.n;
      const mine = here && job.segment === k, past = here && job.segment > k;
      let secs;
      if (past) secs = 3;                                                  // done, being joined: the next check plays it
      else if (mine && job.done > 0) {                                     // pace of this very piece so far
        const per = (Date.now() / 1000 - job.started) / job.done;
        secs = per * (job.units - job.done) + 3;
      } else secs = ((mine ? job.est : f?.dur) || 30) / speed + (mine ? 3 : 8);
      const now = Date.now();
      if (eta.shown != null) {                       // count down; only a clear slowdown may raise it
        const ticking = Math.max(2, eta.shown - (now - eta.at) / 1000);
        secs = secs < ticking || secs > ticking + 20 ? secs : ticking;
      }
      eta.shown = secs; eta.at = now;
      const progress = mine && job.units > 1 ? ` (${job.done} of ${job.units} sentences)` : "";
      this.setState("waiting", `${label} · ${secs < 8 ? "a few seconds" : secs < 60 ? `about ${Math.ceil(secs / 5) * 5} s` : `about ${Math.round(secs / 60)} min`}${progress}`);
    };
    this.setState("waiting", `${label}…`);
    this.waitKey = key;
    clearInterval(this.etaTimer);
    const poll = () => api("/api/status").then(show).catch(() => show(null));
    poll();
    this.etaTimer = setInterval(poll, 2500);
  },
  hideWaiting() { this.say(null); },
  async wake(on) {
    try {
      if (on && prefs.wake && "wakeLock" in navigator && !this.lock) this.lock = await navigator.wakeLock.request("screen");
      if (!on && this.lock) { await this.lock.release(); this.lock = null; }
    } catch { this.lock = null; }
  },
  // What the player is doing, shown on the play button, the now-playing bar, the message pill and the lock screen.
  //   idle     paused (play icon)
  //   loading  getting audio ready (spinner; tapping it cancels)
  //   playing  (pause icon)
  //   waiting  that part is still being rendered (spinner + countdown; starts by itself; tapping cancels)
  //   error    can't play right now (play icon + why; tapping play tries again)
  // Every tap moves the state at once, before any network call, so the button always answers.
  state: "idle",
  setState(state, msg = null, action = null) {
    // an error right after a tap still shows the spinner briefly, so the tap visibly did something
    if (state === "error" && this.state === "loading" && Date.now() - (this.loadingAt || 0) < 400) {
      clearTimeout(this.errorTimer);
      this.errorTimer = setTimeout(() => this.state === "loading" && this.setState(state, msg, action), 400 - (Date.now() - this.loadingAt));
      return;
    }
    if (state === "loading" && this.state !== "loading") this.loadingAt = Date.now();
    this.state = state;
    this.stateMsg = msg;
    if (state !== "waiting") this.waitKey = null;
    const busy = state === "loading" || state === "waiting";
    const icon = state === "playing" ? ICON.pause : busy ? ICON.spin : ICON.play;
    const label = { idle: "Play", loading: "Loading · tap to cancel", playing: "Pause", waiting: "Waiting for rendering · tap to cancel", error: "Try again" }[state];
    for (const b of [this.$?.play, this.$mini?.play]) {
      if (!b) continue;
      b.innerHTML = icon;
      b.classList.toggle("busy", busy);
      b.setAttribute("aria-label", label);
      b.title = label;
    }
    this.say(msg, action, busy && !this.$?.play?.isConnected);      // the play button already spins on the reader
    if (this.$mini?.sub) this.$mini.sub.textContent = msg && state !== "playing" ? msg : chapterLabel(this.ch?.title, this.book?.lang);
    try { if (navigator.mediaSession) navigator.mediaSession.playbackState = state === "playing" ? "playing" : "paused"; } catch {}
  },
  // the message pill above the player: text, an optional spinner and an optional button
  say(msg, action = null, spinning = false) {
    clearTimeout(this.sayTimer);
    const w = this.$?.status;
    if (!w) return;
    if (!msg) return w.replaceChildren();
    w.replaceChildren(h("span", { class: "waiting" + (w.textContent.startsWith(msg) ? " again" : ""), }, spinning ? h("span", { class: "spinner" }) : null, msg,
      action ? h("button", { class: "pill-btn", onclick: (e) => { e.stopPropagation(); action.run(); } }, action.label) : null));
  },
  // a short note that goes away by itself
  note(msg, ms = 2500) {
    this.say(msg);
    this.sayTimer = setTimeout(() => { if (this.state === "idle" || this.state === "playing") this.say(null); }, ms);
  },
  setPlayIcon(paused) { this.setState(paused ? "idle" : "playing"); },
  // the now-playing bar on the other screens: what's playing, play/pause, tap to go back to the text
  mini() {
    this.$mini = null;
    if (this.root) return null;
    const live = !!(this.tape && this.book && this.ch);
    const r = live ? null : store.get("recent", null);
    if (!live && !r) return null;
    const b = live ? this.book : { id: r.id, title: r.title, lang: r.lang };
    const n = live ? this.ch.index : r.ch;
    const busy = live && (this.state === "loading" || this.state === "waiting");
    const play = h("button", { class: "mini-play" + (busy ? " busy" : ""), "aria-label": "Play or pause", html: live && this.state === "playing" ? ICON.pause : busy ? ICON.spin : ICON.play,
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); this.tape && this.book?.id === b.id ? this.toggle() : this.startHere(b.id, n); } });
    const sub = h("div", { class: "s" }, live && this.stateMsg && this.state !== "playing" ? this.stateMsg : chapterLabel(live ? this.ch.title : r.chTitle, b.lang));
    const el = h("a", { class: "mini", href: `#/read/${b.id}/${n}` }, coverEl(b), h("div", { class: "grow" }, h("div", { class: "t" }, b.title), sub), play);
    this.$mini = { el, play, sub };
    document.body.classList.add("has-mini");
    return el;
  },
  // play from the bottom bar without opening the book (cold start: nothing loaded yet)
  async startHere(id, n) {
    this.setState("loading");
    try { await this.open(id, n, undefined, true, false); }
    catch (e) { this.setState("error", navigator.onLine ? "Can't reach the laptop" : "You're offline"); }
  },
  remember(b, n, chTitle) { store.set("recent", { id: b.id, title: b.title, lang: b.lang, ch: n, chTitle: chTitle || "" }); },
  paintMini() {
    if (!this.$mini?.el.isConnected) return;
    this.$mini.el.setAttribute("href", `#/read/${this.book.id}/${this.ch.index}`);
    this.$mini.sub.textContent = chapterLabel(this.ch.title, this.book.lang);
  },
  step(d) {
    const T = this.chapterTime();
    const u = this.unitAtTime(T);
    if (!u) return;
    const starts = (x) => (this.clauses.get(x?.i)?.starts || []).map((k) => x.words[k][2]);   // clause start times
    const cs = starts(u);
    if (d < 0) {
      const back = cs.filter((t) => t < T - 1.5).pop();
      if (back != null) return this.seek(back - 0.05, realPlaying());
      if (T - u.t0 > 1.5) return this.seek(u.t0, realPlaying());
    } else {
      const fwd = cs.find((t) => t > T + 0.3);
      if (fwd != null) return this.seek(fwd - 0.05, realPlaying());
    }
    const i = Math.max(0, Math.min(this.ch.units.length - 1, u.i + d));
    const prevLast = d < 0 ? starts(this.ut.find((x) => x.i === i)).pop() : null;     // back into a long sentence: its last clause
    if (prevLast != null) return this.seek(prevLast - 0.05, realPlaying());
    this.seek(this.timeOfUnit(i), realPlaying(), i);
  },
  skip(dir) { this.seek(this.chapterTime() + dir * prefs.skip, realPlaying()); },
  // the stream only ends at the end of the book (or of the chapter, with "continue to the next chapter" off)
  onEnded() {
    this.setPlayIcon(true);
    if (this.nextChapter(this.ch.index) == null) toast("The end.");
  },

  // ---------- highlight & time
  setCurrent(i, jump = false) {
    if (i === this.cur && !jump) return;
    this.unitEls[this.cur]?.classList.remove("cur");
    this.curWord?.classList.remove("cur"); this.curWord = null;
    this.cur = i;
    this.unitEls[i]?.classList.add("cur");
    if (this.follow || jump) this.scrollToCur(jump);
  },
  scrollToCur(force) {
    const el = this.unitEls[this.cur];
    if (!el) return;
    const r = el.getBoundingClientRect(), vh = innerHeight;
    if (force || r.top < vh * 0.18 || r.bottom > vh * 0.62) el.scrollIntoView({ behavior: force ? "auto" : "smooth", block: el.offsetHeight > vh * 0.5 ? "start" : "center" });
  },
  loop() {
    const tick = () => {
      if (!this.root) return;
      this.raf = requestAnimationFrame(tick);
      this.update();
    };
    tick();
  },
  // called every frame on screen, and on every timeupdate when hidden (locked screen: no animation frames)
  update() {
    if (!this.tape || !this.ch) return;
    const m = this.map(audio.currentTime);
    if (m && m.n !== this.ch.index) {
      if (!audio.paused && !this.target && !this.opening) this.enterChapter(m.n);
      return;
    }
    if (!this.root) return;
    if (m && this.dragT == null) {
      const t = m.t, u = this.unitAtTime(t);
      if (u) {
        if (u.i !== this.cur) this.setCurrent(u.i);
        const words = u.words || [];
        let k = -1;
        for (let j = 0; j < words.length; j++) { if (words[j][2] <= t + 0.03) k = j; else break; }
        const el = this.unitEls[u.i];
        const w = k >= 0 && t <= words[k][3] + 0.25 ? el?.querySelectorAll(".w")[k] : null;
        if (w !== this.curWord) { this.curWord?.classList.remove("cur"); w?.classList.add("cur"); this.curWord = w; }
        const cl = this.clauses.get(u.i);
        const c = cl ? cl.els[Math.max(0, cl.starts.findLastIndex((s) => s <= Math.max(k, 0)))] : null;
        if (c !== this.curClause) { this.curClause?.classList.remove("cur"); c?.classList.add("cur"); this.curClause = c; }
        // follow long sentences word by word
        if (w && this.follow && !audio.paused && !document.hidden) { const r = w.getBoundingClientRect(); if (r.bottom > innerHeight * 0.66 || r.top < innerHeight * 0.12) w.scrollIntoView({ behavior: "smooth", block: "center" }); }
      }
    }
    this.paintTime();
  },
  paintTime() {
    if (!this.$?.elapsed) return;
    const total = this.chapterTotal(), rate = audio.playbackRate || 1;
    const t = this.dragT ?? this.chapterTime();
    const exact = (this.chs.get(this.ch.index)?.files || []).every((f) => f.idx);
    this.$.elapsed.textContent = fmt(t / rate);
    this.$.remain.textContent = `${exact ? "−" : "≈ "}${fmt(Math.max(0, total - t) / rate)}`;
    const f = Math.min(1, t / Math.max(total, 1));
    this.$.knob.style.left = `${100 * f}%`;
    if (this.$.played) this.$.played.style.width = `${100 * f}%`;
  },
  // drag (or tap) the scrubber: preview while moving, seek on release, keep playing/paused as it was
  bindScrub(el) {
    const at = (e) => { const r = el.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * this.chapterTotal(); };
    const tip = () => {
      this.$.tip.textContent = fmt(this.dragT / (audio.playbackRate || 1));
      this.$.tip.style.left = `${(100 * this.dragT) / Math.max(this.chapterTotal(), 1)}%`;
    };
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId);
      el.classList.add("drag");
      this.dragT = at(e); this.$.tip.hidden = false; tip(); this.paintTime();
    });
    el.addEventListener("pointermove", (e) => { if (this.dragT == null) return; this.dragT = at(e); tip(); this.paintTime(); });
    const stop = (commit) => {
      if (this.dragT == null) return;
      const T = this.dragT;
      this.dragT = null;
      el.classList.remove("drag");
      this.$.tip.hidden = true;
      if (commit) this.seek(T, realPlaying());
    };
    el.addEventListener("pointerup", () => stop(true));
    el.addEventListener("pointercancel", () => stop(false));
  },
  paintScrub() {
    if (!this.$?.track) return;
    const e = this.chs.get(this.ch.index), total = this.chapterTotal();
    this.$.track.replaceChildren();
    if (e && total) for (const f of e.files) if (f.ready) this.$.track.append(h("div", { class: "seg", style: `left:${(100 * f.offset) / total}%;width:${(100 * (f.dur || 0)) / total}%` }));
    this.$.played = h("div", { class: "played" });
    this.$.track.append(this.$.played);
  },
  save() {
    if (!this.book || !this.ch) return;
    const m = this.tape && this.map(audio.currentTime);
    if (!m || m.n !== this.ch.index) return;
    const i = Math.max(this.cur, 0), u = this.ch.units[i], ut = this.ut.find((x) => x.i === i);
    // where in the text, and how far into that sentence: survives re-segmentation and re-rendering
    positions.remember(this.book.id, { chapter: m.n, unit: i, t: m.t, block: u?.block, start: u?.start, du: ut ? Math.max(0, m.t - ut.t0) : 0 });
    positions.push(this.book.id);
  },
  positionState() {
    const s = navigator.mediaSession;
    if (!s || !this.ch) return;
    const dur = Math.max(this.chapterTotal(), 0.1);
    try { s.setPositionState?.({ duration: dur, position: Math.min(Math.max(0, this.chapterTime()), dur), playbackRate: audio.playbackRate || 1 }); } catch {}
    try { s.playbackState = audio.paused ? "paused" : "playing"; } catch {}
  },
  media() {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: chapterLabel(this.ch.title, this.book.lang), artist: this.book.author, album: this.book.title,
      artwork: [{ src: `/api/books/${this.book.id}/cover`, sizes: "512x512" }] });
    const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch {} };
    set("play", () => this.toggle()); set("pause", () => this.toggle());
    set("previoustrack", () => this.step(-1)); set("nexttrack", () => this.step(1));
    set("seekbackward", () => this.skip(-1)); set("seekforward", () => this.skip(1));
    set("seekto", (d) => this.seek(d.seekTime, realPlaying()));
    this.positionState();
  },
};

audio.addEventListener("ended", () => player.tape && player.onEnded());
audio.addEventListener("error", () => player.onMediaError());
audio.addEventListener("waiting", () => player.tape && player.onStall());
audio.addEventListener("timeupdate", () => { player.pump(); if (document.hidden) player.update(); });
audio.addEventListener("playing", () => { clearTimeout(player.stallTimer); clearInterval(player.etaTimer); player.retry = 0; player.setState("playing"); player.positionState(); });
audio.addEventListener("seeked", () => player.positionState());
audio.addEventListener("pause", () => {
  player.wake(false);
  // we paused to wait (holding, or already "waiting": the event arrives after the flag is gone): the state says why
  if (!player.holding && player.state !== "error" && player.state !== "waiting") player.setState("idle");
  player.positionState();
  if (!player.tape || audio.ended) return;
  player.stoppedAt = Date.now();     // user pause *or* a system interruption (call, Siri, navigation)
  player.save();
});
audio.addEventListener("ratechange", () => { player.positionState(); if (player.$?.speed) player.$.speed.textContent = `${audio.playbackRate}×`; });
// stopped by the system and resumed by the system (no tap): still go back a bit
audio.addEventListener("play", () => {
  if (!player.tape || !player.stoppedAt || Date.now() - (player.ownPlayAt || 0) < 2000) return;
  const away = Date.now() - player.stoppedAt;
  player.stoppedAt = 0;
  const back = rewindFor(away);
  if (back) { const T = player.snapBack(player.chapterTime(), back); player.seek(T, true); }
});
setInterval(() => { if (player.tape && !audio.paused) player.save(); }, 5000);
document.addEventListener("visibilitychange", () => { clog("visibility", document.visibilityState); if (document.visibilityState === "hidden") player.save(); else player.update(); });
clog("start", `${navigator.userAgent.slice(0, 120)} · ${matchMedia("(display-mode: standalone)").matches ? "installed" : "browser"} · ${MSE === window.MediaSource ? "MediaSource" : "ManagedMediaSource"}`);

addEventListener("keydown", (e) => {
  if (!player.root || e.target.closest("input,select,textarea")) return;
  if (e.code === "Space") { e.preventDefault(); player.toggle(); }
  else if (e.code === "ArrowLeft") { e.preventDefault(); e.shiftKey ? player.skip(-1) : player.step(-1); }
  else if (e.code === "ArrowRight") { e.preventDefault(); e.shiftKey ? player.skip(1) : player.step(1); }
});

// ------------------------------------------------------------------ router
async function route() {
  const [path, query] = location.hash.slice(1).split("?");
  const parts = (path || "/").split("/").filter(Boolean);
  document.body.classList.remove("has-mini");
  document.querySelectorAll(".sheet, .toast").forEach((el) => el.remove());
  if (parts[0] !== "read") scrollTo(0, 0);
  try {
    if (parts[0] === "book" && parts[1]) await viewBook(parts[1]);
    else if (parts[0] === "system") await viewSystem();
    else if (parts[0] === "settings") viewSettings();
    else if (parts[0] === "read" && parts[1]) await player.open(parts[1], +parts[2] || 1, parts[3] != null ? +parts[3] : undefined, query === "play");
    else await viewLibrary();
  } catch (e) {
    app.replaceChildren(h("main", { class: "wrap" }, h("div", { class: "empty", style: "margin-top:3rem" }, h("h2", {}, "Something went wrong"), h("p", {}, e.message),
      h("a", { class: "btn", href: "#/" }, "Library"))));
  }
}
addEventListener("hashchange", route);
route();
setTimeout(() => offline.syncAll(), 3000);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
