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

// theme & text size
const applyLook = () => {
  const theme = store.get("theme", "auto");
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.style.setProperty("--text-size", store.get("size", window.innerWidth < 640 ? 19 : 21) + "px");
};
applyLook();

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
  const main = h("main", { class: "wrap" }, h("div", { class: "lib-head" }, h("h1", {}, "Library"),
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
  const pos = b.position;
  const first = b.chapters.find((c) => c.include && c.n_units);
  const cur = pos ? b.chapters.find((c) => c.index === pos.chapter) : first;
  const top = h("header", { class: "top" }, h("div", { class: "wrap" },
    h("a", { class: "iconbtn", href: "#/", title: "Library", html: ICON.back }), h("div", { class: "grow" }), statusPill()));
  const voice = h("select", { title: "Narrator voice", onchange: async () => {
    if (!confirm(`Switch the narrator to ${voice.value}? Audio already rendered for this book will be re-rendered.`)) { voice.value = b.voice; return; }
    await api(`/api/books/${id}`, { method: "PATCH", body: JSON.stringify({ voice: voice.value }) });
    toast(`Narrator: ${voice.value}`); viewBook(id);
  } }, b.voices.map((v) => h("option", { value: v, selected: v === b.voice }, v)));
  const go = cur ? h("a", { class: "btn", href: `#/read/${id}/${cur.index}${pos ? "/" + pos.unit : ""}`, html: ICON.play + `<span>${pos ? "Continue" : "Start"} · ${cur.title}</span>` }) : null;
  const list = h("ul", { class: "chapters" });
  for (const c of b.chapters.filter((c) => c.n_units)) {
    const frac = c.n_segments ? c.ready / c.n_segments : 0;
    list.append(h("li", { class: (c.include && c.n_units ? "" : "skip ") + (cur && c.index === cur.index ? "cur" : "") },
      h("a", { href: c.n_units ? `#/read/${id}/${c.index}` : null, title: c.include ? "" : "Skipped by default (front/back matter)" },
        h("span", { class: "ct" }, c.title),
        h("span", { class: "state" }, c.n_units ? h("div", { class: "bar", title: `${c.ready}/${c.n_segments} rendered` }, h("i", { class: "ready", style: `width:${frac * 100}%` })) : ""),
        h("span", { class: "dur" }, c.n_units ? "~" + human(c.est) : "—"))));
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
const SPEEDS = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.5, 1.75, 2];

const player = {
  book: null, ch: null, unitEls: [], segOfUnit: [], timelines: new Map(), seg: -1, cur: -1, curWord: null,
  follow: true, waiting: null, lastPause: 0, raf: 0, saveTimer: 0, root: null,

  detach() {
    audio.pause();
    cancelAnimationFrame(this.raf);
    clearInterval(this.saveTimer);
    clearTimeout(this.waiting);
    this.root = null;
  },

  async open(bookId, chIndex, unit) {
    this.detach();
    const [b, ch] = await Promise.all([api(`/api/books/${bookId}`), api(`/api/books/${bookId}/chapters/${chIndex}`)]);
    this.book = b; this.ch = ch; this.timelines = new Map(); this.seg = -1; this.cur = -1; this.curWord = null;
    this.segOfUnit = [];
    ch.segments.forEach((s, si) => { for (let i = s.u0; i < s.u1; i++) this.segOfUnit[i] = si; });
    this.render();
    audio.playbackRate = store.get(`speed:${bookId}`, 1);
    this.updateSpeed();
    const start = Number.isFinite(unit) ? Math.min(unit, ch.units.length - 1) : 0;
    this.setCurrent(Math.max(0, start), true);
    this.media();
    api(`/api/books/${bookId}/focus`, { method: "POST", body: JSON.stringify({ chapter: chIndex, unit: start }) }).catch(() => {});
    await this.loadSeg(this.segOfUnit[start] ?? 0).catch(() => {});
    this.paintScrub();
    this.saveTimer = setInterval(() => { if (!audio.paused) this.save(); }, 5000);
    this.loop();
  },

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
      if (span && !getSelection().toString()) this.playFrom(+span.dataset.i);
    });

    this.$ = {};
    const scrub = h("div", { class: "scrub", title: "Seek", onclick: (e) => this.scrubTo(e) },
      this.$.track = h("div", { class: "track" }), this.$.knob = h("div", { class: "knob" }));
    const playBtn = this.$.play = h("button", { class: "play", title: "Play (space)", html: ICON.play, onclick: () => this.toggle() });
    const ctrl = (icon, title, fn) => h("button", { class: "iconbtn", title, html: icon, onclick: fn });
    this.$.speed = h("button", { class: "chip", title: "Speed", onclick: () => this.cycleSpeed() });
    this.$.times = h("div", { class: "times" });
    this.$.status = h("div", { class: "status" });
    const bar = h("div", { class: "player" }, scrub,
      h("div", { class: "row" }, this.$.times,
        h("div", { class: "ctrls" }, ctrl(ICON.back15, "Back 15 s (shift ←)", () => this.skip(-15)), ctrl(ICON.prev, "Previous sentence (←)", () => this.step(-1)),
          playBtn, ctrl(ICON.next, "Next sentence (→)", () => this.step(1)), ctrl(ICON.fwd15, "Forward 15 s (shift →)", () => this.skip(15))),
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
    const s = h("div", { class: "sheet", onclick: (e) => e.stopPropagation() });
    if (kind === "chapters") {
      s.append(h("h3", {}, "Chapters"), h("div", { class: "list" }, this.book.chapters.filter((c) => c.n_units).map((c) =>
        h("a", { href: `#/read/${this.book.id}/${c.index}`, class: c.index === this.ch.index ? "on" : "" }, c.title, h("span", { class: "muted" }, "  ~" + human(c.est))))));
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

  // ---------- segments
  segUrl(si) { return `/api/books/${this.book.id}/audio/${this.ch.index}/${si}.m4a`; },
  async loadSeg(si) {
    if (this.timelines.has(si)) return this.timelines.get(si);
    const tl = await api(`/api/books/${this.book.id}/chapters/${this.ch.index}/segments/${si}`);
    this.timelines.set(si, tl);
    this.ch.segments[si].ready = true;
    this.ch.segments[si].dur = tl.duration;
    for (const u of tl.units) this.wordify(u);
    return tl;
  },
  wordify(u) {
    const span = this.unitEls[u.i];
    if (!span || !u.words?.length) { span?.classList.remove("pending"); return; }
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
    span.classList.remove("pending");
    u.wordEls = span.querySelectorAll(".w");
  },
  async ensureReady(si) {
    if (this.ch.segments[si]?.ready || this.timelines.has(si)) { try { await this.loadSeg(si); return true; } catch {} }
    const c = await api(`/api/books/${this.book.id}/chapters/${this.ch.index}`).catch(() => null);
    if (c) c.segments.forEach((s, k) => { this.ch.segments[k].ready = s.ready; });
    this.paintScrub();
    if (this.ch.segments[si]?.ready) { await this.loadSeg(si); return true; }
    return false;
  },

  // ---------- playback
  async playFrom(i, autoplay = true) {
    i = Math.max(0, Math.min(i, this.ch.units.length - 1));
    const si = this.segOfUnit[i];
    this.setCurrent(i);
    clearTimeout(this.waiting);
    if (!(await this.ensureReady(si))) {
      audio.pause();
      api(`/api/books/${this.book.id}/focus`, { method: "POST", body: JSON.stringify({ chapter: this.ch.index, unit: i }) }).catch(() => {});
      this.$.status.textContent = "Preparing audio for this part… it starts by itself when ready.";
      this.setPlayIcon(true);
      this.waiting = setTimeout(() => this.root && this.playFrom(i, autoplay), 3000);
      return;
    }
    this.$.status.textContent = "";
    const tl = this.timelines.get(si);
    const ut = tl.units.find((u) => u.i === i);
    this.loading = true;                       // keep the highlight loop off while the file switches
    try {
      if (this.seg !== si || !audio.src.endsWith(this.segUrl(si))) {
        const meta = (ms) => new Promise((res) => {
          const done = (ok) => { clearTimeout(timer); audio.removeEventListener("loadedmetadata", onOk); res(ok); };
          const onOk = () => done(true);
          const timer = setTimeout(() => done(false), ms);
          audio.addEventListener("loadedmetadata", onOk);
        });
        audio.src = this.segUrl(si);
        audio.load();
        if (!(await meta(4000))) { audio.load(); await meta(10000); }   // stalled first load: retry once
        this.seg = si;
      }
      audio.currentTime = ut ? ut.t0 : 0;
      audio.playbackRate = store.get(`speed:${this.book.id}`, 1);
    } finally { this.loading = false; }
    if (autoplay) {
      try { await audio.play(); } catch { this.$.status.textContent = "Tap play to start"; }
    }
    this.setPlayIcon(audio.paused);
    this.prefetch(si + 1);
  },
  prefetch(si) {
    if (si < this.ch.segments.length && this.ch.segments[si].ready) {
      this.loadSeg(si).catch(() => {});
      fetch(this.segUrl(si)).catch(() => {});
    }
  },
  async toggle() {
    if (this.waiting) { clearTimeout(this.waiting); this.waiting = null; this.$.status.textContent = ""; this.setPlayIcon(true); return; }
    if (audio.paused) {
      const resumeAt = Date.now() - this.lastPause > 120000 ? this.cur : null;      // long pause: restart the sentence
      if (this.seg < 0 || resumeAt != null || !audio.src) return this.playFrom(this.cur);
      await audio.play().catch(() => {});
    } else { audio.pause(); this.lastPause = Date.now(); this.save(); }
    this.setPlayIcon(audio.paused);
  },
  setPlayIcon(paused) { if (this.$?.play) this.$.play.innerHTML = paused ? ICON.play : ICON.pause; },
  step(d) {
    const tl = this.timelines.get(this.seg);
    const ut = tl?.units.find((u) => u.i === this.cur);
    if (d < 0 && ut && audio.currentTime - ut.t0 > 1.5) return this.playFrom(this.cur, !audio.paused || this.seg < 0);
    this.playFrom(this.cur + d, !audio.paused);
  },
  async skip(sec) {
    if (this.seg < 0) return;
    let t = audio.currentTime + sec, si = this.seg;
    const dur = this.timelines.get(si)?.duration || audio.duration || 0;
    if (t < 0 && si > 0 && (await this.ensureReady(si - 1))) { si -= 1; t += this.timelines.get(si).duration; }
    else if (t > dur && si + 1 < this.ch.segments.length && (await this.ensureReady(si + 1))) { t -= dur; si += 1; }
    t = Math.max(0, t);
    const tl = this.timelines.get(si);
    const u = tl.units.findLast((x) => x.t0 <= t) || tl.units[0];
    const playing = !audio.paused;
    if (si !== this.seg) { await this.playFrom(u.i, playing); audio.currentTime = t; }
    else audio.currentTime = Math.min(t, dur - 0.05);
  },
  cycleSpeed() {
    const cur = audio.playbackRate;
    const next = SPEEDS[(SPEEDS.findIndex((s) => Math.abs(s - cur) < 0.01) + 1) % SPEEDS.length];
    audio.playbackRate = next;
    store.set(`speed:${this.book.id}`, next);
    this.updateSpeed();
  },
  updateSpeed() { if (this.$?.speed) this.$.speed.textContent = `${audio.playbackRate}×`.replace("1×", "1.0×"); },

  async onEnded() {
    const next = this.seg + 1;
    if (next < this.ch.segments.length) {
      const u0 = this.ch.segments[next].u0;
      return this.playFrom(u0, true);
    }
    // end of chapter: continue with the next one
    const chs = this.book.chapters.filter((c) => c.include && c.n_units);
    const k = chs.findIndex((c) => c.index === this.ch.index);
    if (k >= 0 && k + 1 < chs.length) {
      location.hash = `#/read/${this.book.id}/${chs[k + 1].index}/0?play`;
    } else { this.setPlayIcon(true); toast("The end."); }
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
    if (force || r.top < vh * 0.18 || r.bottom > vh * 0.62) el.scrollIntoView({ behavior: force ? "auto" : "smooth", block: "center" });
  },
  loop() {
    const tick = () => {
      if (!this.root) return;
      this.raf = requestAnimationFrame(tick);
      const tl = this.timelines.get(this.seg);
      if (!tl || this.seg < 0 || this.loading) return this.paintTime();
      const t = audio.currentTime;
      let u = tl.units.findLast((x) => x.t0 <= t + 0.02) || tl.units[0];
      if (u.i !== this.cur) { this.setCurrent(u.i); this.save(true); }
      const words = u.words || [];
      let k = -1;
      for (let j = 0; j < words.length; j++) { if (words[j][2] <= t + 0.03) k = j; else break; }
      const w = k >= 0 && t <= words[k][3] + 0.25 ? u.wordEls?.[k] : null;
      if (w !== this.curWord) { this.curWord?.classList.remove("cur"); w?.classList.add("cur"); this.curWord = w; }
      this.paintTime();
    };
    tick();
  },
  chapterTime() {
    let t = 0;
    for (let s = 0; s < Math.max(this.seg, 0); s++) t += this.ch.segments[s].dur ?? this.ch.segments[s].est;
    return t + (this.seg >= 0 ? audio.currentTime || 0 : 0);
  },
  chapterTotal() { return this.ch.segments.reduce((a, s) => a + (s.dur ?? s.est), 0); },
  paintTime() {
    if (!this.$?.times) return;
    const total = this.chapterTotal(), t = this.chapterTime(), rate = audio.playbackRate || 1;
    const exact = this.ch.segments.every((s) => s.dur != null);
    this.$.times.textContent = `${fmt(t / rate)} / ${exact ? "" : "~"}${fmt(total / rate)}`;
    this.$.knob.style.left = `${(100 * t) / Math.max(total, 1)}%`;
    if (this.$.played) this.$.played.style.width = `${(100 * t) / Math.max(total, 1)}%`;
  },
  paintScrub() {
    if (!this.$?.track) return;
    const total = this.chapterTotal();
    this.$.track.replaceChildren();
    let x = 0;
    for (const s of this.ch.segments) {
      const w = s.dur ?? s.est;
      if (s.ready) this.$.track.append(h("div", { class: "seg", style: `left:${(100 * x) / total}%;width:${(100 * w) / total}%` }));
      x += w;
    }
    this.$.played = h("div", { class: "played" });
    this.$.track.append(this.$.played);
  },
  async scrubTo(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const target = ((e.clientX - r.left) / r.width) * this.chapterTotal();
    let x = 0;
    for (let si = 0; si < this.ch.segments.length; si++) {
      const s = this.ch.segments[si], w = s.dur ?? s.est;
      if (target < x + w || si === this.ch.segments.length - 1) {
        if (!(await this.ensureReady(si))) return this.playFrom(s.u0, true);
        const tl = this.timelines.get(si), t = target - x;
        const u = tl.units.findLast((q) => q.t0 <= t) || tl.units[0];
        await this.playFrom(u.i, !audio.paused || true);
        audio.currentTime = Math.min(t, tl.duration - 0.05);
        return;
      }
      x += w;
    }
  },
  save(debounced) {
    if (!this.book) return;
    const send = () => api(`/api/books/${this.book.id}/position`, { method: "PUT", body: JSON.stringify({ chapter: this.ch.index, unit: Math.max(this.cur, 0), t: audio.currentTime || 0 }) }).catch(() => {});
    if (debounced) { clearTimeout(this._saveDeb); this._saveDeb = setTimeout(send, 1500); } else send();
  },
  media() {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: this.ch.title, artist: this.book.author, album: this.book.title,
      artwork: [{ src: `/api/books/${this.book.id}/cover`, sizes: "512x512" }] });
    const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch {} };
    set("play", () => this.toggle()); set("pause", () => this.toggle());
    set("previoustrack", () => this.step(-1)); set("nexttrack", () => this.step(1));
    set("seekbackward", () => this.skip(-15)); set("seekforward", () => this.skip(15));
  },
};
audio.addEventListener("ended", () => player.root && player.onEnded());
audio.addEventListener("play", () => player.setPlayIcon(false));
audio.addEventListener("pause", () => player.setPlayIcon(true));

