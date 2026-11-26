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

const api = async (path, opts = {}) => {
  const r = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
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
const toast = (msg, ms = 2800) => { const t = h("div", { class: "toast" }, msg); document.body.append(t); setTimeout(() => t.remove(), ms); };
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem("reader:" + k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem("reader:" + k, JSON.stringify(v)),
};
const coverEl = (b) => {
  const c = h("div", { class: "cover" });
  const img = h("img", { src: `/api/books/${b.id}/cover`, alt: "", loading: "lazy" });
  img.onerror = () => {
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

// ------------------------------------------------------------------ worker status pill
let statusTimer = null;
const statusPill = () => {
  const pill = h("div", { class: "pill" }, h("span", { class: "dot" }), "…");
  const tick = async () => {
    if (!pill.isConnected) return;
    try {
      const { worker: w } = await api("/api/status");
      pill.replaceChildren(h("span", { class: "dot" + (w.state === "rendering" ? " on" : "") }));
      if (w.state === "rendering" && w.job) pill.append("Rendering ", h("b", {}, w.job.title), ` · ${w.job.chapter_title}` + (w.rate ? ` · ${w.rate.toFixed(1)}× realtime` : ""));
      else if (w.state === "error") pill.append("Renderer error: " + (w.error || "?"));
      else pill.append("Renderer idle");
    } catch { pill.replaceChildren("offline"); }
  };
  clearInterval(statusTimer);
  statusTimer = setInterval(tick, 4000);
  tick();
  return pill;
};

// ------------------------------------------------------------------ upload
const upload = async (file) => {
  if (!file || !/\.epub$/i.test(file.name)) return toast("That isn't an .epub file");
  toast(`Importing “${file.name}”…`, 8000);
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
    location.hash = `#/book/${job.book}`;
  } catch (e) { toast("Import failed: " + e.message, 6000); }
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
  const top = h("header", { class: "top" }, h("div", { class: "wrap" },
    h("a", { class: "brand", href: "#/" }, h("i"), "reader"), h("div", { class: "grow" }), statusPill(),
    h("button", { class: "btn", onclick: picker, html: ICON.plus + "<span>Add book</span>" })));
  const main = h("main", { class: "wrap" });
  // one tap to keep listening
  const recent = books.find((b) => positions.best(b.id, b.position));
  if (recent) {
    const pos = positions.best(recent.id, recent.position);
    const ch = recent.chapters.find((c) => c.index === pos.chapter);
    const go = () => { location.hash = `#/read/${recent.id}/${pos.chapter}?play`; };
    main.append(h("section", { class: "continue", onclick: go }, coverEl(recent),
      h("div", { class: "grow" }, h("div", { class: "muted", style: "font-size:.8rem;text-transform:uppercase;letter-spacing:.06em" }, "Continue listening"),
        h("div", { class: "t" }, recent.title), h("div", { class: "muted" }, ch ? ch.title : "")),
      h("button", { class: "play", title: "Play", html: ICON.play, onclick: (e) => { e.stopPropagation(); go(); } })));
  }
  main.append(h("div", { class: "lib-head" }, h("h1", {}, "Library"),
    books.length ? h("span", { class: "muted" }, `${books.length} book${books.length > 1 ? "s" : ""}`) : null));
  if (!books.length) {
    main.append(h("div", { class: "empty" }, h("h2", {}, "No books yet"), h("p", {}, "Drop an EPUB anywhere on this page, or use “Add book”."),
      h("button", { class: "btn", onclick: picker }, "Choose an EPUB")));
  } else {
    const grid = h("div", { class: "grid" });
    for (const b of books) {
      const p = b.progress || {};
      const total = p.total_est || 1;
      grid.append(h("a", { class: "card", href: `#/book/${b.id}` }, coverEl(b),
        h("div", {}, h("div", { class: "t" }, b.title), h("div", { class: "a" }, b.author)),
        h("div", { class: "bar", title: `${human(p.ready_est)} of ${human(p.total_est)} rendered` },
          h("i", { class: "ready", style: `width:${(100 * (p.ready_est || 0)) / total}%` }),
          h("i", { style: `width:${(100 * (p.heard_est || 0)) / total}%` }))));
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
  const first = b.chapters.find((c) => c.include && c.n_units);
  const cur = pos ? b.chapters.find((c) => c.index === pos.chapter) : first;
  const top = h("header", { class: "top" }, h("div", { class: "wrap" },
    h("a", { class: "iconbtn", href: "#/", title: "Library", html: ICON.back }), h("div", { class: "grow" }), statusPill()));
  const voice = h("select", { title: "Narrator voice", onchange: async () => {
    if (!confirm(`Switch the narrator to ${voice.value}? Audio already rendered for this book will be re-rendered.`)) { voice.value = b.voice; return; }
    await api(`/api/books/${id}`, { method: "PATCH", body: JSON.stringify({ voice: voice.value }) });
    toast(`Narrator: ${voice.value}`); viewBook(id);
  } }, b.voices.map((v) => h("option", { value: v, selected: v === b.voice }, v)));
  const go = cur ? h("a", { class: "btn", href: `#/read/${id}/${cur.index}?play`, html: ICON.play + `<span>${pos ? "Continue" : "Start"} · ${cur.title}</span>` }) : null;
  const list = h("ul", { class: "chapters" });
  for (const c of b.chapters.filter((c) => c.n_units)) {
    const frac = c.n_segments ? c.ready / c.n_segments : 0;
    list.append(h("li", { class: cur && c.index === cur.index ? "cur" : "" },
      h("a", { href: `#/read/${id}/${c.index}/0` },
        h("span", { class: "ct" }, c.title),
        h("span", { class: "state" }, h("div", { class: "bar", title: `${c.ready}/${c.n_segments} rendered` }, h("i", { class: "ready", style: `width:${frac * 100}%` }))),
        h("span", { class: "dur" }, "~" + human(c.est)))));
  }
  const p = b.progress;
  const main = h("main", { class: "wrap" },
    h("section", { class: "book-hero" }, coverEl(b), h("div", {},
      h("h1", {}, b.title), h("div", { class: "by" }, b.author),
      h("div", { class: "meta-row" }, go, voice),
      h("div", { class: "muted" }, `${b.lang === "es" ? "Spanish" : "English"} · ~${human(p.total_est)} · ${human(p.ready_est)} rendered`),
      h("div", { class: "meta-row" }, h("button", { class: "btn ghost", onclick: async () => {
        if (!confirm(`Remove “${b.title}” and its audio from the library?`)) return;
        await api(`/api/books/${id}`, { method: "DELETE" }); location.hash = "#/";
      } }, "Remove")))),
    list);
  app.replaceChildren(top, main);
}

// ------------------------------------------------------------------ reader + player
//
// Everything is measured in *chapter time* (seconds into the chapter). A chapter plays from one continuous file once
// it is fully rendered; while it is still rendering, it plays from ~75 s pieces. `pieces` hides the difference.

const SPEED_PRESETS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

// how far to go back when playback resumes after stopping (pause, call, Siri, navigation prompt...)
const rewindFor = (ms) => (ms < 1500 ? 0 : ms < 30e3 ? 4 : ms < 5 * 60e3 ? 8 : ms < 60 * 60e3 ? 15 : 30);

const player = {
  book: null, ch: null, unitEls: [], pieces: [], piece: -1, cur: -1, curWord: null, follow: true,
  waiting: null, stoppedAt: 0, raf: 0, root: null, loading: false, retry: 0, retryTimer: 0, userPaused: true,

  detach() {
    audio.pause();
    cancelAnimationFrame(this.raf);
    clearTimeout(this.waiting); clearTimeout(this.retryTimer);
    this.waiting = null;
    this.root = null;
  },

  async open(bookId, chIndex, unit, autoplay) {
    this.detach();
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
      this.pieces = [{ url: `/api/books/${this.book.id}/chapter-audio/${ch.index}.m4a`, start: 0, dur: tl.duration, tl, ready: true }];
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
    const top = h("header", { class: "top" }, h("div", { class: "wrap" },
      h("a", { class: "iconbtn", href: `#/book/${b.id}`, title: b.title, html: ICON.back }),
      h("div", { class: "grow", style: "overflow:hidden" }, h("div", { style: "font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" }, ch.title),
        h("div", { class: "muted", style: "font-size:.8rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" }, b.title)),
      h("button", { class: "iconbtn", title: "Chapters", html: ICON.list, onclick: (e) => this.sheet("chapters", e) }),
      h("button", { class: "iconbtn", title: "Text", html: ICON.type, onclick: (e) => this.sheet("look", e) })));

    const page = h("article", { class: "page", lang: b.lang });
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
        const span = h("span", { class: "u pending", "data-i": u.i });
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
    const scrub = h("div", { class: "scrub", title: "Seek", onclick: (e) => this.scrubTo(e) },
      this.$.track = h("div", { class: "track" }), this.$.knob = h("div", { class: "knob" }));
    this.$.play = h("button", { class: "play", title: "Play (space)", html: ICON.play, onclick: () => { this.toggle(); } });
    const ctrl = (icon, title, fn) => h("button", { class: "iconbtn", title, html: icon, onclick: fn });
    this.$.speed = h("button", { class: "chip", title: "Playback speed", onclick: (e) => this.sheet("speed", e) });
    this.$.times = h("div", { class: "times" });
    this.$.status = h("div", { class: "status" });
    const bar = h("div", { class: "player" }, scrub,
      h("div", { class: "row" }, this.$.times,
        h("div", { class: "ctrls" }, ctrl(ICON.back15, "Back 15 s (shift ←)", () => this.skip(-15)), ctrl(ICON.prev, "Previous sentence (←)", () => this.step(-1)),
          this.$.play, ctrl(ICON.next, "Next sentence (→)", () => this.step(1)), ctrl(ICON.fwd15, "Forward 15 s (shift →)", () => this.skip(15))),
        h("div", { class: "right" }, this.$.speed)),
      this.$.status);
    this.$.follow = h("button", { class: "follow", hidden: true, onclick: () => { this.follow = true; this.$.follow.hidden = true; this.scrollToCur(true); } }, "↓ Back to narrator");
    const main = h("main", { class: "reader" }, page);
    this.root = main;
    app.replaceChildren(top, main, this.$.follow, bar);
    const stopFollow = () => { if (!audio.paused) { this.follow = false; this.$.follow.hidden = false; } };
    main.addEventListener("wheel", stopFollow, { passive: true });
    main.addEventListener("touchmove", stopFollow, { passive: true });
  },

  sheet(kind, ev) {
    ev.stopPropagation();
    document.querySelector(".sheet")?.remove();
    const s = h("div", { class: "sheet" + (kind === "speed" ? " bottom" : ""), onclick: (e) => e.stopPropagation() });
    if (kind === "chapters") {
      s.append(h("h3", {}, "Chapters"), h("div", { class: "list" }, this.book.chapters.filter((c) => c.n_units).map((c) =>
        h("a", { href: `#/read/${this.book.id}/${c.index}/0`, class: c.index === this.ch.index ? "on" : "" }, c.title, h("span", { class: "muted" }, "  ~" + human(c.est))))));
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
    if (this.$?.speed) this.$.speed.textContent = v === 1 ? "1×" : `${v}×`;
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
      if (unitHint != null) this.setCurrent(unitHint, true);
      api(`/api/books/${this.book.id}/focus`, { method: "POST", body: JSON.stringify({ chapter: this.ch.index, unit: p.u0 ?? 0 }) }).catch(() => {});
      this.$.status.textContent = "Preparing audio for this part… it starts by itself when ready.";
      this.setPlayIcon(false);
      if (play) this.waiting = setTimeout(() => this.root && this.seek(unitHint != null ? this.timeOfUnit(unitHint) : T, true, unitHint), 3000);
      return;
    }
    if (unitHint != null) T = this.timeOfUnit(unitHint);
    this.$.status.textContent = "";
    this.loading = true;
    try {
      if (this.piece !== k || !audio.src.endsWith(p.url)) {
        await this.load(p.url);
        this.piece = k;
      }
      audio.currentTime = Math.min(Math.max(0, T - p.start), Math.max(0, p.dur - 0.05));
      audio.playbackRate = store.get(`speed:${this.book.id}`, 1);
    } finally { this.loading = false; }
    if (play) {
      this.userPaused = false;
      try { await audio.play(); } catch { this.$.status.textContent = "Tap play to start"; }
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
  setPlayIcon(paused) { if (this.$?.play) this.$.play.innerHTML = paused ? ICON.play : ICON.pause; },
  step(d) {
    const T = this.chapterTime();
    const u = this.unitAtTime(T);
    if (!u) return;
    if (d < 0 && T - u.t0 > 1.5) return this.seek(u.t0, realPlaying());
    const i = Math.max(0, Math.min(this.ch.units.length - 1, u.i + d));
    this.seek(this.timeOfUnit(i), realPlaying(), i);
  },
  skip(sec) { this.seek(this.chapterTime() + sec, realPlaying()); },

  async onEnded() {
    const k = this.piece + 1;
    if (k < this.pieces.length) return this.seek(this.pieces[k].start, true);
    // end of chapter: continue with the next one
    const chs = this.book.chapters.filter((c) => c.include && c.n_units);
    const n = chs.findIndex((c) => c.index === this.ch.index);
    if (n >= 0 && n + 1 < chs.length) {
      positions.remember(this.book.id, { chapter: chs[n + 1].index, unit: 0, t: 0 });
      positions.push(this.book.id);
      location.hash = `#/read/${this.book.id}/${chs[n + 1].index}/0?play`;
    } else { this.setPlayIcon(true); toast("The end."); }
  },

  // network trouble (car, tunnel, metro): keep the place and retry with backoff
  onError(stalled = false) {
    // only network trouble is worth retrying; a decode error would just loop
    if (!this.root || this.userPaused || (!stalled && audio.error && audio.error.code !== MediaError.MEDIA_ERR_NETWORK)) return;
    const T = this.chapterTime();
    clearTimeout(this.retryTimer);
    const wait = Math.min(30000, 2000 * 2 ** this.retry++);
    this.$.status.textContent = `Connection lost — retrying in ${Math.round(wait / 1000)} s…`;
    this.retryTimer = setTimeout(async () => { this.piece = -1; await this.seek(T, true); if (!audio.paused) { this.retry = 0; this.$.status.textContent = ""; } }, wait);
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
    if (!this.$?.times) return;
    const total = this.chapterTotal(), t = this.chapterTime(), rate = audio.playbackRate || 1;
    const exact = this.pieces.every((p) => p.tl);
    this.$.times.textContent = `${fmt(t / rate)} / ${exact ? "" : "~"}${fmt(total / rate)}`;
    this.$.knob.style.left = `${(100 * t) / Math.max(total, 1)}%`;
    if (this.$.played) this.$.played.style.width = `${(100 * t) / Math.max(total, 1)}%`;
  },
  paintScrub() {
    if (!this.$?.track) return;
    const total = this.chapterTotal();
    this.$.track.replaceChildren();
    for (const p of this.pieces) if (p.ready) this.$.track.append(h("div", { class: "seg", style: `left:${(100 * p.start) / total}%;width:${(100 * p.dur) / total}%` }));
    this.$.played = h("div", { class: "played" });
    this.$.track.append(this.$.played);
  },
  scrubTo(e) {
    const r = e.currentTarget.getBoundingClientRect();
    this.seek(((e.clientX - r.left) / r.width) * this.chapterTotal(), true);
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
    navigator.mediaSession.metadata = new MediaMetadata({ title: this.ch.title, artist: this.book.author, album: this.book.title,
      artwork: [{ src: `/api/books/${this.book.id}/cover`, sizes: "512x512" }] });
    const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch {} };
    set("play", () => this.toggle()); set("pause", () => this.toggle());
    set("previoustrack", () => this.step(-1)); set("nexttrack", () => this.step(1));
    set("seekbackward", () => this.skip(-15)); set("seekforward", () => this.skip(15));
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
audio.addEventListener("playing", () => { player.retry = 0; if (player.$?.status && /retrying/.test(player.$.status.textContent)) player.$.status.textContent = ""; });
audio.addEventListener("pause", () => {
  player.setPlayIcon(true);
  if (!player.root || audio.ended) return;
  player.stoppedAt = Date.now();     // user pause *or* a system interruption (call, Siri, navigation)
  player.save();
});
audio.addEventListener("ratechange", () => player.positionState());
// stopped by the system and resumed by the system (no tap): still go back a bit
audio.addEventListener("play", () => {
  if (!player.root || !player.stoppedAt || player.loading) return;
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
  else if (e.code === "ArrowLeft") { e.preventDefault(); e.shiftKey ? player.skip(-15) : player.step(-1); }
  else if (e.code === "ArrowRight") { e.preventDefault(); e.shiftKey ? player.skip(15) : player.step(1); }
});

// ------------------------------------------------------------------ router
async function route() {
  const [path, query] = location.hash.slice(1).split("?");
  const parts = (path || "/").split("/").filter(Boolean);
  try {
    if (parts[0] === "book" && parts[1]) await viewBook(parts[1]);
    else if (parts[0] === "read" && parts[1]) await player.open(parts[1], +parts[2] || 1, parts[3] != null ? +parts[3] : undefined, query === "play");
    else await viewLibrary();
  } catch (e) {
    app.replaceChildren(h("main", { class: "wrap" }, h("div", { class: "empty", style: "margin-top:3rem" }, h("h2", {}, "Something went wrong"), h("p", {}, e.message),
      h("a", { class: "btn", href: "#/" }, "Library"))));
  }
}
addEventListener("hashchange", route);
route();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
