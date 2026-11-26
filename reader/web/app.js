// reader — library, book page, and the read-along player. No build step.
const $ = (sel, el = document) => el.querySelector(sel);
const app = $("#app");
const audio = $("#audio");

const ICON = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>',
  prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 5v14"/><path d="M18 6l-8 6 8 6z" fill="currentColor"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 5v14"/><path d="M6 6l8 6-8 6z" fill="currentColor"/></svg>',
  back15: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/><text x="12" y="15.5" font-size="7.5" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui" font-weight="700">15</text></svg>',
  fwd15: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4h-4"/><text x="12" y="15.5" font-size="7.5" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui" font-weight="700">15</text></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  type: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19l5-14 5 14M6 14h6M15 19l3-8 3 8M16 16.5h4"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
};

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
    throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
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
const chapterLabel = (title, lang) => (NUMERAL.test((title || "").trim()) ? `${lang === "es" ? "Capítulo" : "Chapter"} ${title.trim().replace(/\.$/, "")}` : title);
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
      await api(`/api/books/${id}/position`, { method: "PUT", body: JSON.stringify({ chapter: p.chapter, unit: p.unit, t: p.t, at: p.at }) });
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
const offline = {
  busy: {},          // bookId -> {done, total, label}
  listeners: new Set(),
  emit() { for (const f of this.listeners) try { f(); } catch {} },
  mode: (id) => store.get(`dl:${id}`, "off"),
  index: (id) => store.get(`dlx:${id}`, {}),            // {chapterIndex: bytes}
  bytes(id) { return Object.values(this.index(id)).reduce((a, b) => a + b, 0); },
  has(id, n) { return n in this.index(id); },
  async setMode(id, m) {
    store.set(`dl:${id}`, m);
    if (m !== "off" && navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    await this.sync(id);
  },
  async audioURL(id, n) {
    if (!this.has(id, n)) return null;
    const v = await idb.get(`/api/books/${id}/chapter-audio/${n}.m4a`).catch(() => null);
    if (!v?.data) return null;
    return URL.createObjectURL(v.data);
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
    for (const k of [`/api/books/${id}/chapter-audio/${n}.m4a`, `/api/books/${id}/chapters/${n}`, `/api/books/${id}/chapters/${n}/timeline`]) await idb.del(k).catch(() => {});
    const ix = this.index(id); delete ix[n]; store.set(`dlx:${id}`, ix);
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
    const todo = b.chapters.filter((c) => want.has(c.index) && !this.has(id, c.index));
    const ready = todo.filter((c) => c.full);
    if (!ready.length) { this.emit(); return; }
    this.busy[id] = { done: 0, total: ready.length, label: "" };
    this.emit();
    try {
      if (!(await idb.get(`/api/books/${id}/cover`).catch(() => null))) {
        const r = await fetch(`/api/books/${id}/cover`);
        if (r.ok) await idb.put(`/api/books/${id}/cover`, { type: "blob", data: await r.blob() });
      }
      for (const c of ready) {
        this.busy[id].label = c.title;
        this.emit();
        const base = `/api/books/${id}/chapters/${c.index}`;
        const [cj, tl] = await Promise.all([fetch(base).then((r) => r.json()), fetch(`${base}/timeline`).then((r) => r.json())]);
        const audio = await fetch(`/api/books/${id}/chapter-audio/${c.index}.m4a`).then((r) => { if (!r.ok) throw new Error(r.statusText); return r.blob(); });
        await idb.put(base, { type: "json", data: cj });
        await idb.put(`${base}/timeline`, { type: "json", data: tl });
        await idb.put(`/api/books/${id}/chapter-audio/${c.index}.m4a`, { type: "blob", data: audio });
        store.set(`dlx:${id}`, { ...this.index(id), [c.index]: audio.size });
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
  player.detach();
  const books = await api("/api/books");
  const top = topbar(brand(), null, renderChip(), gear(), h("button", { class: "iconbtn add", title: "Add book", onclick: picker, html: ICON.plus }));
  const main = h("main", { class: "wrap" });
  const recent = books.find((b) => positions.best(b.id, b.position));
  if (recent) {
    const pos = positions.best(recent.id, recent.position);
    const ch = recent.chapters.find((c) => c.index === pos.chapter);
    main.append(h("a", { class: "continue", href: `#/read/${recent.id}/${pos.chapter}?play` }, coverEl(recent),
      h("div", { class: "grow" }, h("div", { class: "eyebrow" }, "Continue"), h("div", { class: "t" }, recent.title), h("div", { class: "muted" }, ch ? chapterLabel(ch.title, recent.lang) : "")),
      h("span", { class: "chev", html: ICON2.chev })));
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
  app.replaceChildren(top, main);
}

// ------------------------------------------------------------------ book page
async function viewBook(id) {
  player.detach();
  const b = await api(`/api/books/${id}`);
  const pos = positions.best(id, b.position);
  const playable = b.chapters.filter((c) => c.n_units);
  const cur = (pos && b.chapters.find((c) => c.index === pos.chapter)) || playable.find((c) => c.include);
  const p = b.progress;
  const done = p.ready_est >= p.total_est - 1;
  const top = topbar(back("#/", "Library"), null, renderChip(), gear());

  const state = !b.render ? ["off", "Rendering is off for this book"] : done ? ["done", "Fully rendered"]
    : b.rendering_now ? ["on", "Rendering now"] : ["queued", "Queued"];
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
  app.replaceChildren(top, main);
}

// ------------------------------------------------------------------ rendering & storage
let sysTimer = 0;
async function viewSystem() {
  player.detach();
  const top = topbar(back("#/", "Library"), h("div", { class: "page-title" }, "Rendering & storage"), gear());
  const main = h("main", { class: "wrap narrow" });
  app.replaceChildren(top, main);
  const statusBox = h("section", { class: "card-box" }), queueBox = h("section", { class: "card-box rows" }), storeBox = h("section", { class: "card-box rows" });
  main.append(statusBox, h("h2", { class: "section" }, "Books"), queueBox, h("h2", { class: "section" }, "Storage"), storeBox);

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
          job && !paused ? h("div", { class: "muted small" }, `${job.title} · ${job.chapter_title}, part ${job.segment + 1} of ${job.of}`) : null,
          w.state === "error" ? h("div", { class: "muted small" }, w.error || "") : null),
        h("button", { class: "btn sm" + (paused ? "" : " ghost"), onclick: async () => { await api("/api/system", { method: "PUT", body: JSON.stringify({ paused: !paused }) }); paint(); } }, paused ? "Resume" : "Pause all")),
      cur ? h("div", { class: "bar thick" }, h("i", { class: "ready", style: `width:${pct(cur.ready, cur.total)}%` })) : null,
      h("div", { class: "stats" },
        h("div", {}, h("b", {}, w.rate ? `${w.rate.toFixed(1)}×` : "—"), h("span", {}, "realtime speed")),
        h("div", {}, h("b", {}, cur ? `${pct(cur.ready, cur.total)}%` : "—"), h("span", {}, "book ready")),
        h("div", {}, h("b", {}, cur && cur.eta != null ? eta(cur.eta) : "—"), h("span", {}, "left"))),
      h("div", { class: "row-between stack top-gap" }, h("div", {}, h("div", { class: "label" }, "CPU for rendering"), h("div", { class: "muted small" }, "More is faster, but the laptop gets busier and warmer")),
        seg([[2, "Low"], [4, "Medium"], [8, "High"]], s.settings.threads, async (v) => { await api("/api/system", { method: "PUT", body: JSON.stringify({ threads: v }) }); paint(); })));
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

// ------------------------------------------------------------------ settings
function viewSettings() {
  player.detach();
  const top = topbar(back("#/", "Library"), h("div", { class: "page-title" }, "Settings"), h("span", { class: "iconbtn", "aria-hidden": "true" }));
  const row = (label, hint, control) => h("div", { class: "row-between" + (control.classList.contains("segctl") ? " stack" : "") }, h("div", {}, h("div", { class: "label" }, label), hint ? h("div", { class: "muted small" }, hint) : null), control);
  const repaint = () => viewSettings();
  const dlIds = Object.keys(localStorage).filter((k) => k.startsWith("reader:dlx:")).map((k) => k.slice(11));
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
  app.replaceChildren(top, main);
}

// ------------------------------------------------------------------ reader + player
//
// Everything is measured in *chapter time* (seconds into the chapter). A chapter plays from one continuous file once
// it is fully rendered; while it is still rendering, it plays from ~75 s pieces. `pieces` hides the difference.

const skipIcon = (dir) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${dir < 0
  ? '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/>' : '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4h-4"/>'}<text x="12" y="15.5" font-size="7.5" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui" font-weight="700">${prefs.skip}</text></svg>`;
const SPEED_PRESETS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

// how far to go back when playback resumes after stopping (pause, call, Siri, navigation prompt...)
const rewindFor = (ms) => (ms < 1500 ? 0 : ms < 30e3 ? 4 : ms < 5 * 60e3 ? 8 : ms < 60 * 60e3 ? 15 : 30) * (REWIND_SCALE[prefs.rewind] ?? 1);

const player = {
  book: null, ch: null, unitEls: [], pieces: [], piece: -1, cur: -1, curWord: null, follow: true,
  waiting: null, stoppedAt: 0, raf: 0, root: null, loading: false, retry: 0, retryTimer: 0, userPaused: true,

  detach() {
    document.body.classList.remove("has-player");
    audio.pause();
    this.wake(false);
    removeEventListener("scroll", this.onScroll);
    cancelAnimationFrame(this.raf);
    clearTimeout(this.waiting); clearTimeout(this.retryTimer);
    this.waiting = null;
    this.root = null;
  },

  async open(bookId, chIndex, unit, autoplay) {
    this.detach();
    document.body.classList.add("has-player");
    this.follow = prefs.follow;
    const [b, ch] = await Promise.all([api(`/api/books/${bookId}`), api(`/api/books/${bookId}/chapters/${chIndex}`)]);
    this.book = b; this.ch = ch; this.cur = -1; this.curWord = null; this.piece = -1;
    this.render();
    this.speed(store.get(`speed:${bookId}`, 1));
    await this.loadPieces();
    this.media();
    // where to start: an explicit unit, else the saved position (with a rewind for how long we were away)
    const pos = positions.best(bookId, b.position);
    let T = 0;
    if (Number.isFinite(unit)) T = this.timeOfUnit(unit);
    else if (pos && pos.chapter === ch.index) T = this.snapBack(pos.t ?? this.timeOfUnit(pos.unit), rewindFor(Date.now() - (pos.at || 0)));
    this.setCurrent(this.unitAtTime(T)?.i ?? (Number.isFinite(unit) ? unit : 0), true);
    this.startT = T;
    api(`/api/books/${bookId}/focus`, { method: "POST", body: JSON.stringify({ chapter: chIndex, unit: Math.max(this.cur, 0) }) }).catch(() => {});
    this.paintScrub();
    this.loop();
    if (autoplay) return this.seek(T, true);
    await this.preload(T);
  },
  // load the file for time T and park the playhead there, so a tap on play can start audio synchronously (iOS)
  async preload(T) {
    const k = this.pieceAt(T), p = this.pieces[k];
    if (!p?.ready || !p.tl) return;
    this.loading = true;
    try {
      if (!audio.src.endsWith(p.url)) await this.load(p.url);
      this.piece = k;
      audio.currentTime = Math.max(0, T - p.start);
    } finally { this.loading = false; }
  },

  // ---------- pieces & time
  async loadPieces() {
    const ch = this.ch;
    if (ch.full) {
      const tl = await api(`/api/books/${this.book.id}/chapters/${ch.index}/timeline`);
      if (this.localURL) URL.revokeObjectURL(this.localURL);
      this.localURL = await offline.audioURL(this.book.id, ch.index);        // on the phone: no data, no buffering
      this.pieces = [{ url: this.localURL || `/api/books/${this.book.id}/chapter-audio/${ch.index}.m4a`, start: 0, dur: tl.duration, tl, ready: true }];
      tl.units.forEach((u) => this.wordify(u, 0));
    } else {
      let start = 0;
      this.pieces = ch.segments.map((s, k) => {
        const p = { url: `/api/books/${this.book.id}/audio/${ch.index}/${k}.m4a`, start, dur: s.est, tl: null, ready: s.ready, u0: s.u0, u1: s.u1, k };
        start += s.est;
        return p;
      });
      await Promise.all(this.pieces.filter((p) => p.ready).map((p) => this.loadPieceTimeline(p).catch(() => {})));
      this.restack();
    }
  },
  async loadPieceTimeline(p) {
    if (p.tl) return p.tl;
    p.tl = await api(`/api/books/${this.book.id}/chapters/${this.ch.index}/segments/${p.k}`);
    p.ready = true;
    p.dur = p.tl.duration;
    return p.tl;
  },
  restack() {   // recompute piece start times once real durations are known
    let start = 0;
    for (const p of this.pieces) {
      p.start = start;
      if (p.tl && !p.wordified) { p.tl.units.forEach((u) => this.wordify(u, 0)); p.wordified = true; }
      start += p.dur;
    }
  },
  async refreshReadiness() {
    const c = await api(`/api/books/${this.book.id}/chapters/${this.ch.index}`).catch(() => null);
    if (!c) return;
    if (c.full && !this.ch.full && audio.paused) {   // chapter finished rendering while we weren't playing: switch to the one-file version
      const T = this.chapterTime(); this.ch.full = true; await this.loadPieces(); this.piece = -1; this.startT = T; this.paintScrub(); return;
    }
    c.segments.forEach((s, k) => { if (this.pieces[k] && !this.pieces[k].ready && s.ready) this.pieces[k].ready = true; });
    await Promise.all(this.pieces.filter((p) => p.ready && !p.tl && p.k != null).map((p) => this.loadPieceTimeline(p).catch(() => {})));
    this.restack();
    this.paintScrub();
  },
  pieceAt(T) {
    let k = this.pieces.findLastIndex((p) => p.start <= T + 1e-6);
    return Math.max(0, k);
  },
  unitsWithTimes() {   // [{i, t0, t1, words, piece}] in chapter time, for every rendered unit
    const out = [];
    for (const p of this.pieces) if (p.tl) for (const u of p.tl.units) out.push({ ...u, t0: u.t0 + p.start, t1: u.t1 + p.start, off: p.start });
    return out;
  },
  unitAtTime(T) {
    const us = this.unitsWithTimes();
    return us.findLast((u) => u.t0 <= T + 0.02) || us[0];
  },
  timeOfUnit(i) {
    const u = this.unitsWithTimes().find((x) => x.i === i);
    if (u) return u.t0;
    const p = this.pieces.find((q) => q.u0 != null && q.u0 <= i && i < q.u1);
    return p ? p.start : 0;
  },
  // go back `sec`, then land on a natural break in the speech (a pause between words), never mid-word
  snapBack(T, sec) {
    if (!sec) return T;
    const target = Math.max(0, T - sec);
    const words = [];
    for (const u of this.unitsWithTimes()) for (const w of u.words || []) words.push([w[2] + u.off, w[3] + u.off]);
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
    if (this.piece < 0) return this.startT || 0;
    return this.pieces[this.piece].start + (audio.currentTime || 0);
  },
  chapterTotal() { return this.pieces.reduce((a, p) => a + p.dur, 0); },

  // ---------- DOM
  render() {
    const b = this.book, ch = this.ch;
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
    this.$.speed = h("button", { class: "speedbtn", title: "Playback speed", onclick: (e) => this.sheet("speed", e) });
    this.$.status = h("div", { class: "float-status" });
    const bar = h("div", { class: "player" },
      scrub, h("div", { class: "times" }, this.$.elapsed, this.$.remain),
      h("div", { class: "ctrls" },
        this.$.speed,
        ctrl(skipIcon(-1), `Back ${prefs.skip} s`, () => this.skip(-1)),
        ctrl(ICON.prev, "Previous sentence", () => this.step(-1), "sm"),
        this.$.play,
        ctrl(ICON.next, "Next sentence", () => this.step(1), "sm"),
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
    let pos = meta.start;
    const put = (s) => s.split("\n").forEach((part, k) => { if (k) span.append(h("br")); if (part) span.append(part); });
    u.words.forEach(([s, e], k) => {
      if (s > pos) put(text.slice(pos, s));
      span.append(h("span", { class: "w", "data-k": k }, text.slice(s, e)));
      pos = e;
    });
    if (pos < meta.end) put(text.slice(pos, meta.end));
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
  // the one place that moves the playhead: load the right piece, wait if it isn't rendered yet, then play
  async seek(T, play = realPlaying(), unitHint) {
    clearTimeout(this.waiting); this.waiting = null;
    T = Math.max(0, T);
    let k = this.pieceAt(T);
    if (unitHint != null && this.pieces[0].u0 != null) k = this.pieces.findIndex((p) => p.u0 <= unitHint && unitHint < p.u1);
    const p = this.pieces[k];
    if (!p.ready || !p.tl) await this.refreshReadiness();
    if (!p.ready || !p.tl) {
      audio.pause();
      if (unitHint != null) this.setCurrent(unitHint);
      api(`/api/books/${this.book.id}/focus`, { method: "POST", body: JSON.stringify({ chapter: this.ch.index, unit: p.u0 ?? 0 }) }).catch(() => {});
      this.showWaiting(p);
      this.setPlayIcon(false);
      if (play) this.waiting = setTimeout(() => this.root && this.seek(unitHint != null ? this.timeOfUnit(unitHint) : T, true, unitHint), 3000);
      return;
    }
    // where inside this file: for a tapped sentence, straight from the file's own timeline (no estimates involved)
    const ut = unitHint != null ? p.tl.units.find((x) => x.i === unitHint) : null;
    const rel = ut ? ut.t0 : T - p.start;
    this.hideWaiting();
    this.stoppedAt = 0;               // an explicit move is not a "resume": no automatic rewind
    this.loading = true;
    try {
      if (this.piece !== k || !audio.src.endsWith(p.url)) {
        await this.load(p.url);
        this.piece = k;
      }
      audio.currentTime = Math.min(Math.max(0, rel), Math.max(0, p.dur - 0.05));
      audio.playbackRate = store.get(`speed:${this.book.id}`, 1);
    } finally { this.loading = false; }
    if (unitHint != null) this.setCurrent(unitHint);
    if (play) {
      this.userPaused = false;
      this.ownPlayAt = Date.now();
      try { await audio.play(); } catch { this.$.status.replaceChildren(h("span", { class: "waiting" }, "Tap play to start")); }
      this.wake(true);
    }
    this.setPlayIcon(audio.paused);
    this.prefetch(k + 1);
    this.positionState();
  },
  load(url) {
    const meta = (ms) => new Promise((res) => {
      const done = (ok) => { clearTimeout(timer); audio.removeEventListener("loadedmetadata", onOk); res(ok); };
      const onOk = () => done(true);
      const timer = setTimeout(() => done(false), ms);
      audio.addEventListener("loadedmetadata", onOk);
    });
    audio.src = url;
    audio.load();
    return meta(4000).then((ok) => ok || (audio.load(), meta(15000)));   // a stalled first load gets one retry
  },
  prefetch(k) {
    const p = this.pieces[k];
    if (p && p.ready) { this.loadPieceTimeline(p).then(() => this.restack()).catch(() => {}); fetch(p.url).catch(() => {}); }
  },
  async toggle() {
    if (this.waiting) { clearTimeout(this.waiting); this.waiting = null; this.$.status.textContent = ""; this.setPlayIcon(true); return; }
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
  showWaiting(p) {
    const w = this.$.status;
    if (!navigator.onLine) { w.replaceChildren(h("span", { class: "waiting" }, "You're offline and this part isn't downloaded")); return; }
    const rate = this.lastRate || 1.2;
    const secs = Math.max(10, Math.round((p.dur || 60) / rate));
    w.replaceChildren(h("span", { class: "waiting" }, h("span", { class: "spinner" }), `Rendering this part · about ${secs < 60 ? secs + " s" : Math.round(secs / 60) + " min"}`));
    api("/api/status").then((st) => { this.lastRate = st.worker.rate || this.lastRate; }).catch(() => {});
  },
  hideWaiting() { if (this.$?.status) this.$.status.replaceChildren(); },
  async wake(on) {
    try {
      if (on && prefs.wake && "wakeLock" in navigator && !this.lock) this.lock = await navigator.wakeLock.request("screen");
      if (!on && this.lock) { await this.lock.release(); this.lock = null; }
    } catch { this.lock = null; }
  },
  setPlayIcon(paused) { if (this.$?.play) this.$.play.innerHTML = paused ? ICON.play : ICON.pause; },
  step(d) {
    const T = this.chapterTime();
    const u = this.unitAtTime(T);
    if (!u) return;
    if (d < 0 && T - u.t0 > 1.5) return this.seek(u.t0, realPlaying());
    const i = Math.max(0, Math.min(this.ch.units.length - 1, u.i + d));
    this.seek(this.timeOfUnit(i), realPlaying(), i);
  },
  skip(dir) { this.seek(this.chapterTime() + dir * prefs.skip, realPlaying()); },

  async onEnded() {
    const k = this.piece + 1;
    if (k < this.pieces.length) return this.seek(this.pieces[k].start, true);
    // end of chapter: continue with the next one (unless switched off in settings)
    if (!prefs.autoNext) { this.setPlayIcon(true); return; }
    const chs = this.book.chapters.filter((c) => c.include && c.n_units);
    const n = chs.findIndex((c) => c.index === this.ch.index);
    if (n >= 0 && n + 1 < chs.length) {
      positions.remember(this.book.id, { chapter: chs[n + 1].index, unit: 0, t: 0 });
      positions.push(this.book.id);
      setTimeout(() => offline.sync(this.book.id), 5000);
      location.hash = `#/read/${this.book.id}/${chs[n + 1].index}/0?play`;
    } else { this.setPlayIcon(true); toast("The end."); }
  },

  // network trouble (car, tunnel, metro): keep the place and retry with backoff
  onError(stalled = false) {
    // only network trouble is worth retrying; a decode error would just loop
    // retry network trouble and server hiccups (a 5xx shows up as "not supported"); never loop on a local file
    const code = audio.error?.code;
    if (!this.root || this.userPaused || audio.src.startsWith("blob:")) return;
    if (!stalled && code && code !== MediaError.MEDIA_ERR_NETWORK && code !== MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) return;
    if (this.retry > 8) { this.$.status.replaceChildren(h("span", { class: "waiting" }, "Can't reach the server right now")); return; }
    const T = this.chapterTime();
    clearTimeout(this.retryTimer);
    const wait = Math.min(30000, 2000 * 2 ** this.retry++);
    this.$.status.replaceChildren(h("span", { class: "waiting" }, h("span", { class: "spinner" }), `Connection lost · retrying in ${Math.round(wait / 1000)} s`));
    this.retryTimer = setTimeout(async () => { this.piece = -1; await this.seek(T, true); if (!audio.paused) { this.retry = 0; this.hideWaiting(); } }, wait);
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
      if (this.piece < 0 || this.loading) return this.paintTime();
      const p = this.pieces[this.piece];
      if (!p?.tl) return this.paintTime();
      const t = audio.currentTime;
      const u = p.tl.units.findLast((x) => x.t0 <= t + 0.02) || p.tl.units[0];
      if (u.i !== this.cur) { this.setCurrent(u.i); }
      const words = u.words || [];
      let k = -1;
      for (let j = 0; j < words.length; j++) { if (words[j][2] <= t + 0.03) k = j; else break; }
      const el = this.unitEls[u.i];
      const w = k >= 0 && t <= words[k][3] + 0.25 ? el?.querySelectorAll(".w")[k] : null;
      if (w !== this.curWord) { this.curWord?.classList.remove("cur"); w?.classList.add("cur"); this.curWord = w; }
      // follow long sentences word by word
      if (w && this.follow && !audio.paused) { const r = w.getBoundingClientRect(); if (r.bottom > innerHeight * 0.66 || r.top < innerHeight * 0.12) w.scrollIntoView({ behavior: "smooth", block: "center" }); }
      this.paintTime();
    };
    tick();
  },
  paintTime() {
    if (!this.$?.elapsed) return;
    const total = this.chapterTotal(), rate = audio.playbackRate || 1;
    const t = this.dragT ?? this.chapterTime();
    const exact = this.pieces.every((p) => p.tl);
    this.$.elapsed.textContent = fmt(t / rate);
    this.$.remain.textContent = `−${exact ? "" : "~"}${fmt(Math.max(0, total - t) / rate)}`;
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
    const total = this.chapterTotal();
    this.$.track.replaceChildren();
    for (const p of this.pieces) if (p.ready) this.$.track.append(h("div", { class: "seg", style: `left:${(100 * p.start) / total}%;width:${(100 * p.dur) / total}%` }));
    this.$.played = h("div", { class: "played" });
    this.$.track.append(this.$.played);
  },
  save() {
    if (!this.book || this.piece < 0) return;
    const T = this.chapterTime();
    positions.remember(this.book.id, { chapter: this.ch.index, unit: Math.max(this.cur, 0), t: T });
    positions.push(this.book.id);
  },
  positionState() {
    if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState || this.piece < 0) return;
    const p = this.pieces[this.piece];
    try { navigator.mediaSession.setPositionState({ duration: Math.max(p.dur, 0.1), position: Math.min(audio.currentTime || 0, p.dur), playbackRate: audio.playbackRate || 1 }); } catch {}
  },
  media() {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: chapterLabel(this.ch.title, this.book.lang), artist: this.book.author, album: this.book.title,
      artwork: [{ src: `/api/books/${this.book.id}/cover`, sizes: "512x512" }] });
    const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch {} };
    set("play", () => this.toggle()); set("pause", () => this.toggle());
    set("previoustrack", () => this.step(-1)); set("nexttrack", () => this.step(1));
    set("seekbackward", () => this.skip(-1)); set("seekforward", () => this.skip(1));
    set("seekto", (d) => this.seek((this.pieces[this.piece]?.start || 0) + d.seekTime, realPlaying()));
  },
};

audio.addEventListener("ended", () => player.root  && player.onEnded());
audio.addEventListener("error", () => player.onError());
// a stall that never recovers (lost coverage mid-file) is handled like a network error
let stallTimer = 0;
audio.addEventListener("waiting", () => { clearTimeout(stallTimer); stallTimer = setTimeout(() => { if (player.root && !player.userPaused && audio.readyState < 3) player.onError(true); }, 12000); });
audio.addEventListener("playing", () => clearTimeout(stallTimer));
audio.addEventListener("play", () => { player.setPlayIcon(false); });
audio.addEventListener("playing", () => { player.retry = 0; if (player.$?.status && /retrying|reach/.test(player.$.status.textContent)) player.hideWaiting(); });
audio.addEventListener("pause", () => {
  player.wake(false);
  player.setPlayIcon(true);
  if (!player.root || audio.ended) return;
  player.stoppedAt = Date.now();     // user pause *or* a system interruption (call, Siri, navigation)
  player.save();
});
audio.addEventListener("ratechange", () => player.positionState());
// stopped by the system and resumed by the system (no tap): still go back a bit
audio.addEventListener("play", () => {
  if (!player.root || !player.stoppedAt || player.loading || Date.now() - (player.ownPlayAt || 0) < 2000) return;
  const away = Date.now() - player.stoppedAt;
  player.stoppedAt = 0;
  const back = rewindFor(away);
  if (back) { const T = player.snapBack(player.chapterTime(), back); player.seek(T, true); }
});
setInterval(() => { if (player.root && !audio.paused) player.save(); }, 5000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") player.save(); });

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