addEventListener("keydown", (e) => {
  if (!player.root || e.target.closest("input,select,textarea")) return;
  if (e.code === "Space") { e.preventDefault(); player.toggle(); }
  else if (e.code === "ArrowLeft") { e.preventDefault(); e.shiftKey ? player.skip(-15) : player.step(-1); }
  else if (e.code === "ArrowRight") { e.preventDefault(); e.shiftKey ? player.skip(15) : player.step(1); }
  else if (e.key === "]" || e.key === "[") player.cycleSpeed();
});

// ------------------------------------------------------------------ router
async function route() {
  const [path, query] = location.hash.slice(1).split("?");
  const parts = (path || "/").split("/").filter(Boolean);
  try {
    if (parts[0] === "book" && parts[1]) await viewBook(parts[1]);
    else if (parts[0] === "read" && parts[1]) {
      await player.open(parts[1], +parts[2] || 1, parts[3] != null ? +parts[3] : undefined);
      if (query === "play") player.playFrom(player.cur, true);
    } else await viewLibrary();
  } catch (e) {
    app.replaceChildren(h("main", { class: "wrap" }, h("div", { class: "empty", style: "margin-top:3rem" }, h("h2", {}, "Something went wrong"), h("p", {}, e.message),
      h("a", { class: "btn", href: "#/" }, "Library"))));
  }
}
addEventListener("hashchange", route);
route();
