// The archive page: every part of the B站 upload as three panes on one clock: what she says (Japanese and
// Chinese), the chat with boardings and gifts, the super chats. One search runs through all three, a viewer
// can be picked out, and any row is a jump into the embedded player. The data comes from
// scripts/build_site.py (data/videos.json and data/pN.json).
"use strict";

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pad = n => String(n).padStart(2, "0");
const hms = t => { t = Math.max(0, Math.floor(t)); return `${Math.floor(t / 3600)}:${pad(Math.floor(t / 60) % 60)}:${pad(t % 60)}`; };
const num = n => n.toLocaleString("zh-CN");
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function parseTime(s) {
  s = String(s || "").trim().replace(/[：]/g, ":");
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return +s;
  const p = s.split(":").map(Number);
  if (p.some(isNaN) || p.length > 3) return null;
  return p.reduce((a, v) => a * 60 + v, 0);
}
// search folding: width, case, and hiragana to katakana, so either kana finds both
const fold = s => String(s || "").normalize("NFKC").toLowerCase().replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));

const ORDER = { guard: 0, gift: 1, chat: 2 };   // the chat pane's order at the same second
const GUARD_NAME = { 1: "总督", 2: "提督", 3: "舰长" };
const AVATARS = ["#8C5A4E", "#5D7487", "#7A6A8F", "#5E8571", "#9A7B4F", "#8A5F6B", "#6B7F99", "#A0675A"];
// super chat tiers [seal, amount], as in the live room
const TIERS = [["#4068a8", "#2c508c"], ["#3e8cb4", "#286e96"], ["#247e7c", "#00666e"], ["#d09d40", "#a86000"],
               ["#d6793a", "#aa541e"], ["#c44880", "#a02860"], ["#df4567", "#bd1418"]];
const tint = name => { let h = 2166136261; for (const c of name) h = Math.imul(h ^ c.codePointAt(0), 16777619); return AVATARS[(h >>> 0) % AVATARS.length]; };
const sealOf = name => ([...String(name).replace(/^[@\s_\-.]+/, "")][0] || "?").toUpperCase();

const S = {
  meta: null, cache: {}, part: 1, d: null, items: null, activity: null,
  q: "", qf: "", who: null, whoF: "", mention: false, mentions: 0,
  show: { chat: true, guard: true, gift: false },
  cur: 0, hold: null, follow: true,   // the time; the clicked row's time until the clock gets there
  play: null,     // the clock while following the player: {t0, at} (position t0 at performance.now() at)
  lost: null,     // the player itself was clicked: {t, playing} (where the lists stopped; whether they were following)
  touch: null, playerFocused: false,
  mobile: false, tab: "subs",
};
// The embedded player plays from the very second asked for, then at exactly 1x; but after its frame loads it takes a
// while to load the video, which the page cannot see (no message comes out of it). Set from the page's clock against
// the video's (2026-10, not signed in, 360P, its position sampled inside it every frame), two sessions of five starts a
// part: P3 is slow throughout; from one start to the next 0.1-0.2 s either way, between sessions up to 0.3 s with the
// network. Signed in, at a higher quality, it can take longer.
const LOAD_TO_PLAY_OF = { 1: 600, 2: 740, 3: 1190, 4: 690 };   // kept for the no-load fallback and old-key conversion
const loadToPlay = () => LOAD_TO_PLAY_OF[S.part] ?? 650;
// After the iframe's DOM loads, the video still takes a bit to start — a time the page can't see, and it changes
// with the network and the device. But it tracks how long THIS iframe took to DOM-load (measured correlation ~0.7),
// so the page predicts it from that on every play: no fixed guess, it adapts per network and per device on its own.
// The reader's per-part correction (saved on their own device) then trims whatever base offset is left.
const predictDelay = domLoad => clamp(domLoad * 0.85 + 500, 350, 5000);
const START_SKEW = 0, NO_LOAD_GUESS_EXTRA = 450;   // with no load event seen: from the request, this much more
// The reader's correction (+: the lists earlier) on top, by the - / + steps, kept for each part.
const NUDGE_KEY = p => `hinome-archive.nudge2.p${p}`;
function nudgeOf(part) {
  try {
    const v = localStorage.getItem(NUDGE_KEY(part));
    if (v != null) return clamp(+v || 0, -3, 3);
    // one kept before the start-up times were per part (on 650 ms for all): the same correction on the new base
    const old = localStorage.getItem(`hinome-archive.nudge.p${part}`) ?? localStorage.getItem("hinome-archive.nudge");
    return old == null ? 0 : clamp((+old || 0) + ((LOAD_TO_PLAY_OF[part] ?? 650) - 650) / 1000, -3, 3);
  } catch { return 0; }
}
S.nudge = 0;
S.stream = false;          // playing B站's own stream in our own <video> (frame-perfect); else the embed (estimate)
const VP = { player: null };
const P = {};
let PANES = [];
const nowT = () => S.hold ?? S.cur;

// ---------------------------------------------------------------- scroll bars, one look everywhere
// The panes hold up to tens of thousands of rows: the browser's own bar would be a few pixels tall there and,
// row heights being measured as rows come into view, would slide away from the pointer while dragged. This
// one keeps a size to grab, and with a model counting rows instead of pixels (the panes') stays under the
// pointer. Without a model it goes by pixels.
class Bar {
  constructor(box, host, model = null, onUser = null) {
    Object.assign(this, { box, host, onUser, drag: null });
    this.model = model || {
      get: () => {
        const max = box.scrollHeight - box.clientHeight;
        return { pos: max > 0 ? box.scrollTop / max : 0, size: box.scrollHeight ? box.clientHeight / box.scrollHeight : 1 };
      },
      set: pos => { box.scrollTop = pos * (box.scrollHeight - box.clientHeight); },
    };
    this.el = document.createElement("div");
    this.el.className = "sbar";
    this.el.hidden = true;
    this.el.innerHTML = '<i class="sthumb"></i>';
    this.thumb = this.el.firstChild;
    host.append(this.el);
    box.classList.add("sbox");   // the browser's bar hidden
    this.wire();
  }
  wire() {
    const el = this.el, th = this.thumb;
    const start = (e, dy) => {
      e.preventDefault();
      th.setPointerCapture(e.pointerId);
      this.drag = { dy };
      el.classList.add("drag");
    };
    th.addEventListener("pointerdown", e => start(e, e.clientY - th.getBoundingClientRect().top));
    el.addEventListener("pointerdown", e => {   // on the track: the thumb's middle comes there, and drags from there
      if (e.target === th) return;
      start(e, th.offsetHeight / 2);
      this.moveTo(e.clientY);
    });
    th.addEventListener("pointermove", e => { if (this.drag) this.moveTo(e.clientY); });
    const end = () => {
      if (!this.drag) return;
      this.drag = null;
      el.classList.remove("drag");
      this.update();
    };
    th.addEventListener("pointerup", end);
    th.addEventListener("pointercancel", end);
    el.addEventListener("wheel", e => { this.onUser?.(); this.box.scrollTop += e.deltaY; }, { passive: true });
  }
  moveTo(clientY) {   // the thumb under the pointer; the view where that puts it
    const r = this.el.getBoundingClientRect(), room = r.height - this.thumb.offsetHeight;
    const top = clamp(clientY - r.top - this.drag.dy, 0, Math.max(0, room));
    this.thumb.style.transform = `translateY(${top}px)`;
    this.onUser?.();
    this.model.set(room > 0 ? top / room : 0);
  }
  update() {
    const box = this.box, el = this.el;
    const { pos, size } = box.offsetWidth && box.clientHeight ? this.model.get() : { pos: 0, size: 1 };
    el.hidden = size >= 0.999;
    if (el.hidden) return;
    // over the right edge of the box, placed inside the host
    const hr = this.host.getBoundingClientRect(), br = box.getBoundingClientRect(), H = br.height;
    el.style.top = `${br.top - hr.top - this.host.clientTop}px`;
    el.style.height = `${H}px`;
    el.style.left = `${br.right - hr.left - this.host.clientLeft - el.offsetWidth}px`;
    const h = Math.min(H, Math.max(34, size * H));
    this.thumb.style.height = `${h}px`;
    if (!this.drag) this.thumb.style.transform = `translateY(${clamp(pos, 0, 1) * (H - h)}px)`;
  }
}

// a field of the line being edited that has the focus, as the rows around it are drawn anew (a reply that came back,
// the list scrolled): given the focus back after, the caret where it was, so typing goes on into it
function keepTyping(box) {
  const el = document.activeElement, f = el?.dataset?.f;
  if (!f || !box.contains(el)) return null;
  const a = el.selectionStart, b = el.selectionEnd;
  return () => {
    const n = box.querySelector(`[data-f="${f}"]`);
    if (!n) return;   // the line was drawn away
    n.focus({ preventScroll: true });
    try { n.setSelectionRange(a, b); } catch {}
  };
}

// ---------------------------------------------------------------- a pane: a virtual list of rows on the clock
class Pane {
  constructor(name, { est, row, noun, align = "top", where = 0.3, desc = false }) {
    this.name = name;
    this.el = document.querySelector(`.pane[data-pane="${name}"]`);
    this.list = this.el.querySelector(".list");
    this.spacer = this.el.querySelector(".spacer");
    this.backBtn = this.el.querySelector(".back");
    Object.assign(this, { est, rowFn: row, noun, align, where, desc });   // desc: newest first, as the live room's super chats
    this.view = []; this.heights = new Float64Array(0); this.prefix = new Float64Array(1);
    this.width = 0; this.lo = 0; this.hi = -1;         // the rows in the DOM
    this.cur = -1; this.kept = -1; this.anchor = null;  // the current row; where it is kept (px from the top), when the user put it there
    this.filtered = false; this.detached = false;       // a search or a viewer narrows it; the user scrolled it away
    this.touched = -Infinity; this.pressed = false; this.raf = 0; this.busy = false;
    this.backBtn.innerHTML = `<svg><use href="#i-down"/></svg><span>回到当前</span>`;
    this.glide = document.createElement("i");   // the highlight, one block behind the rows that glides to the current one
    this.glide.className = "glide";
    this.list.prepend(this.glide);
    this.glideAt = -1; this.smoothY = null; this.smoothRaf = 0; this.smoothLast = 0;
    this.wire();
    this.bar = new Bar(this.list, this.el, this.barModel(), () => { this.touched = performance.now(); });
  }

  wire() {
    const L = this.list;
    const touch = () => { this.touched = performance.now(); };
    for (const ev of ["wheel", "touchmove", "keydown"]) L.addEventListener(ev, touch, { passive: true });
    L.addEventListener("pointerdown", e => { this.pressed = true; if (e.target === L) touch(); });
    L.addEventListener("scroll", () => {
      if (performance.now() - this.touched < 900) this.detached = true;
      if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); this.showBack(); this.bar.update(); });
    }, { passive: true });
    L.addEventListener("click", e => onRowClick(this, e));
    this.backBtn.addEventListener("click", () => this.reveal(nowT()));
    new ResizeObserver(() => this.resized()).observe(L);
  }

  setView(view, filtered) {
    this.view = view; this.filtered = filtered;
    this.heights = Float64Array.from(view, x => x.h || this.est(x));
    this.prefix = new Float64Array(view.length + 1);
    this.fix(0);
    this.lo = 0; this.hi = -1; this.cur = -1; this.kept = -1;
    this.spacer.innerHTML = "";
    this.stopSmooth();
    this.placeGlide(false);
    // a new view fades in
    this.spacer.classList.add("fade");
    requestAnimationFrame(() => requestAnimationFrame(() => this.spacer.classList.remove("fade")));
  }
  fix(from) {   // running tops from row `from` on
    const n = this.view.length, Pf = this.prefix, H = this.heights;
    for (let i = from; i < n; i++) Pf[i + 1] = Pf[i] + H[i];
    this.spacer.style.height = Pf[n] + "px";
  }
  rowAtY(y) {   // the row covering y
    let lo = 0, hi = this.view.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.prefix[m] <= y) lo = m; else hi = m - 1; }
    return lo;
  }
  indexAt(t) {  // the latest row at or before t, -1 before the first
    let lo = 0, hi = this.view.length - 1, ans = -1;
    if (this.desc) {   // newest first: the first row at or before t
      while (lo <= hi) { const m = (lo + hi) >> 1; if (this.view[m].t <= t) { ans = m; hi = m - 1; } else lo = m + 1; }
      return ans;
    }
    while (lo <= hi) { const m = (lo + hi) >> 1; if (this.view[m].t <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  }

  render() {
    const L = this.list, n = this.view.length;
    if (this.busy || !L.clientHeight) return;
    if (!n) {
      if (this.hi !== -2) {
        this.spacer.style.height = "0px";
        this.spacer.innerHTML = `<div class="none"><img src="assets/camellia.webp" alt="">${this.emptyText()}</div>`;
        this.lo = 0; this.hi = -2;
      }
      return;
    }
    this.busy = true;
    for (let pass = 0; pass < 4; pass++) {
      const top = L.scrollTop, a = this.rowAtY(top), b = this.rowAtY(top + L.clientHeight);
      if (a >= this.lo && b <= this.hi) break;   // already in the DOM
      const lo = Math.max(0, a - 8), hi = Math.min(n - 1, b + 14);
      let html = "";
      for (let i = lo; i <= hi; i++) html += this.rowFn(this.view[i], i, this);
      const refocus = keepTyping(this.spacer);
      this.spacer.innerHTML = html;
      this.drawn?.(this.spacer);   // rows that size themselves once in place (a line being edited)
      refocus?.();
      this.lo = lo; this.hi = hi;
      // measure; the row at the top of the view stays where it was while guesses turn into heights
      const off = top - this.prefix[a];
      let first = -1;
      for (const el of this.spacer.children) {
        const i = +el.dataset.v, h = el.offsetHeight;
        if (Math.abs(h - this.heights[i]) > 0.5) {
          this.heights[i] = h; this.view[i].h = h;
          if (first < 0) first = i;
        }
      }
      if (first < 0) break;
      this.fix(first);
      L.scrollTop = this.prefix[a] + off;
      for (const el of this.spacer.children) el.style.top = this.prefix[+el.dataset.v] + "px";
      this.placeGlide(false);   // rows moved: the highlight with them, at once
      // the next pass checks the rows still cover the view (they may have shrunk)
    }
    this.busy = false;
    this.bar?.update();
  }

  remeasure() {   // rows in the DOM changed height in place (a line being edited grows as it is typed): their tops again
    let first = -1;
    for (const el of this.spacer.children) {
      const i = +el.dataset.v, h = el.offsetHeight;
      if (i >= 0 && Math.abs(h - this.heights[i]) > 0.5) { this.heights[i] = h; this.view[i].h = h; if (first < 0) first = i; }
    }
    if (first < 0) return;
    this.fix(first);
    for (const el of this.spacer.children) if (el.dataset.v) el.style.top = this.prefix[+el.dataset.v] + "px";
    this.placeGlide(false);
  }

  // the scroll bar's measure: rows, not pixels (heights are guesses until rows are drawn, and a guess made
  // good must not move the bar); the very top and bottom exact
  barModel() {
    const fit = () => {
      const n = this.view.length, h = this.list.clientHeight, total = this.prefix[n];
      return { n, h, total, max: Math.max(0, total - h), shown: clamp(h / (total / n || 1), 1, n) };
    };
    return {
      get: () => {
        const { n, total, max, shown } = fit(), st = this.list.scrollTop;
        if (!n || total <= this.list.clientHeight) return { pos: 0, size: 1 };
        let pos = 1;
        if (st <= 0) pos = 0;
        else if (st < max - 1) {
          const a = this.rowAtY(st), f = this.heights[a] ? (st - this.prefix[a]) / this.heights[a] : 0;
          pos = clamp((a + f) / Math.max(1e-6, n - shown), 0, 1);
        }
        return { pos, size: shown / n };
      },
      set: pos => {
        const { n, max, shown } = fit(), L = this.list;
        if (!n) return;
        if (pos <= 0) L.scrollTop = 0;
        else if (pos >= 1) L.scrollTop = max;
        else {
          const r = pos * (n - shown), a = Math.min(n - 1, Math.floor(r));
          L.scrollTop = Math.min(max, this.prefix[a] + (r - a) * this.heights[a]);
        }
        this.render();
      },
    };
  }

  emptyText() {
    const noun = /^[A-Za-z]/.test(this.noun) ? ` ${this.noun}` : this.noun;
    if (S.q) return `没有找到含「${esc(S.q)}」的${noun}`;
    if (this === P.subs && S.mention) return "这一P的字幕里没有念到 TA";
    if (this === P.chat && !Object.values(S.show).some(Boolean)) return "上面的弹幕、上舰、礼物都关掉了";
    if (S.who != null && this !== P.subs) return `TA 在这一P没有${noun}`;
    return `这一P没有${noun}`;
  }
  // where the current row sits by default: a third down for the subtitles, at the bottom for the chat and the super chats
  defTop(i) {
    const h = this.list.clientHeight;
    return this.align === "bottom" ? h - 10 - this.heights[i] : Math.round(h * this.where);
  }
  scrollFor(i) {
    const max = Math.max(0, this.prefix[this.view.length] - this.list.clientHeight);
    if (i < 0) return this.desc ? max : 0;   // before the first: newest first, the first is at the bottom
    return clamp(this.prefix[i] - (this.anchor ?? this.defTop(i)), 0, max);
  }
  reveal(t, anchor = null) {
    this.anchor = anchor; this.kept = -1; this.detached = false;
    this.touched = -Infinity;   // the scrolling it does next is not the reader's
    this.stopSmooth();
    const L = this.list;
    if (!L.clientHeight) return;
    const i = this.at(t);
    for (let k = 0; k < 3; k++) {   // estimated heights become measured ones on the way: place it again
      const y = this.scrollFor(i);
      if (k && Math.abs(L.scrollTop - y) < 1) break;
      L.scrollTop = y;
      this.render();
    }
    this.mark(t, true);
    this.showBack();
  }
  // the current row at time t: the latest at or before it (newest first: the first) — in a narrowed pane too, so a
  // viewer's lines or a search's hits keep up with the video; among rows at the same time, the one clicked stays
  at(t) {
    const i = this.indexAt(t), c = this.cur;
    return i >= 0 && c >= 0 && c < this.view.length && this.view[c].t === this.view[i].t ? c : i;
  }
  mark(t, force = false) {
    const i = this.at(t);
    if (i !== this.cur) { this.cur = i; force = true; }
    if (force) {
      for (const el of this.spacer.children) el.classList.toggle("cur", +el.dataset.v === this.cur);
      this.placeGlide(true);
    }
  }
  // the highlight under the current row: gliding there from a row or three away, put there at once otherwise
  placeGlide(animate) {
    const g = this.glide, i = this.cur;
    if (i < 0 || i >= this.view.length) {
      g.style.opacity = "0"; this.glideAt = -1;
      return;
    }
    const y = this.prefix[i], h = this.heights[i];
    if (!animate && i === this.glideAt && y === this.glideY && h === this.glideH) return;
    const glide = animate && this.glideAt >= 0 && Math.abs(i - this.glideAt) <= 3;
    if (!glide) g.style.transition = "none";
    g.style.transform = `translateY(${y}px)`;
    g.style.height = `${h}px`;
    g.style.opacity = "1";
    if (!glide) { void g.offsetHeight; g.style.transition = ""; }
    Object.assign(this, { glideAt: i, glideY: y, glideH: h });
  }
  // following scrolls there smoothly (eased, a tenth of a second or so); a jump of more than a screen is made at once
  smoothTo(y) {
    const L = this.list;
    if (Math.abs(L.scrollTop - y) > L.clientHeight * 1.5) { this.stopSmooth(); L.scrollTop = y; this.render(); return; }
    this.smoothY = y;
    if (!this.smoothRaf) { this.smoothLast = performance.now(); this.smoothRaf = requestAnimationFrame(now => this.smoothStep(now)); }
  }
  smoothStep(now) {
    this.smoothRaf = 0;
    const L = this.list, d = this.smoothY - L.scrollTop;
    if (this.smoothY == null || this.pressed || this.detached) { this.smoothY = null; return; }
    if (Math.abs(d) < 1) { L.scrollTop = this.smoothY; this.smoothY = null; this.render(); return; }
    const k = 1 - Math.exp(-(now - this.smoothLast) / 90);   // the same pace at any frame rate
    this.smoothLast = now;
    const step = d * k;
    L.scrollTop += Math.abs(step) < 1 ? Math.sign(d) : step;   // the last pixels: one at a time, so it arrives
    this.render();
    this.smoothRaf = requestAnimationFrame(t => this.smoothStep(t));
  }
  stopSmooth() {
    if (this.smoothRaf) cancelAnimationFrame(this.smoothRaf);
    this.smoothRaf = 0; this.smoothY = null;
  }
  // following playback: the current row stays where it was put, drifting to its usual place as rows go by
  keep() {
    if (this.cur < 0 || this.pressed || !this.list.clientHeight) return;
    if (this.anchor != null && this.cur !== this.kept) {
      const def = this.defTop(this.cur);
      this.anchor += (def - this.anchor) * 0.34;
      if (Math.abs(def - this.anchor) < 6) this.anchor = null;
    }
    this.kept = this.cur;
    const y = this.scrollFor(this.cur);
    if (Math.abs((this.smoothY ?? this.list.scrollTop) - y) > 1) this.smoothTo(y);
  }
  showBack() {
    const L = this.list, b = this.backBtn;
    let show = false, up = false;
    // while it follows playback the pane catches up by itself (in a burst of chat the current row runs ahead of
    // the eased scroll for a moment): the button only once it was scrolled by hand, or when nothing moves it
    const following = S.play && S.follow && !this.detached;
    if (!following && this.cur >= 0 && L.clientHeight) {
      const st = L.scrollTop;
      up = this.prefix[this.cur + 1] < st + 4;
      show = up || this.prefix[this.cur] > st + L.clientHeight - 4;
    }
    if (b.hidden === show) b.hidden = !show;
    if (show && b.classList.contains("up") !== up) b.classList.toggle("up", up);
  }
  resized() {
    const L = this.list, w = L.clientWidth;
    if (!L.clientHeight) return;
    if (Math.abs(w - this.width) > 2) {   // rows wrap differently: measure again, keeping the top row in place
      this.width = w;
      if (this.view.length) {
        const a = this.rowAtY(L.scrollTop);
        for (const x of S.items?.[this.name] ?? []) x.h = 0;
        this.heights = Float64Array.from(this.view, x => this.est(x));
        this.fix(0);
        this.lo = 0; this.hi = -1;
        L.scrollTop = this.prefix[a];
      }
    }
    this.render();
    this.showBack();
    this.bar.update();
  }
}

// ---------------------------------------------------------------- rows
const H = { reQ: null, reSub: null };   // what to highlight: the search; in the subtitles also the chosen viewer's name
function buildHL() {
  const lit = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const w = S.who != null && S.whoF.length >= 2 ? S.d.names[S.who] : "";
  H.reQ = S.q ? new RegExp(`(${lit(S.q)})`, "gi") : null;
  H.reSub = w ? new RegExp(S.q ? `(${lit(S.q)})|${lit(w)}` : lit(w), "gi") : H.reQ;
}
function hl(text, sub = false) {
  text = String(text ?? "");
  const re = sub ? H.reSub : H.reQ;
  if (!re) return esc(text);
  let out = "", last = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; continue; }
    out += esc(text.slice(last, m.index)) + `<mark${m[1] === undefined ? ' class="w"' : ""}>${esc(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

const actsHTML = (p, draft = false) => `<div class="acts">${p.filtered ? `<button type="button" data-act="ctx" title="清掉筛选，在完整时间线里看前后"><svg><use href="#i-ctx"/></svg></button>` : ""}`
  + (p === P.subs ? `<button type="button" data-act="fix" title="${draft ? "接着改" : "在这里改这一句"}"><svg><use href="#i-pen"/></svg></button>` : "")
  + (draft ? `<button type="button" data-act="undo" title="撤销这处修改"><svg><use href="#i-x"/></svg></button>` : "")
  + `<button type="button" data-act="link" title="复制这一刻的链接"><svg><use href="#i-link"/></svg></button></div>`;
const rowOpen = (cls, i, p) => `<div class="row ${cls}${i === p.cur ? " cur" : ""}" data-v="${i}" style="top:${p.prefix[i]}px">`;

function nameHTML(n) {
  const nm = S.d.names[n];
  return `<span class="uname" data-n="${n}" title="只看 ${esc(nm)}">${hl(nm)}</span>`;
}

// a viewer's picture, a cell of the part's sheet (build_site.py), or without one their initial on their colour
function avHTML(n, px) {
  const a = S.d.avs, i = a ? S.d.av[n] : -1, size = `width:${px}px;height:${px}px`;
  if (i >= 0) return `<i class="av" style="${size};background-size:${a.cols * px}px auto;`
                   + `background-position:-${(i % a.cols) * px}px -${Math.floor(i / a.cols) * px}px"></i>`;
  const nm = S.d.names[n];
  return `<i class="av init" style="${size};line-height:${px}px;font-size:${Math.round(px * 0.5)}px;background-color:${tint(nm)}">${esc(sealOf(nm))}</i>`;
}

// a subtitle line; being edited, the editor in its place; with the reader's own edit waiting to be sent (待提交) or
// under review (审核中), the line as it is and as it would be; their reviewed one, how it went; one readers fixed, a
// dot under its time
const DONE_TAG = { approved: ["已通过", "ok"], rejected: ["未采纳", "no"], reverted: ["已撤下", "off"] };
// a day as the gold mark shows it: 11/19 (long: 11月19日); another year with it
const dayOf = (s, long = false) => {
  const d = new Date(s * 1000), y = d.getFullYear() !== new Date().getFullYear() ? (long ? `${d.getFullYear()}年` : `${String(d.getFullYear()).slice(2)}/`) : "";
  return long ? `${y}${d.getMonth() + 1}月${d.getDate()}日` : `${y}${d.getMonth() + 1}/${d.getDate()}`;
};
function subRow(x, i, p) {
  const r = S.d.subs[x.i];
  if (ED && ED.part === S.part && ED.i === x.i) return rowOpen("sub editing", i, p) + `<div class="t">${hms(r[0])}</div>${editorHTML()}<div class="acts"></div></div>`;
  const key = lineKey(S.part, t10(r[0])), rv = RV.on && RV.byLine.get(key);   // reviewing: the waiting suggestions for it
  const dr = DR.map.get(key), sent = !dr && !RV.on && DR.sent.get(key), ch = dr || sent, by = S.d.fixBy?.get(x.i);
  const done = !dr && !sent && !RV.on && DR.mine.get(key);   // the reader's own suggestion for it, reviewed: how it went
  const cur = rv && RV.at && RV.at.part === S.part && RV.at.t === t10(r[0]);   // reviewing: the line gone to (the keys act on it)
  // the tag under the time (a click opens the line's card): the reader's draft, waiting, or reviewed suggestion; else,
  // when someone's fix is live on it, a quiet gold mark with the day it last changed
  const at = by && S.d.fixAt?.get(x.i);
  const tag = (rv ? `<span class="dtag rv">待审核${rv.length > 1 ? ` ${rv.length}` : ""}</span>` : "")
            + (dr ? `<span class="dtag" data-pop="draft">待提交</span>` : sent ? `<span class="dtag sent" data-pop="sent">审核中</span>`
               : done ? `<span class="dtag ${DONE_TAG[done.status][1]}" data-pop="done">${DONE_TAG[done.status][0]}${isNew(done) ? '<i class="dnew"></i>' : ""}</span>`
               : by ? `<span class="fixed" data-pop="fixed" data-by="${esc(by)}" title="观众校对过（${esc(by)}）${at ? `，${dayOf(at, true)}` : ""}，点一下看修改记录">${at ? dayOf(at) : "已校对"}</span>` : "");
  const body = (ch ? changeHTML(r[2], ch.ja, "ja") + changeHTML(r[3], ch.zh, "zh")
                   : `<div class="ja" lang="ja">${hl(r[2], true)}</div><div class="zh">${hl(r[3], true)}</div>`)
             + (rv ? rv.map((s, j) => suggestionHTML(s, r, cur && j === 0)).join("") : "");
  return rowOpen(`sub${dr ? " draft" : sent ? " sent" : ""}${rv ? " rv" : ""}${cur ? " rvcur" : ""}`, i, p)
    + `<div class="t">${hms(r[0])}${tag}</div><div class="body">${body}</div>${actsHTML(p, !!dr)}</div>`;
}

function chatRow(x, i, p) {
  const d = S.d;
  let body;
  if (x.k === "chat") {
    const r = d.chat[x.i];
    body = `${avHTML(r[1], 22)}${nameHTML(r[1])}<span class="txt">${hl(r[2])}</span>`;
  } else if (x.k === "guard") {
    const r = d.guard[x.i];
    body = `${avHTML(r[1], 22)}<span class="badge l${r[2]}">上舰</span>${nameHTML(r[1])}<span class="what">开通了${GUARD_NAME[r[2]] || "舰长"}</span>`;
  } else {
    const r = d.gift[x.i];
    body = `${avHTML(r[1], 22)}<span class="badge">礼物</span>${nameHTML(r[1])}<span class="what">送出 ${hl(r[2])} ×${r[3]}</span>${r[4] ? `<span class="yuan">¥${r[4]}</span>` : ""}`;
  }
  return rowOpen(x.k, i, p) + `<div class="t">${hms(x.t)}</div><div class="ln1">${body}</div>${actsHTML(p)}</div>`;
}

function scRow(x, i, p) {
  const r = S.d.sc[x.i], nm = S.d.names[r[1]];
  const tier = clamp(r[3] | 0, 0, 6), [seal, amt] = TIERS[tier];
  const text = r[4], zh = r[5] && r[5] !== r[4] ? r[5] : "";
  // the sender's picture inside a ring of the tier colour, as in the live room; else their initial on it
  const photo = S.d.avs && S.d.av[r[1]] >= 0;
  return rowOpen("sc", i, p) + `<div class="tag" style="--seal:${seal};--amt:${amt}"><div class="stripe s${tier}"></div><div class="paper"><i class="mark m${tier}"></i>`
       + `<div class="hd"><div class="seal${photo ? " photo" : ""}">${photo ? avHTML(r[1], 28) : esc(sealOf(nm))}</div><div class="from"><div class="nm" data-n="${r[1]}" title="只看 ${esc(nm)}">${hl(nm)}</div>`
       + `<div class="amt">${esc(r[2])}</div></div><span class="tm">${hms(r[0])}</span></div>`
       + (zh || text ? `<div class="msg">${hl(zh || text)}</div>` : "")
       + (zh && text ? `<div class="orig" lang="ja">${hl(text)}</div>` : "")
       + `</div></div>${actsHTML(p)}</div>`;
}

// ---------------------------------------------------------------- data and filters
async function loadJSON(url) {   // asking the server each time: a rebuilt data file shows at once (an unchanged one: a 304)
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

function buildItems(d) {
  const subs = d.subs.map((r, i) => ({ i, t: r[0], h: 0 }));
  const chat = [];
  d.chat.forEach((r, i) => chat.push({ k: "chat", i, t: r[0], n: r[1], h: 0 }));
  d.guard.forEach((r, i) => chat.push({ k: "guard", i, t: r[0], n: r[1], h: 0 }));
  d.gift.forEach((r, i) => chat.push({ k: "gift", i, t: r[0], n: r[1], h: 0 }));
  chat.sort((a, b) => a.t - b.t || ORDER[a.k] - ORDER[b.k] || a.i - b.i);
  const sc = d.sc.map((r, i) => ({ i, t: r[0], n: r[1], h: 0 }));
  return { subs, chat, sc };
}

function textOf(pane, x) {   // a row's folded search text, made when first searched
  if (x.f === undefined) {
    const d = S.d;
    x.f = fold(pane === "subs" ? `${d.subs[x.i][2]}\n${d.subs[x.i][3]}`
             : pane === "sc" ? `${d.names[x.n]}\n${d.sc[x.i][4]}\n${d.sc[x.i][5]}`
             : x.k === "chat" ? `${d.names[x.n]}\n${d.chat[x.i][2]}`
             : x.k === "gift" ? `${d.names[x.n]}\n${d.gift[x.i][2]}` : d.names[x.n]);
  }
  return x.f;
}

// what each pane shows: the search in all three; the chosen viewer in the chat and the super chats (and in the
// subtitles, the lines naming them, when asked); the chat's kinds. Narrowed or not, every pane then goes to the
// current time, its latest row at or before it the current one.
function applyFilters() {
  const I = S.items, q = S.qf, who = S.who;
  buildHL();
  const onlyW = who != null && S.mention && S.whoF.length >= 2;
  const subs = I.subs.filter(x => (!q || textOf("subs", x).includes(q)) && (!onlyW || textOf("subs", x).includes(S.whoF)));
  const counts = { chat: 0, guard: 0, gift: 0 };
  const chat = [];
  for (const x of I.chat) {
    if (who != null && x.n !== who) continue;
    if (q && !textOf("chat", x).includes(q)) continue;
    counts[x.k]++;
    if (S.show[x.k]) chat.push(x);
  }
  const sc = I.sc.filter(x => (who == null || x.n === who) && (!q || textOf("sc", x).includes(q))).reverse();   // newest first
  P.subs.setView(subs, !!q || onlyW);
  P.chat.setView(chat, !!q || who != null);
  P.sc.setView(sc, !!q || who != null);

  const label = (p, unit) => {
    const em = $(`count${p === P.subs ? "Subs" : p === P.chat ? "Chat" : "SC"}`);
    em.textContent = (p.filtered ? "找到 " : "") + `${num(p.view.length)} ${unit}`;
    em.classList.toggle("found", p.filtered);
  };
  label(P.subs, "句"); label(P.chat, "条"); label(P.sc, "条");
  $("tabSubs").textContent = num(subs.length); $("tabChat").textContent = num(chat.length); $("tabSC").textContent = num(sc.length);
  for (const b of $("chips").children) {
    b.classList.toggle("on", S.show[b.dataset.kind]);
    b.querySelector("i").textContent = num(counts[b.dataset.kind]);
  }
  const m = $("mention");
  m.hidden = !(who != null && S.mentions);
  m.classList.toggle("on", onlyW);
  m.querySelector("i").textContent = num(S.mentions);
  m.parentElement.classList.toggle("has-mention", !m.hidden);

  const t = nowT();
  for (const p of PANES) p.reveal(t);
  tlDraw();   // the hits on the timeline
}

function setWhoState(n) {
  S.who = n;
  S.whoF = n == null ? "" : fold(S.d.names[n]);
  S.mention = false;
  S.mentions = S.whoF.length >= 2 ? S.items.subs.reduce((c, x) => c + textOf("subs", x).includes(S.whoF), 0) : 0;
  $("who").value = n == null ? "" : S.d.names[n];
  $("whoBox").classList.toggle("set", n != null);
  $("whoClear").hidden = n == null;
  $("suggest").hidden = true;
}
function setWho(n) {
  setWhoState(n);
  applyFilters();
  if (n != null && S.mobile && S.tab === "subs") { setTab("chat"); P.chat.reveal(nowT()); }   // on a phone, show where the viewer's lines are
}

function setQuery(v) {
  v = v.trim();
  if (v === S.q) return;
  S.q = v; S.qf = fold(v);
  applyFilters();
}

// ---------------------------------------------------------------- parts
async function loadPart(part, at = null) {
  const whoName = S.who != null ? S.d.names[S.who] : null;
  if (ED && ED.part !== part && !leaveEditor()) closeEditor(false);   // a line of the part left being edited: kept as a draft
  hidePop();
  S.part = part;
  renderTabs();
  const L = $("layout");
  L.classList.add("busy");
  let d;
  const fixes = fetchFixes(part);   // readers' approved fixes, alongside the data (small: nearly always there first)
  try {
    d = S.cache[part] || (S.cache[part] = await loadJSON(`data/p${part}.json`));
  } catch (e) {
    L.classList.remove("busy");
    toast("数据载入失败：" + e.message);
    return;
  }
  if (part !== S.part) return;   // another part was chosen meanwhile
  const fx = await Promise.race([fixes, new Promise(r => setTimeout(r, 1500))]);
  if (part !== S.part) return;
  applyFixes(d, fx);
  if (fx === undefined) fixes.then(late => {   // slower than the data: laid over it once here, the panes left where they are
    if (!late || S.d !== d) return;
    applyFixes(d, late);
    for (const x of S.items.subs) x.f = undefined;   // the search's folded text
    if (S.q || S.mention) applyFilters();            // a search may find other lines now
    else { P.subs.lo = 0; P.subs.hi = -1; P.subs.render(); }
  });
  S.d = d;
  S.items = buildItems(d);
  document.documentElement.style.setProperty("--sheet", d.avs ? `url("${d.avs.sheet}")` : "none");
  S.activity = new Uint32Array(d.names.length);
  for (const k of ["chat", "sc", "guard", "gift"]) for (const r of d[k]) S.activity[r[1]]++;
  const n = whoName == null ? -1 : d.names.indexOf(whoName);   // the viewer chosen carries over, when they were there
  setWhoState(n >= 0 && S.activity[n] ? n : null);
  S.play = null; S.lost = null;
  const okStream = await vidSetup(part);   // try B站's stream in our own <video>; the embed is the fallback
  if (part !== S.part) return;
  standAt(at ?? 0);
  S.nudge = nudgeOf(part);
  L.classList.remove("busy");
  $("tlLen").textContent = hms(d.length);
  $("tlTrack").setAttribute("aria-valuemax", String(Math.floor(d.length)));
  applyFilters();
  if (S.stream) vidStand(); else setPlayer(S.cur, false);
  showSync();
  tick(true);
  if (RV.on) updateReviewBar();   // this part's count
}

function renderTabs() {
  $("parts").innerHTML = S.meta.parts.map(p => {
    const [date, ...rest] = p.label.split(" ");   // "10/12 生日会！！！ 上": a phone shows the date only
    return `<button class="part${p.part === S.part ? " on" : ""}" data-part="${p.part}" type="button" title="${esc(p.title)}"><span class="p">P${p.part}</span>`
         + `<span class="l"><b>${esc(date)}</b><span class="lt">${esc(rest.join(" "))}</span></span><span class="d">${hms(p.length)}</span></button>`;
  }).join("");
  const box = $("parts"), on = box.querySelector(".on");   // the chosen part in view, where the tabs scroll
  const x = on.offsetLeft - box.offsetLeft;
  if (x < box.scrollLeft || x + on.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = x - 8;
}

// ---------------------------------------------------------------- player and clock
// On a phone, player.html sends itself on to www.bilibili.com's mobile player (mbplayer.html), with the same
// query. That one takes a flag only as "true" (autoplay=1 is "no") and closes the danmaku by danmakuClosed;
// player.html takes true/false as well. So the iframe's allow names both origins (autoplay would not carry
// over to the second), and allowfullscreen covers any.
function setPlayer(t, autoplay) {
  if (autoplay) S.srcAt = performance.now();   // start of this load, to measure its DOM-load time for the estimate
  $("player").src = `https://player.bilibili.com/player.html?isOutside=true&bvid=${S.meta.bvid}&p=${S.part}&t=${Math.floor(t)}`
                  + `&autoplay=${autoplay}&danmaku=false&danmakuClosed=true&noPosterClip=true&high_quality=1`;
  $("screen").classList.toggle("idle", !autoplay);   // loaded standing: it shows its own play button and "进入哔哩哔哩"
}
// ---------------------------------------------------------------- the stream backend (frame-perfect)
// B站's own video plays in our own <video> through MSE (stream.js): the page reads its position every frame and
// seeks it exactly, so the three panes are truly in step. The bytes come from a Cloudflare Worker, fed fresh URLs
// every ~30 min by a GitHub Action (minting from Cloudflare's IP is banned, serving the bytes is not). On any
// failure it falls back to the embed (the estimate). STREAM is the S.play sentinel while the <video> plays.
const STREAM = { stream: true };
async function vidSetup(part) {
  S.stream = false;
  $("screen").classList.remove("stream");
  if (!window.BiliStream || !("MediaSource" in window)) return false;
  try {
    const mf = await BiliStream.fetchManifest(part);
    if (part !== S.part) return false;
    if (!VP.player) VP.player = new BiliStream.Player($("vid"));
    const info = await VP.player.load(mf);
    if (!info || part !== S.part) return false;
    S.stream = true;
    $("screen").classList.add("stream");
    return true;
  } catch { return false; }
}
function vidStand() { if (VP.player) { VP.player.pause(); VP.player.seek(S.cur); } }   // show the frame, not playing
// The embedded player reports nothing and takes no orders (no messages either way; B站 opens its player bridge
// to its own sites only), so the page drives it the one way it allows, by loading it at a second with or
// without autoplay, and keeps its own clock: running once the player has loaded and started. Every play, pause
// and jump made here is one such load, so the page always knows where the video is. A click inside the player
// itself (pause, seek, speed, volume: the page cannot tell which) stops the lists until the reader resumes from
// here; going fullscreen does not.
function playFrom(t, src = null, lead = 2) {
  const start = clamp(t - lead, 0, S.d.length);
  if (S.stream) {
    S.play = STREAM; S.cur = start; S.hold = t > start ? t : null; S.lost = null;
    VP.player.seek(start); VP.player.play().catch(() => {});   // the seek is exact; no start-up to guess
  } else {
    const s = Math.floor(start);
    setPlayer(s, true);
    S.play = { t0: s + START_SKEW, at: Infinity, sent: performance.now() };
    S.cur = S.play.t0; S.hold = t; S.lost = null; S.touch = null;
  }
  writeHash(t);
  for (const p of PANES) if (p !== src) p.reveal(t);
  showSync();
  tick(true);
}
function pauseAt(t) {
  if (S.stream) {
    t = clamp(t, 0, S.d.length);
    VP.player.pause(); VP.player.seek(t);
    S.play = null; S.hold = null; S.lost = null; S.cur = t;
  } else {   // the embed loaded again, standing at that whole second
    t = Math.floor(clamp(t, 0, S.d.length));
    setPlayer(t, false);
    S.play = null; S.hold = null; S.lost = null; S.touch = null; S.cur = t;
  }
  writeHash(t);
  showSync();
  tick(true);
}
// standing at a time (a link, a search result in its place): the player two seconds before it, as a click on its
// row would start it, the page's clock and timeline where the player is, the rows at the time itself
function standAt(t) {
  S.cur = t > 0 ? Math.max(0, Math.floor(t - 2)) : 0;
  S.hold = t > S.cur ? t : null;
}
function togglePlay() {
  if (!S.d) return;
  if (S.stream) {
    if (VP.player.paused) playFrom(nowT(), null, 0); else pauseAt(VP.player.currentTime);
    return;
  }
  if (S.play) { pauseAt(nowT()); return; }
  const t = S.lost ? S.lost.t : nowT();
  playFrom(t, null, S.lost ? 0 : t - S.cur);   // from where the player stands
}
function seekBy(d) {
  if (!S.d) return;
  const t = clamp(nowT() + d, 0, S.d.length);
  if (S.play) playFrom(t, null, 0);
  else { pauseAt(t); for (const p of PANES) p.reveal(t); }
}
const clockAt = (play, now) => play.t0 + Math.max(0, now - play.at) / 1000;
function playerLoaded() {   // the iframe's DOM is ready; predict how much longer until the video actually starts
  if (S.play && S.play.at === Infinity) {
    const domLoad = S.srcAt ? performance.now() - S.srcAt : 600;
    S.play.at = performance.now() + predictDelay(domLoad) - S.nudge * 1000;
  }
}
const fmtNudge = v => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(Math.round(v * 100) % 10 ? 2 : 1)}s`;
// this part's correction set to v, now and from now on: the running clock moves with it
function setNudge(v) {
  const was = S.nudge;
  S.nudge = clamp(Math.round(v * 20) / 20, -3, 3);
  try { localStorage.setItem(NUDGE_KEY(S.part), String(S.nudge)); } catch { /* kept for this visit only */ }
  if (S.play && S.play.at !== Infinity) S.play.at -= (S.nudge - was) * 1000;
}
function nudge(dir) {   // the lists a tenth of a second earlier (+) or later (-)
  setNudge(S.nudge + dir * 0.1);
  toast(`本P列表${S.nudge > 0 ? `提前 ${S.nudge.toFixed(2)}` : S.nudge < 0 ? `延后 ${(-S.nudge).toFixed(2)}` : "不偏移"}${S.nudge ? " 秒" : ""}`);
  showSync();
  tick(true);
}
function playerTouched(at) {
  const was = S.play;
  S.lost = { t: clamp(!was ? S.cur : was.at === Infinity ? was.t0 : clockAt(was, at), 0, S.d.length), playing: !!was };
  S.play = null; S.hold = null; S.cur = S.lost.t;
  $("screen").classList.remove("idle");   // what it shows now is its own business
  showSync();
}
// playback speed, only in stream mode (our own <video> can do it; the embed can't be asked to)
const RATES = [1, 1.25, 1.5, 2];
const fmtRate = r => (r === 1 ? "倍速" : `${r}×`);
function cycleRate() {
  if (!S.stream || !VP.player) return;
  const r = RATES[(RATES.indexOf(VP.player.rate) + 1) % RATES.length];
  VP.player.rate = r;
  showSync();
  toast(r === 1 ? "正常速度" : `${r} 倍速`);
}
function showSync() {
  const el = $("sync"), b = $("tPlay"), playing = !!S.play, icon = `<svg><use href="#i-${playing ? "pause" : "play"}"/></svg>`;
  b.innerHTML = icon;
  b.title = playing ? "暂停（空格）" : "播放（空格）";
  b.classList.toggle("on", playing);
  if (!$("cue").classList.contains("flash")) $("cue").innerHTML = icon;   // what a click on the picture will do
  el.className = "sync" + (S.lost ? " lost" : playing ? " on" : "");
  $("nudge").hidden = !playing || S.stream;   // the nudge is only for the embed's estimate
  $("nudgeV").textContent = fmtNudge(S.nudge);
  const sp = $("speed");
  sp.hidden = !S.stream;   // speed only when we drive the <video> ourselves
  if (S.stream) { sp.textContent = fmtRate(VP.player ? VP.player.rate : 1); sp.classList.toggle("on", VP.player && VP.player.rate !== 1); $("screen").classList.toggle("idle", !playing); }
  const resume = t => `<button type="button" class="btn" data-sync="here"><svg><use href="#i-play"/></svg>从 ${hms(t)} 继续播放</button>`;
  el.innerHTML = S.lost
    ? (S.lost.playing ? `<span class="msg">用了 B 站播放器自带的控制栏，网页不知道是暂停、拖动还是别的，列表先停在 <b>${hms(S.lost.t)}</b></span>`
                      : `<span class="msg">B 站播放器自带的控制栏网页跟不上；点画面或 <svg class="ico"><use href="#i-play"/></svg> 播放，三栏就会同步</span>`) + resume(S.lost.t)
    : playing ? `<span class="msg"><i class="live"></i>同步播放中 · 点画面暂停</span>`
    : `<span class="msg">点画面、<svg class="ico"><use href="#i-play"/></svg> 或任意一行开始播放，三栏一起跟随</span>`;
}

// The picture is covered by a clear layer that takes its clicks, so a click on the picture plays or pauses the
// way the page can follow. The embed's own bars (title and follow, like/share, "进入哔哩哔哩", progress and
// controls) are cut off above and below the box (style.css), so none of its buttons is left to dodge.
function placeHits() {
  const W = $("screen").clientWidth, H = $("screen").clientHeight;
  $("screen").classList.toggle("narrow", W < 420);
  Object.assign($("hitA").style, { left: "0px", top: "0px", width: `${W}px`, height: `${H}px` });
  $("hitA").hidden = false;
  $("hitB").hidden = true;
}
let hitTimer = 0, cueTimer = 0;
function hitClick(e) {
  if (e.detail > 1) return;   // the second click of a double click
  // Standing, the wide layout puts "进入哔哩哔哩，观看更高清" under the middle; it stays covered, so a click
  // anywhere on the picture always plays or pauses (the same spot twice: pause, then play). 「B站打开」 goes there.
  clearTimeout(hitTimer);
  hitTimer = setTimeout(() => {   // held back a moment: a double click means fullscreen instead
    const cue = $("cue");
    cue.innerHTML = `<svg><use href="#i-${S.play ? "pause" : "play"}"/></svg>`;
    cue.classList.add("flash");
    clearTimeout(cueTimer);
    cueTimer = setTimeout(() => { cue.classList.remove("flash"); showSync(); }, 650);
    togglePlay();
  }, 250);
}
function toggleFullscreen() {
  clearTimeout(hitTimer);
  const box = $("screen");
  if (document.fullscreenElement) document.exitFullscreen?.();
  else (box.requestFullscreen || box.webkitRequestFullscreen)?.call(box);
}
// a search result in its place: the filters off, every pane at that time, the player there (not playing)
function showContext(t) {
  $("q").value = ""; S.q = ""; S.qf = "";
  setWhoState(null);
  S.play = null; S.lost = null; standAt(t);
  if (S.stream) vidStand(); else setPlayer(S.cur, false);
  writeHash(t);
  applyFilters();
  showSync();
  tick(true);
}

function realAt(t) {   // the real time (Unix seconds) the stream was at, from the clock runs
  const runs = S.d.clock;
  if (!runs.length) return null;
  let lo = 0, hi = runs.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (runs[m][0] <= t) lo = m; else hi = m - 1; }
  return Math.floor(t) + runs[lo][1];
}
function guardsAt(t) {
  const st = S.d.guards;
  if (!st.length) return null;
  let lo = 0, hi = st.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (st[m][0] <= t) lo = m; else hi = m - 1; }
  return st[lo][1];
}
const beijing = unix => new Date((unix + 8 * 3600) * 1000);   // read with the UTC getters

function showClock(t) {
  const real = realAt(t);
  if (real != null) {
    const b = beijing(real);
    const clock = `${pad(b.getUTCHours())}:${pad(b.getUTCMinutes())}:${pad(b.getUTCSeconds())}`;
    $("nReal").textContent = `${b.getUTCMonth() + 1}/${b.getUTCDate()} ${clock}`;
    $("sClock").textContent = clock;
    $("sDate").innerHTML = `${b.getUTCFullYear()}.${pad(b.getUTCMonth() + 1)}.${pad(b.getUTCDate())}<small>(${"日月火水木金土"[b.getUTCDay()]})</small>`;
  }
  $("sGuards").textContent = guardsAt(t) ?? "—";
  $("openBili").href = `https://www.bilibili.com/video/${S.meta.bvid}?p=${S.part}&t=${Math.floor(t)}`;
}

let lastSec = -1;
function tick(force = false) {
  if (!S.d) return;
  const now = performance.now();
  if (S.stream) {
    if (VP.player) {   // the clock is the <video>'s own position, read every frame; buffering freezes it (lists hold)
      S.cur = clamp(VP.player.currentTime, 0, S.d.length);
      const playing = !VP.player.paused && !VP.player.ended;
      if (playing && S.play !== STREAM) { S.play = STREAM; showSync(); }
      else if (!playing && S.play === STREAM) { S.play = null; showSync(); }
    }
  } else {
    if (S.play) {
      if (S.play.at === Infinity && now - S.play.sent > 4000) S.play.at = S.play.sent + loadToPlay() + NO_LOAD_GUESS_EXTRA - S.nudge * 1000;   // no load event seen
      S.cur = Math.min(S.d.length, clockAt(S.play, now));
    }
    // the reader clicked into the embed: the page sees its frame take the focus, nothing more
    const focused = document.activeElement === $("player");
    if (focused && !S.playerFocused && S.touch == null) S.touch = now;
    S.playerFocused = focused;
    if (S.touch != null && now - S.touch > 600) {   // time for the fullscreen button to show itself
      const at = S.touch;
      S.touch = null;
      // its own fullscreen, and its links (they open a new tab, hiding this one), leave the video as it was
      if (!S.lost && document.fullscreenElement !== $("player") && !document.hidden) playerTouched(at);
    }
  }
  if (S.hold != null && S.cur >= S.hold) S.hold = null;
  const shown = TL.drag ? TL.drag.t : S.cur;   // while the timeline is dragged, the page shows where it is
  const sec = Math.floor(shown);
  if (force || sec !== lastSec) { lastSec = sec; showClock(shown); }
  const t = TL.drag ? TL.drag.t : nowT();
  tlShow(TL.drag ? TL.drag.t : S.cur);   // where the video is
  for (const p of PANES) {
    p.mark(t);
    if (S.play && S.follow && !TL.drag && !p.detached) p.keep();
    p.showBack();
  }
}

// ---------------------------------------------------------------- the timeline: the whole part, draggable
// Dragging moves the three panes with it (the video stays until the button is let go, then plays or stands
// there, as it did). Drawn on it: the chat's heat, the super chats in their tiers' colours, the moments the
// guard count passed each hundred, and, while searching or following one viewer, where the hits are.
const TL = { drag: null, heat: null, raf: 0 };
const tlTime = clientX => {
  const r = $("tlTrack").getBoundingClientRect();
  return clamp((clientX - r.left) / r.width, 0, 1) * S.d.length;
};
function tlShow(t) {   // the elapsed part, the head, the numbers
  const f = S.d.length ? clamp(t / S.d.length, 0, 1) : 0;
  $("tlFill").style.width = `${f * 100}%`;
  $("tlHead").style.left = `${f * 100}%`;
  $("tlNow").textContent = hms(t);
  const tr = $("tlTrack"), v = String(Math.floor(t));
  if (tr.getAttribute("aria-valuenow") !== v) { tr.setAttribute("aria-valuenow", v); tr.setAttribute("aria-valuetext", hms(t)); }
}
function tlDraw() {
  const tr = $("tlTrack"), cv = $("tlCanvas"), W = tr.clientWidth, H = tr.clientHeight, dpr = window.devicePixelRatio || 1;
  if (!S.d || !W || !H) return;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const L = S.d.length, X = t => Math.round(t / L * W), mid = Math.round(H / 2);
  // the chat's heat: messages per slice of the bar, a soft ridge over the rail (the busiest 2% at full height)
  const n = Math.max(1, Math.floor(W / 2)), key = `${S.part}:${n}`;
  if (!TL.heat || TL.heat.key !== key) {
    const bins = new Float32Array(n);
    for (const it of S.items.chat) if (it.k === "chat") bins[Math.min(n - 1, Math.floor(it.t / L * n))]++;
    const top = Float32Array.from(bins).sort()[Math.floor(n * 0.98)] || 1;
    TL.heat = { key, h: Array.from(bins, b => Math.min(1, Math.sqrt(b / top))) };
  }
  g.fillStyle = "rgba(196, 164, 106, .2)";
  g.beginPath(); g.moveTo(0, mid);
  TL.heat.h.forEach((h, i) => g.lineTo((i + 0.5) * W / n, mid - 2 - h * (mid - 9)));   // the busiest 7 px short of the bar's top
  g.lineTo(W, mid); g.closePath(); g.fill();
  // super chats: short strokes over the rail
  for (const r of S.d.sc) { g.fillStyle = TIERS[clamp(r[3] | 0, 0, 6)][0]; g.fillRect(X(r[0]) - 1, mid - 10, 2, 7); }
  // the guard count reaching each hundred (the first time: it can drop back and climb again): a diamond on
  // the rail, the number under it
  const st = S.d.guards;
  g.font = "600 9px 'Hinome Serif', serif"; g.textAlign = "center"; g.textBaseline = "top";
  for (let k = 1, best = st.length ? st[0][1] : 0; k < st.length; best = Math.max(best, st[k][1]), k++) {
    for (let m = Math.floor(best / 100 + 1) * 100; m <= st[k][1]; m += 100) {
      const x = X(st[k][0]);
      g.fillStyle = "#e8c47a";
      g.beginPath(); g.moveTo(x, mid - 4); g.lineTo(x + 4, mid); g.lineTo(x, mid + 4); g.lineTo(x - 4, mid); g.closePath(); g.fill();
      g.fillStyle = "rgba(240, 220, 180, .85)"; g.fillText(String(m), clamp(x, 10, W - 10), mid + 5);   // kept whole at the ends
    }
  }
  // hits of a search or a viewer, under the rail: her lines cream, the chat gold, super chats red
  for (const [p, colour] of [[P.subs, "#f1e8dc"], [P.chat, "#d5ae61"], [P.sc, "#e0526a"]]) {
    if (!p.filtered) continue;
    g.fillStyle = colour;
    for (const it of p.view) g.fillRect(X(it.t) - 0.75, mid + 3, 1.5, 9);
  }
}
function tlTip(t, clientX) {   // what is at the pointer
  const tip = $("tlTip"), tr = $("tlTrack"), subs = S.d.subs;
  let lo = 0, hi = subs.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (subs[m][0] <= t) { k = m; lo = m + 1; } else hi = m - 1; }
  const sub = k >= 0 && t <= Math.max(subs[k][1], subs[k][0] + 3) + 1.5 ? subs[k] : null;
  const real = realAt(t), b = real != null ? beijing(real) : null, g = guardsAt(t);
  tip.innerHTML = `<div class="tt"><b>${hms(t)}</b>${b ? `<span>北京 ${pad(b.getUTCHours())}:${pad(b.getUTCMinutes())}:${pad(b.getUTCSeconds())}</span>` : ""}`
    + `${g != null ? `<span>舰长 ${g}</span>` : ""}</div>`
    + (sub ? `<div class="line">${esc(sub[3])}</div><div class="line ja" lang="ja">${esc(sub[2])}</div>` : "");
  tip.hidden = false;
  const r = tr.getBoundingClientRect(), w = tip.offsetWidth;
  tip.style.left = `${clamp(clientX - r.left - w / 2, -r.left + 6, window.innerWidth - r.left - w - 6)}px`;
}
function tlScrub() {   // the panes go where the timeline is dragged, once a frame
  if (TL.raf) return;
  TL.raf = requestAnimationFrame(() => {
    TL.raf = 0;
    if (!TL.drag) return;
    for (const p of PANES) p.reveal(TL.drag.t);
    tick(true);
  });
}
function seekTo(t) {
  t = clamp(t, 0, S.d.length);
  if (S.play) playFrom(t, null, 0);
  else { pauseAt(t); for (const p of PANES) p.reveal(t); }
}

// ---------------------------------------------------------------- links, toast
function writeHash(t) {
  history.replaceState(null, "", `#p=${S.part}&t=${hms(t)}`);
}
function linkFor(t) {
  return `${location.origin}${location.pathname}#p=${S.part}&t=${hms(t)}`;
}
let toastTimer = 0;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}
async function copy(text, what = "链接") {
  try { await navigator.clipboard.writeText(text); toast(`已复制${what}`); }
  catch { prompt(`复制这个${what}：`, text); }
}

// ---------------------------------------------------------------- proofreading
// Proofreaders fix subtitle lines in place (the ✎ on a row). Each edit waits in this browser as a draft (待提交), its
// row showing the line as it is and as it would be, until they send them all at once (我的校对); their suggestions
// under review show in their rows the same way (审核中). The owner approves them on review.html, and the Worker hands
// the live ones out (worker/fixes.js). Those are laid over the part's data as it loads, field by field, a line known
// by its start in tenths of a second; d.orig keeps the data's own text of every line one touched, so a fresh list
// starts from it. Editing takes a key from the owner: a browser (a random id it keeps) is bound to one by entering
// it, up to 3 browsers a key, and the key is the proofreader, with the name they sign with.
const ID_KEY = "hinome-archive.uid", NICK_KEY = "hinome-archive.nick", DRAFT_KEY = "hinome-archive.drafts", BOUND_KEY = "hinome-archive.bound";
// map: "part:t" -> the reader's draft; sent: -> their suggestion waiting for review; mine: -> their latest reviewed one
// for the line (approved / rejected / reverted); counts: all of theirs by status; revs: the list /api/me gave; at: when
const DR = { map: new Map(), sent: new Map(), mine: new Map(), counts: null, revs: [], at: 0 };
const SEEN_KEY = "hinome-archive.seen";   // the newest review result this browser has shown its reader (updated_at)
const seenAt = () => { try { return +localStorage.getItem(SEEN_KEY) || 0; } catch { return 0; } };
const keepSeen = v => { try { localStorage.setItem(SEEN_KEY, String(v)); } catch {} };
const isNew = m => m.status !== "pending" && m.status !== "withdrawn" && m.updated_at > seenAt();
let ED = null;   // the line being edited: {part, i, t, ja, zh, note}
const t10 = t => Math.round(t * 10);
const lineKey = (part, t) => `${part}:${t}`;
const oneLine = s => String(s || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/ {2,}/g, " ").trim();   // as the Worker keeps it
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
let tempId = null;   // without storage (a private window): an id for this visit only
function myId() {
  try {
    let v = localStorage.getItem(ID_KEY);
    if (!/^[0-9a-f]{32}$/.test(v || "")) localStorage.setItem(ID_KEY, (v = newId()));
    return v;
  } catch { return (tempId ||= newId()); }
}
const myNick = () => { try { return localStorage.getItem(NICK_KEY) || ""; } catch { return ""; } };
const keepNick = v => { try { localStorage.setItem(NICK_KEY, v); } catch {} };
// bound to a key, as far as this browser knows (the Worker has the last word: a refusal clears it)
const isBound = () => { try { return localStorage.getItem(BOUND_KEY) === "1"; } catch { return false; } };
const keepBound = v => { try { if (v) localStorage.setItem(BOUND_KEY, "1"); else localStorage.removeItem(BOUND_KEY); } catch {} };
const ago = s => {
  const d = Date.now() / 1000 - s;
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  const t = new Date(s * 1000);
  return `${t.getMonth() + 1}/${t.getDate()}`;
};
const FIX_STATUS = { pending: "审核中", approved: "已通过", rejected: "未采纳", reverted: "已撤下", withdrawn: "已撤回" };

async function api(path, { body, uid = false } = {}) {   // the reader's id goes in a header (GET) or the body (POST)
  const r = await fetch(BiliStream.API + path, {
    method: body ? "POST" : "GET", cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : uid ? { "X-Uid": myId() } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (d.need === "key" || /已停用/.test(d.error || "")) keepBound(false);   // not (or no longer) bound to a usable key
    throw Object.assign(new Error(d.error || `出错了（${r.status}）`), { need: d.need });
  }
  return d;
}
async function fetchFixes(part) {   // the part's live fixes, or null
  try { return (await api(`/api/fixes?part=${part}`)).fixes; } catch { return null; }
}
function applyFixes(d, fixes) {
  if (!d.byT) { d.byT = new Map(d.subs.map((r, i) => [t10(r[0]), i])); d.orig = new Map(); }
  for (const [i, o] of d.orig) { d.subs[i][2] = o[0]; d.subs[i][3] = o[1]; }
  d.fixBy = new Map(); d.fixAt = new Map();   // who fixed a line, and when it last changed
  d.fixes = fixes || [];   // kept: reviewing here changes one line of it at a time
  for (const [t, ja, zh, by, at] of fixes || []) {
    const i = d.byT.get(t);
    if (i === undefined) continue;
    const r = d.subs[i];
    if (!d.orig.has(i)) d.orig.set(i, [r[2], r[3]]);
    if (ja !== null) r[2] = ja;
    if (zh !== null) r[3] = zh;
    d.fixBy.set(i, by);
    d.fixAt.set(i, at || 0);
  }
}

// a character diff by the longest common subsequence: [op, text], op -1 taken out, 0 kept, 1 put in
function charDiff(a, b) {
  a = [...a]; b = [...b];
  const n = a.length, m = b.length, L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [], push = (op, c) => { const l = out[out.length - 1]; if (l && l[0] === op) l[1] += c; else out.push([op, c]); };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push(0, a[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) push(-1, a[i++]);
    else push(1, b[j++]);
  }
  while (i < n) push(-1, a[i++]);
  while (j < m) push(1, b[j++]);
  return out;
}
// one field of a line: as it is, and, when changed, as it would be (what goes struck out, what comes marked)
function changeHTML(was, now, cls, plain = false) {
  const lang = cls === "ja" ? ' lang="ja"' : "";
  if (was === now) return `<div class="${cls}"${lang}>${plain ? esc(was) : hl(was, true)}</div>`;
  const ops = charDiff(was, now);
  return `<div class="fld"><div class="${cls} was"${lang}>${ops.map(([op, s]) => (op > 0 ? "" : op < 0 ? `<del>${esc(s)}</del>` : esc(s))).join("")}</div>`
       + `<div class="${cls} now"${lang}>${ops.map(([op, s]) => (op < 0 ? "" : op > 0 ? `<ins>${esc(s)}</ins>` : esc(s))).join("")}</div></div>`;
}

// the drafts, kept in this browser until sent
function loadDrafts() {
  try { for (const x of JSON.parse(localStorage.getItem(DRAFT_KEY) || "[]")) DR.map.set(lineKey(x.part, x.t), x); } catch {}
}
function saveDrafts() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify([...DR.map.values()])); } catch {}
  updateBar();
}

// the bar under the subtitles. A proofreader's part: the drafts to send, or, with none, how their suggestions stand (and
// how many results are new to them), one click from 我的校对. The owner's part (a browser holding the admin key): how
// many suggestions wait, one click from reviewing them here. Neither while reviewing (its own bar is there then).
const OWN = { pending: null, at: 0 };
function updateBar() {
  const n = DR.map.size, c = DR.counts, reader = !RV.on && (n > 0 || isBound()), owner = !RV.on && OWN.pending !== null;
  $("mineSeg").hidden = !reader;
  if (reader && n) {
    $("draftN").innerHTML = `<b>${n}</b> 处修改待提交`;
    $("draftGo").textContent = "查看并提交"; $("draftGo").className = "btn main";
  } else if (reader) {
    const fresh = DR.revs.filter(isNew).length;
    const chips = c ? [["pending", "审核中", "rv"], ["approved", "已通过", "ok"], ["rejected", "未采纳", "no"]]
      .filter(([s]) => c[s]).map(([s, w, k]) => `<span class="wchip ${k}">${w} ${c[s]}</span>`).join("") : "";
    $("draftN").innerHTML = `<span class="wlabel">我的校对</span>${chips || (c ? `<span class="wnote">还没有提交过</span>` : "")}`
      + (fresh ? `<span class="wnew">${fresh} 条新结果</span>` : "");
    $("draftGo").textContent = "查看"; $("draftGo").className = "btn";
  }
  $("ownSeg").hidden = !owner;
  if (owner) {
    $("ownN").innerHTML = `<span class="wlabel">审核</span>` + (OWN.pending ? `<span class="wchip rv">待审核 ${OWN.pending}</span>` : `<span class="wnote">没有待审核的</span>`);
    $("ownGo").className = OWN.pending ? "btn main" : "btn";
  }
  const show = reader || owner;
  $("draftBar").hidden = !show;
  P.subs.el.classList.toggle("has-drafts", show);
  document.body.classList.toggle("lowbar", show || RV.on);   // toasts go up, off the bar
}
async function refreshOwner() {   // the owner's browser: how many suggestions wait
  OWN.at = Date.now();
  if (!adminKey() || RV.on) { OWN.pending = null; updateBar(); return; }
  try { OWN.pending = (await adminApi("/api/admin/revs?status=pending&limit=1")).counts.pending || 0; }
  catch { OWN.pending = null; }
  updateBar();
}
function redrawSubs() { const p = P.subs; p.lo = 0; p.hi = -1; p.render(); p.showBack(); }

// editing a line in its row. The subtitles pane stops following playback meanwhile (as when scrolled by hand), so
// the row is not drawn away while it is typed in; 试听 plays the line without moving the pane.
function editorHTML() {   // ED.review: the owner editing a waiting suggestion before approving it (no note, 通过)
  const rv = !!ED.review;
  return `<div class="ed"><div class="ed-pair"><textarea class="ed-t" data-f="ja" lang="ja" rows="1" spellcheck="false" aria-label="日文原文">${esc(ED.ja)}</textarea>`
    + `<textarea class="ed-t" data-f="zh" rows="1" spellcheck="false" aria-label="中文翻译">${esc(ED.zh)}</textarea></div>`
    + (rv ? "" : `<input class="ed-note" data-f="note" maxlength="300" autocomplete="off" placeholder="说明（选填，通过后大家都看得到）：听到的是什么、为什么这样改" value="${esc(ED.note)}">`)
    + (!rv && ED.busy ? `<div class="ed-busy">这一句已有 ${ED.busy} 条别人的修改在等站长审核</div>` : "")   // two at one line: the second knows
    + `<div class="ed-btns"><button type="button" class="btn ghost" data-ed="play"><svg><use href="#i-play"/></svg>试听</button>`
    + `<span class="ed-hint">Enter ${rv ? "通过" : "完成"}　Esc 取消</span><button type="button" class="btn ghost" data-ed="cancel">取消</button>`
    + `<button type="button" class="btn main" data-ed="done">${rv ? "通过" : "完成"}</button></div></div>`;
}
const grow = ta => { ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight}px`; };
// v: the row's place in the pane's view; vals: the text to start from instead (a turned-down suggestion, to put right)
function openEditor(v, vals = null) {
  const p = P.subs, x = p.view[v];
  if (!isBound()) {   // a key first; then on to this line, wherever it is in the view by then
    askKey(() => { const w = P.subs.view.findIndex(y => y.i === x.i); if (w >= 0) openEditor(w, vals); });
    return;
  }
  if (ED) {
    if (ED.part === S.part && ED.i === x.i && !ED.review) return;
    if (!leaveEditor()) return;
  }
  const r = S.d.subs[x.i], key = lineKey(S.part, t10(r[0])), ch = vals || DR.map.get(key) || DR.sent.get(key);
  const ed = ED = { part: S.part, i: x.i, t: r[0], ja: ch ? ch.ja : r[2], zh: ch ? ch.zh : r[3], note: ch?.note || "", busy: 0 };
  showEditor(v);
  lineHistory(S.part, t10(r[0])).then(h => {   // others' suggestions already waiting on it: said in the editor
    if (ED === ed && h.waiting) { ED.busy = h.waiting; redrawSubs(); }
  }).catch(() => {});
}
// a line's history (/api/history); the owner's browser also gets the versions taken back off
const lineHistory = (part, t) => { const q = `/api/history?part=${part}&t=${t}`; return adminKey() ? adminApi(q) : api(q, { uid: isBound() }); };
function openReviewEditor(s) {   // the owner: a waiting suggestion in its row, to be put right and approved
  const i = s.part === S.part ? S.d.byT.get(s.t) : undefined, v = i === undefined ? -1 : P.subs.view.findIndex(y => y.i === i);
  if (v < 0 || (ED && !leaveEditor())) return;
  ED = { part: S.part, i, t: S.d.subs[i][0], ja: s.ja, zh: s.zh, note: "", review: s };
  showEditor(v);
}
const leaveEditor = () => (ED.review ? closeEditor(false) : closeEditor(true));   // another line opened: a reader's edit kept as a draft, never an approval
function showEditor(v) {
  const p = P.subs;
  p.detached = true;
  redrawSubs();
  const L = p.list, top = p.prefix[v], bottom = p.prefix[v + 1];   // the whole row in view
  if (top < L.scrollTop) L.scrollTop = top - 6;
  else if (bottom > L.scrollTop + L.clientHeight) L.scrollTop = Math.min(top - 6, bottom - L.clientHeight + 6);
  p.render();
  const el = p.spacer.querySelector('.row.editing [data-f="zh"]');
  if (el && !S.mobile) { el.focus({ preventScroll: true }); el.setSelectionRange(el.value.length, el.value.length); }   // a phone: the field the reader taps
}
// save: the edit becomes a draft (put back as it was, none), or, for the owner, the suggestion is approved as edited;
// false when it cannot be
function closeEditor(save) {
  if (!ED) return true;
  if (save && ED.review) {
    const s = ED.review, ja = oneLine(ED.ja), zh = oneLine(ED.zh);
    if (!ja || !zh) { toast("日文和中文都不能空着"); return false; }
    ED = null;
    if (S.d) redrawSubs();
    reviewSend(s, "approve", { ja, zh });
    return true;
  }
  if (save) {
    const d = S.cache[ED.part], r = d.subs[ED.i], key = lineKey(ED.part, t10(r[0])), sent = DR.sent.get(key);
    const ja = oneLine(ED.ja), zh = oneLine(ED.zh), note = oneLine(ED.note);
    if (!ja || !zh) { toast("日文和中文都不能空着"); return false; }
    if ((ja === r[2] && zh === r[3]) || (sent && ja === sent.ja && zh === sent.zh && note === sent.note)) DR.map.delete(key);
    else DR.map.set(key, { part: ED.part, t: t10(r[0]), base: d.orig.get(ED.i) || [r[2], r[3]], before: [r[2], r[3]], ja, zh, note });
    saveDrafts();
  }
  ED = null;
  if (S.d) redrawSubs();
  return true;
}
function editorAct(a) {
  if (a === "play") { if (ED?.part === S.part) playFrom(ED.t, P.subs); }
  else closeEditor(a === "done");
}

// whether this browser is still bound, its key's name, and its suggestions: the waiting ones and the latest reviewed one
// of each line (for the lines' tags), counted by status (for the bar and 我的校对)
async function refreshSent() {
  const me = await api("/api/me", { uid: true });
  keepBound(me.bound && !me.revoked);
  DR.sent = new Map(); DR.mine = new Map(); DR.revs = me.revs || []; DR.counts = me.bound ? me.counts || {} : null; DR.at = Date.now();
  const done = new Set();
  for (const m of DR.revs) {   // newest first: a line goes by the key's latest suggestion for it
    const k = lineKey(m.part, m.t);
    if (done.has(k)) continue;
    done.add(k);
    if (m.status === "pending") DR.sent.set(k, m);
    else if (m.status !== "withdrawn") DR.mine.set(k, m);
  }
  if (me.nick) keepNick(me.nick);
  updateBar();
  if (S.d) redrawSubs();
  return me;
}

// the key: asked for when editing starts on a browser not bound to one, then whatever was being done goes on
let afterKey = null;
function askKey(then = null) {
  afterKey = then;
  $("keyIn").value = ""; $("keyErr").textContent = "";
  if (!$("keyBox").open) $("keyBox").showModal();
  $("keyIn").focus();
}
async function bindKey(e) {
  e.preventDefault();
  const key = $("keyIn").value.trim(), btn = $("keyGo");
  if (!key) return;
  btn.disabled = true;
  try {
    const r = await api("/api/bind", { body: { uid: myId(), key } });
    keepBound(true);
    if (r.nick) keepNick(r.nick);
    $("keyBox").close();
    toast(`已绑定，可以开始校对了（这个密钥已用在 ${r.devices}/${r.max} 个浏览器上）`);
    const then = afterKey;
    afterKey = null;
    refreshSent().catch(() => {});
    if ($("mineBox").open) openMine();
    then?.();
  } catch (err) { $("keyErr").textContent = err.message; }
  finally { btn.disabled = false; }
}
async function unbindMe() {
  if (!confirm("解除绑定后，这个浏览器就不能再校对了（需要时再输入密钥），还没提交的修改会留在这里。继续吗？")) return;
  try {
    await api("/api/unbind", { body: { uid: myId() } });
    keepBound(false); DR.sent.clear(); DR.mine.clear(); DR.revs = []; DR.counts = null;
    updateBar();
    if (S.d) redrawSubs();
    toast("已解除这个浏览器的绑定");
    openMine();
  } catch (err) { toast(err.message); }
}

// sending the drafts: a hundred at most in one request; those that went through become suggestions under review
async function sendDrafts() {
  const items = [...DR.map.values()], btn = $("draftSend"), nick = $("mineNick").value.trim();
  if (!items.length) return;
  btn.disabled = true; btn.textContent = "提交中…";
  let ok = 0, bad = 0;
  try {
    for (let k = 0; k < items.length; k += 100) {
      const chunk = items.slice(k, k + 100);
      const r = await api("/api/submit", { body: { uid: myId(), nick,
        items: chunk.map(({ part, t, base, before, ja, zh, note }) => ({ part, t, base, before, ja, zh, note })) } });
      r.results.forEach((res, j) => {
        const x = chunk[j], key = lineKey(x.part, x.t);
        if (res.id) { ok++; DR.map.delete(key); DR.sent.set(key, { ...x, id: res.id, status: "pending" }); }
        else { bad++; x.error = res.error; }
      });
    }
    keepNick(nick);
    toast(bad ? `提交了 ${ok} 处，${bad} 处没有成功（原因写在下面）` : `已提交 ${ok} 处，等站长审核`);
  } catch (e) {
    if (e.need === "key") { btn.disabled = false; btn.textContent = "全部提交"; askKey(sendDrafts); return; }
    toast(e.message);
  }
  btn.disabled = false; btn.textContent = "全部提交";
  saveDrafts();
  if (S.d) redrawSubs();
  openMine(ok && !DR.map.size ? "pending" : "draft");   // what was sent, waiting now (or what is left to send)
}

// 我的校对: the key (bound or not, its places used), the name, the drafts to look over and send, the suggestions sent
// and what became of them
const NO_KEY = "参与校对需要站长发的校对密钥，一个密钥最多用在 3 个浏览器上。";
function showKeyState(me) {   // me: from /api/me; null while it loads (then as this browser remembers)
  const bound = me ? me.bound && !me.revoked : isBound();
  $("mineNickRow").hidden = !bound;
  $("mineKeyBtn").hidden = bound;
  $("mineUnbind").hidden = !(me ? me.bound : isBound());
  $("mineState").innerHTML = !me ? (bound ? "" : NO_KEY)
    : me.revoked ? "你的校对密钥已被停用，有疑问请联系站长。"
    : me.bound ? `已绑定校对密钥，这个密钥用在 <b>${me.devices}/${me.max}</b> 个浏览器上。`
    : NO_KEY;
}
// tabs: the drafts, then the sent ones by what became of them. Opened on the drafts when there are any, else on all (the
// newest results first) when some are new to the reader, else on the waiting ones. tab: one to open on
const MINE_TABS = [["draft", "待提交"], ["pending", "审核中"], ["approved", "已通过"], ["rejected", "未采纳"], ["all", "全部"]];
const MINE = { tab: "draft", fresh: new Set() };   // the tab shown; the results that were new when the box opened (marked 新)
async function openMine(tab) {
  const box = $("mineBox");
  if (!box.open) { box.showModal(); box.focus({ preventScroll: true }); MINE.shown = null; }   // opened at the top of its list
  $("mineNick").value = myNick();
  const asked = typeof tab === "string";   // (from a button's click it is the event)
  // which tab: the drafts when there are any; else all (the new results first) when some are new; else the waiting
  // ones; chosen first from what this page already has (no empty tab flashing while the list comes), then again
  const pick = () => (DR.map.size ? "draft" : DR.revs.some(isNew) ? "all" : DR.counts?.pending ? "pending" : DR.revs.length ? "all" : "draft");
  MINE.tab = asked ? tab : pick();
  showKeyState(null);
  renderMine(true);
  try {
    const me = await refreshSent();
    showKeyState(me);
    if (me.bound) { $("mineNick").value = me.nick || myNick(); $("mineTag").textContent = `#${me.tag}`; }
    MINE.fresh = new Set(DR.revs.filter(isNew).map(m => m.id));
    if (!asked) MINE.tab = pick();
    renderMine();
    markSeen();
  } catch (e) { $("mineList").textContent = e.message; }
}
function markSeen() {   // the results shown: no longer new (the bar's count, the dots on the lines' tags)
  const top = Math.max(0, ...DR.revs.filter(m => m.status !== "pending" && m.status !== "withdrawn").map(m => m.updated_at));
  if (top > seenAt()) { keepSeen(top); updateBar(); if (S.d) redrawSubs(); }
}
function renderMine(loading = false) {
  const c = DR.counts || {}, sent = Object.values(c).reduce((a, b) => a + b, 0);
  const count = s => (s === "draft" ? DR.map.size : s === "all" ? sent : c[s] || 0);
  const fresh = s => s !== "draft" && DR.revs.some(m => MINE.fresh.has(m.id) && (s === "all" || m.status === s));
  $("mineTabs").innerHTML = MINE_TABS.map(([s, w]) => `<button type="button" class="mtab${MINE.tab === s ? " on" : ""}${count(s) ? "" : " zero"}" data-mt="${s}">`
    + `${w}<b>${count(s)}</b>${fresh(s) ? '<i class="dnew" title="有新结果"></i>' : ""}</button>`).join("");
  $("draftPane").hidden = MINE.tab !== "draft";
  $("sentPane").hidden = MINE.tab === "draft";
  $("draftFoot").hidden = MINE.tab !== "draft" || !DR.map.size;   // 全部提交 always in sight, at the bottom
  if (MINE.shown !== MINE.tab) { $("mineBody").scrollTop = 0; MINE.shown = MINE.tab; }   // another tab: from its top
  if (MINE.tab === "draft") renderDrafts();
  else if (loading && !DR.revs.length) $("mineList").innerHTML = `<p class="mine-none">载入中…</p>`;
  else renderSent();
}
function renderDrafts() {
  const drafts = [...DR.map.values()].sort((a, b) => a.part - b.part || a.t - b.t);
  $("draftSend").disabled = !drafts.length;
  $("draftDrop").hidden = !drafts.length;
  $("draftList").innerHTML = drafts.length ? drafts.map(x => `<div class="mitem" data-part="${x.part}" data-t="${x.t}">`
      + `<div class="mr-hd"><b>P${x.part} ${hms(x.t / 10)}</b><span class="st draft">待提交</span>`
      + `<span class="mr-acts"><button type="button" class="mr-b" data-m="go">跳到这句</button><button type="button" class="mr-b" data-m="drop">撤销</button></span></div>`
      + `<div class="mbody">${changeHTML(x.before[0], x.ja, "ja", true)}${changeHTML(x.before[1], x.zh, "zh", true)}</div>`
      + (x.note ? `<div class="mr-why">说明：${esc(x.note)}</div>` : "") + (x.error ? `<div class="mr-err">没有提交成功：${esc(x.error)}</div>` : "")
      + `</div>`).join("")
    : `<p class="mine-none">没有待提交的修改。看到字幕有错，点那一句右边的 <svg class="ico"><use href="#i-pen"/></svg> 直接在那一行里改。</p>`;
}
const WHEN_DONE = { pending: "提交", approved: "通过", rejected: "审核", reverted: "撤下", withdrawn: "撤回" };
function renderSent() {
  const list = $("mineList");
  if (!isBound() && !DR.revs.length) { list.innerHTML = `<p class="mine-none">绑定校对密钥后，这里会列出交过的修改和审核结果。</p>`; return; }
  const items = DR.revs.filter(m => MINE.tab === "all" || m.status === MINE.tab)   // the new results first, then the latest
    .sort((a, b) => MINE.fresh.has(b.id) - MINE.fresh.has(a.id) || b.updated_at - a.updated_at || b.id - a.id);
  const want = MINE.tab === "all" ? Object.values(DR.counts || {}).reduce((a, b) => a + b, 0) : DR.counts?.[MINE.tab] || 0;
  const none = { pending: "没有在等审核的修改。", approved: "还没有通过的修改。", rejected: "没有未采纳的修改。" }[MINE.tab] || "还没有交过修改。";
  list.innerHTML = (items.length ? items.map(sentHTML).join("") : `<p class="mine-none">${none}</p>`)
    + (items.length < want ? `<p class="mine-none">审核过的只列最近 200 条。</p>` : "");
}
function sentHTML(m) {
  const fresh = MINE.fresh.has(m.id), edited = m.sub_ja != null || m.sub_zh != null;   // edited: the owner put it right before approving
  return `<div class="mitem${fresh ? " fresh" : ""}" data-part="${m.part}" data-t="${m.t}" data-id="${m.id}">`
    + `<div class="mr-hd"><b>P${m.part} ${hms(m.t / 10)}</b><span class="st ${m.status}">${FIX_STATUS[m.status] || ""}</span>`
    + (fresh ? `<span class="newtag">新</span>` : "") + `<span class="when">${ago(m.updated_at)}${WHEN_DONE[m.status] || ""}</span>`
    + `<span class="mr-acts"><button type="button" class="mr-b" data-m="go">跳到这句</button>`
    + (m.status === "pending" ? `<button type="button" class="mr-b" data-m="withdraw">撤回</button>` : "") + `</span></div>`
    + `<div class="mbody">${changeHTML(m.before_ja, m.ja, "ja", true)}${changeHTML(m.before_zh, m.zh, "zh", true)}</div>`
    + (m.note ? `<div class="mr-why">说明：${esc(m.note)}</div>` : "")
    + (m.status === "approved" && edited ? `<div class="mr-own">站长改过一点再通过。你原来写的是：${esc([m.sub_ja, m.sub_zh].filter(v => v != null).join(" ／ "))}</div>` : "")
    + (m.status === "rejected" ? `<div class="mr-no">${m.reason ? `理由：${esc(m.reason)}` : "站长没有写理由。"}</div>` : "")
    + (m.status === "reverted" ? `<div class="mr-why">站长把它从网站上撤下了，现在显示的是之前的版本。</div>` : "")
    + `</div>`;
}

// a line's card, opened from the tag under its time (or its dot): how the reader's own suggestion for it went (with
// what can be done about it), or who fixed the line; a fixed line's card also lists its history, every approved
// version newest first down to what the data said, fetched once it is open. Closed by a click elsewhere, Esc, or the
// subtitles scrolling.
const POP = { i: -1, rect: null };
function openPop(el, i, kind) {
  const d = S.d, r = d.subs[i], key = lineKey(S.part, t10(r[0])), pop = $("linePop");
  const yours = m => `<div class="pp-k">你交的</div>${changeHTML(m.before_ja, m.ja, "ja", true)}${changeHTML(m.before_zh, m.zh, "zh", true)}`;
  const hist = `<div class="pp-hist"><p class="pp-tip">载入修改记录…</p></div>`;   // filled in below
  let head = "", body = "", btns = "";
  if (kind === "draft") {
    head = `<span class="st draft">待提交</span>还没交给站长`;
    body = `<p>改好的几句可以一起交：点字幕栏下方的「查看并提交」。</p>`;
    btns = `<button type="button" class="btn main" data-pa="mine">查看并提交</button>`;
  } else if (kind === "sent") {
    const m = DR.sent.get(key) || {};
    head = `<span class="st pending">审核中</span>${m.created_at ? `${ago(m.created_at)}提交，` : ""}等站长审核`;
    body = (m.note ? `<p>说明：${esc(m.note)}</p>` : "") + `<p class="pp-tip">在审核之前可以接着改（再交一次就替换这一条），也可以撤回。</p>`;
    btns = `<button type="button" class="btn" data-pa="edit">接着改</button><button type="button" class="btn ghost" data-pa="withdraw">撤回</button>`;
  } else if (kind === "done") {
    const m = DR.mine.get(key) || {};
    if (m.status === "approved") {
      head = `<span class="st approved">已通过</span>${ago(m.updated_at)}通过`;
      body = (m.sub_ja != null || m.sub_zh != null ? `<p class="pp-own">站长改过一点再通过。你原来写的是：${esc([m.sub_ja, m.sub_zh].filter(v => v != null).join(" ／ "))}</p>` : "") + hist;
    } else if (m.status === "rejected") {
      head = `<span class="st rejected">未采纳</span>${ago(m.updated_at)}审核`;
      body = `<p class="pp-no">${m.reason ? `理由：${esc(m.reason)}` : "站长没有写理由。"}</p>` + yours(m);
      btns = `<button type="button" class="btn main" data-pa="redo">按我交的再改一次</button>`;
    } else {
      head = `<span class="st reverted">已撤下</span>${ago(m.updated_at)}撤下`;
      body = `<p>站长把这处修改从网站上撤下了，现在显示的是之前的版本。</p>` + yours(m);
    }
  } else {   // fixed (by someone, the reader or not)
    const at = d.fixAt?.get(i);
    head = `<i class="pp-dot"></i>观众校对过${at ? `<span class="pp-day">${dayOf(at, true)}</span>` : ""}`;
    body = `<p class="pp-by">${esc(d.fixBy?.get(i) || "")}</p>` + hist;
  }
  pop.innerHTML = `<div class="pp-hd">${head}<button type="button" class="pp-x" data-pa="close" aria-label="关闭">×</button></div>`
    + `<div class="pp-bd">${body}</div>${btns ? `<div class="pp-btns">${btns}</div>` : ""}`;
  POP.i = i; POP.rect = el.getBoundingClientRect();
  pop.hidden = false;
  placePop();
  if (!pop.querySelector(".pp-hist")) return;
  lineHistory(S.part, t10(r[0])).then(h => {
    if (POP.i !== i || pop.hidden) return;
    const by = pop.querySelector(".pp-by");   // who is credited for what the line shows, field by field
    if (by && (h.jaBy || h.zhBy)) by.textContent = h.jaBy && h.zhBy && h.jaBy !== h.zhBy ? `日文 ${h.jaBy} · 中文 ${h.zhBy}` : h.jaBy || h.zhBy;
    pop.querySelector(".pp-hist").innerHTML = historyHTML(h, i);
    placePop();
  }).catch(e => { if (POP.i === i) pop.querySelector(".pp-hist").innerHTML = `<p class="pp-tip">修改记录没能载入：${esc(e.message)}</p>`; });
}
function placePop() {   // under the tag (above it when there is no room), kept on screen; its body scrolls when long
  const pop = $("linePop"), a = POP.rect, w = Math.min(360, innerWidth - 24);
  if (!a) return;
  pop.style.width = `${w}px`;
  pop.style.left = `${Math.max(12, Math.min(a.left - 10, innerWidth - w - 12))}px`;
  const h = pop.offsetHeight, below = a.bottom + 8;
  pop.style.top = `${below + h <= innerHeight - 8 ? below : Math.max(8, Math.min(a.top - h - 8, innerHeight - h - 8))}px`;
}
// a line's versions, newest first, each with who made it, when, what it changed against the one before (field by field),
// and whether the site shows it now; at the bottom what the data said; and how many more wait for review
function historyHTML(h, i) {
  const d = S.d, o = d.orig.get(i) || [d.subs[i][2], d.subs[i][3]];
  const field = (k, n, html) => `<div class="hi-f"><span class="k">${n}</span><span class="${k}"${k === "ja" ? ' lang="ja"' : ""}>${html}</span></div>`;
  const items = [...h.revs].reverse().map(r => {
    const tag = r.status === "reverted" ? `<span class="hi-tag off">已撤下</span>` : r.live ? `<span class="hi-tag now">现在显示</span>` : `<span class="hi-tag old">已被后来的修改替换</span>`;
    const f = [["ja", "日"], ["zh", "中"]].filter(([k]) => r[k] !== r[`before_${k}`]).map(([k, n]) => field(k, n, unifiedHTML(r[`before_${k}`], r[k]))).join("");
    return `<div class="hi${r.live ? " live" : ""}${r.status === "reverted" ? " off" : ""}"><div class="hi-hd"><b>${esc(r.by)}</b>`
      + `<span title="${dayOf(r.at, true)}">${ago(r.at)}</span>${tag}</div>${f}${r.note ? `<div class="hi-note">说明：${esc(r.note)}</div>` : ""}</div>`;
  }).join("");
  return `<div class="pp-k">修改记录（${h.revs.length} 次）</div><div class="hist">${items}`
    + `<div class="hi orig"><div class="hi-hd"><b>原来</b><span>字幕数据里的</span></div>${field("ja", "日", esc(o[0]))}${field("zh", "中", esc(o[1]))}</div></div>`
    + (h.waiting ? `<p class="pp-wait">另有 ${h.waiting} 条修改在等站长审核</p>` : "")
    + `<p class="pp-more"><button type="button" class="linkbtn" data-pa="recent">看全站的校对记录</button></p>`;   // (a phone has no header row for it)
}

// 校对记录: the latest approved fixes across the site, newest first, by part; a click goes to the line
const RC = { part: 0, revs: [], counts: null, more: false, busy: false };
function openRecent() {
  const box = $("recentBox");
  if (!box.open) { box.showModal(); box.focus({ preventScroll: true }); }
  loadRecent(true);
}
async function loadRecent(fresh = false) {
  if (RC.busy && !fresh) return;
  if (fresh) { RC.revs = []; RC.more = false; $("recentList").innerHTML = `<p class="mine-none">载入中…</p>`; $("recentBody").scrollTop = 0; renderRecentTabs(); }
  RC.busy = true;
  const want = RC.part;
  try {
    const r = await api(`/api/recent?limit=40&offset=${RC.revs.length}${want ? `&part=${want}` : ""}`);
    if (want !== RC.part) return;   // another tab chosen meanwhile
    if (r.counts) RC.counts = r.counts;
    RC.revs.push(...r.revs); RC.more = r.revs.length === 40;
    renderRecentTabs(); renderRecent();
  } catch (e) { $("recentList").innerHTML = `<p class="mine-none">${esc(e.message)}</p>`; }
  finally { RC.busy = false; }
}
function renderRecentTabs() {
  const c = RC.counts || {}, all = Object.values(c).reduce((a, b) => a + b, 0);
  $("recentTabs").innerHTML = [[0, "全部"], ...S.meta.parts.map(p => [p.part, `P${p.part}`])].map(([p, w]) => {
    const n = p ? c[p] || 0 : all;
    return `<button type="button" class="mtab${RC.part === p ? " on" : ""}${RC.counts && !n ? " zero" : ""}" data-rp="${p}">${w}${RC.counts ? `<b>${n}</b>` : ""}</button>`;
  }).join("");
}
function renderRecent() {
  $("recentList").innerHTML = RC.revs.length ? RC.revs.map(r => `<div class="mitem" data-part="${r.part}" data-t="${r.t}">`
      + `<div class="mr-hd"><b>P${r.part} ${hms(r.t / 10)}</b><span class="mr-by">${esc(r.by)}</span><span class="when">${ago(r.at)}通过</span>`
      + (r.live ? "" : `<span class="st reverted">已被替换</span>`)
      + `<span class="mr-acts"><button type="button" class="mr-b" data-r="go">跳到这句</button></span></div>`
      + `<div class="mbody">${changeHTML(r.before_ja, r.ja, "ja", true)}${changeHTML(r.before_zh, r.zh, "zh", true)}</div>`
      + (r.note ? `<div class="mr-why">说明：${esc(r.note)}</div>` : "") + `</div>`).join("")
    : `<p class="mine-none">${RC.part ? "这一P" : ""}还没有通过的修改。</p>`;
  $("recentFoot").hidden = !RC.more;
}
function hidePop() { if (!$("linePop").hidden) { $("linePop").hidden = true; POP.i = -1; } }
function popAct(a) {
  const i = POP.i;
  hidePop();
  if (a === "close" || i < 0 || !S.d) return;
  const v = P.subs.view.findIndex(y => y.i === i), key = lineKey(S.part, t10(S.d.subs[i][0]));
  if (a === "recent") { openRecent(); return; }
  if (a === "mine") openMine("draft");
  else if (a === "edit" && v >= 0) openEditor(v);
  else if (a === "redo" && v >= 0) { const m = DR.mine.get(key); openEditor(v, m ? { ja: m.ja, zh: m.zh, note: m.note || "" } : null); }
  else if (a === "withdraw") withdrawLine(key);
}
async function withdrawLine(key) {
  const m = DR.sent.get(key);
  if (!m?.id) return;
  try {
    await api("/api/withdraw", { body: { uid: myId(), id: m.id } });
    DR.sent.delete(key);
    if (S.d) redrawSubs();
    toast("已撤回");
    refreshSent().catch(() => {});
  } catch (err) { if (err.need === "key") askKey(); else toast(err.message); }
}
async function mineAct(e) {
  const b = e.target.closest("[data-m]"), item = b?.closest(".mitem");
  if (!item) return;
  const { part, t, id } = item.dataset;
  if (b.dataset.m === "go") {   // to its line (a little after its start, so it is the current one)
    $("mineBox").close();
    location.hash = `#p=${part}&t=${hms(Math.ceil(+t / 10))}`;
  } else if (b.dataset.m === "drop") {
    DR.map.delete(lineKey(+part, +t)); saveDrafts();
    if (S.d) redrawSubs();
    openMine();
  } else if (b.dataset.m === "withdraw") {
    try {
      await api("/api/withdraw", { body: { uid: myId(), id: +id } });
      DR.sent.delete(lineKey(+part, +t));   // its row stops saying 审核中 at once, not when the list comes back
      if (S.d) redrawSubs();
      toast("已撤回"); openMine();
    } catch (err) { if (err.need === "key") askKey(); else toast(err.message); }
  }
}
async function saveNick() {
  const nick = $("mineNick").value.trim();
  try {
    const r = await api("/api/me", { body: { uid: myId(), nick } });
    keepNick(r.nick);
    $("mineTag").textContent = `#${r.tag}`;
    toast("署名已保存");
  } catch (e) { if (e.need === "key") askKey(saveNick); else toast(e.message); }
}

// ---------------------------------------------------------------- reviewing here (the owner; ?review in the URL)
// The waiting suggestions shown in their own rows, under the line as it is now, each with 通过 / 改一下再通过 /
// 不采纳: the line is played as any row is, so a fix is listened to where it is. 上一处 / 下一处 go from one waiting
// line to the next and play it. Uses the owner's key that review.html keeps (the same site, the same storage).
// byLine: "part:t" -> the waiting suggestions for it; at: the line gone to (下一处, or a click on a waiting line), which
// the keys A / E / R act on; last: the review just made, {s, action}, which 撤销 takes back
const RV = { on: false, loading: false, byLine: new Map(), total: 0, at: null, last: null };
const adminKey = () => { try { return localStorage.getItem("hinome-archive.adminKey") || ""; } catch { return ""; } };
async function adminApi(path, body) {
  const r = await fetch(BiliStream.API + path, {
    method: body ? "POST" : "GET", cache: "no-store",
    headers: { Authorization: `Bearer ${adminKey()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 401 ? "审核密钥不对，请在审核页重新输入" : d.error || `出错了（${r.status}）`);
  return d;
}
async function startReview() {
  if (!adminKey()) { toast("请先在审核页输入审核密钥"); setTimeout(() => { location.href = "review.html"; }, 1500); return; }
  RV.on = true; RV.loading = true; RV.last = null;
  updateReviewBar(); updateBar();
  try { await loadReview(); } catch (e) { toast(e.message); stopReview(); }
}
function enterReview() {   // from the bar: reviewing here, the address saying so (a reload stays in it)
  history.replaceState(null, "", `?review=1${location.hash}`);
  startReview();
}
function stopReview() {
  RV.on = false; RV.loading = false; RV.byLine = new Map(); RV.total = 0; RV.at = null; RV.last = null;
  history.replaceState(null, "", location.pathname + location.hash);
  if (ED?.review) closeEditor(false);
  updateReviewBar();
  if (S.d) redrawSubs();
  refreshOwner();
}
async function loadReview() {   // every waiting one (hundreds may wait), a thousand a request
  const all = [];
  for (let off = 0; ; off += 1000) {
    const r = await adminApi(`/api/admin/revs?status=pending&limit=1000&offset=${off}`);
    all.push(...r.revs);
    if (r.revs.length < 1000) break;
  }
  RV.byLine = new Map();
  for (const s of all) { const k = lineKey(s.part, s.t); (RV.byLine.get(k) || RV.byLine.set(k, []).get(k)).push(s); }
  RV.total = all.length; RV.loading = false;
  updateReviewBar();
  if (S.d) redrawSubs();
}
function updateReviewBar() {
  $("reviewBar").hidden = !RV.on;
  P.subs.el.classList.toggle("has-review", RV.on);
  if (!RV.on) return;
  let here = 0;
  for (const [k, a] of RV.byLine) if (k.startsWith(`${S.part}:`)) here += a.length;
  $("rvN").textContent = RV.loading ? "待审核：载入中…" : RV.total ? `待审核：本P ${here} 处，共 ${RV.total} 处` : "没有待审核的修改";
  $("rvPrev").disabled = $("rvNext").disabled = !RV.total;
  const lines = waitingLines(), at = RV.at ? lines.findIndex(s => s.part === RV.at.part && s.t === RV.at.t) : -1;
  $("rvPos").hidden = at < 0;
  if (at >= 0) $("rvPos").textContent = `第 ${at + 1} / ${lines.length} 句`;
  const L = RV.last, at10 = L && `P${L.s.part} ${hms(L.s.t / 10)}`;
  $("rvUndo").hidden = !L;
  if (L) {
    $("rvUndoT").textContent = L.action === "undone" ? `已撤销，${at10} 回到待审核` : `刚刚${L.action === "approve" ? "通过" : "不采纳"}了 ${at10}`;
    $("rvUndoGo").hidden = L.action === "undone";
  }
  document.body.classList.toggle("lowbar", RV.on || !$("draftBar").hidden);   // toasts go up, off the bar
}
const waitingLines = () => [...RV.byLine.values()].map(a => a[0]).sort((a, b) => a.part - b.part || a.t - b.t);
const curSuggestion = () => (RV.at && RV.at.part === S.part ? RV.byLine.get(lineKey(RV.at.part, RV.at.t))?.[0] : null);
// one waiting suggestion under its line: what it changes against the line as it is now, in one run per field
const unifiedHTML = (was, now) => charDiff(was, now).map(([op, s]) => (op === 0 ? esc(s) : op < 0 ? `<del>${esc(s)}</del>` : `<ins>${esc(s)}</ins>`)).join("");
function suggestionHTML(s, r, cur = false) {   // cur: the one the keys act on
  const now = [r[2], r[3]];
  let fields = "", warn = "";
  for (const [k, f, n] of [["日", "ja", 0], ["中", "zh", 1]]) {
    if (s[f] === s[`before_${f}`]) continue;   // a field it left alone
    fields += `<div class="rvs-f"><span class="k">${k}</span><span class="${f}"${f === "ja" ? ' lang="ja"' : ""}>${unifiedHTML(now[n], s[f])}`
      + `${s[f] === now[n] ? '<span class="rvs-same">（和现在一样）</span>' : ""}</span></div>`;
    if (s[`before_${f}`] !== now[n]) warn = `<div class="rvs-warn">提交之后这一句又被改过，上面按现在的文字对比</div>`;
  }
  return `<div class="rvs${cur ? " cur" : ""}" data-rv="${s.id}"><div class="rvs-hd"><b>${esc(s.by)}</b>${s.label ? `<span>${esc(s.label)}</span>` : ""}`
    + `<span>${ago(s.created_at)}</span></div>${fields}${warn}${s.note ? `<div class="rvs-note">说明：${esc(s.note)}</div>` : ""}`
    + `<div class="rvs-btns"><button type="button" class="btn main" data-rva="approve">通过</button>`
    + `<button type="button" class="btn ghost" data-rva="edit">改一下再通过</button><button type="button" class="btn ghost rvs-no" data-rva="reject">不采纳</button></div></div>`;
}
function reviewAction(id, a) {
  let s = null;
  for (const list of RV.byLine.values()) s ||= list.find(x => x.id === id);
  if (!s) return;
  if (a === "edit") { openReviewEditor(s); return; }
  if (a === "approve") { reviewSend(s, "approve"); return; }
  const reason = prompt("不采纳的理由（选填，提交的人能看到）：");
  if (reason !== null) reviewSend(s, "reject", { reason });
}
// done with one: it is taken out here, and an approved line takes its new text from the answer, instead of every
// waiting one and the part's fixes being read again (with hundreds waiting that took seconds on every click)
async function reviewSend(s, action, extra = {}) {
  try {
    const { rev } = await adminApi("/api/admin/act", { id: s.id, action, ...extra });
    const k = lineKey(s.part, s.t), rest = (RV.byLine.get(k) || []).filter(x => x.id !== s.id);
    if (rest.length) RV.byLine.set(k, rest); else RV.byLine.delete(k);
    RV.total = Math.max(0, RV.total - 1);
    if (action === "approve") liveLine(rev);
    RV.last = { s, action };   // the bar says what was done, with 撤销 (no toast over the bar's buttons)
    updateReviewBar();
    if (S.d) redrawSubs();
  } catch (e) { toast(e.message); }
}
function liveLine(rev) {   // a line's live fixes as the Worker's answer gives them, laid over this part's data
  if (!S.d || S.part !== rev.part) return;
  const L = rev.live, fixes = (S.d.fixes || []).filter(f => f[0] !== rev.t);
  if (L && (L.ja !== null || L.zh !== null)) fixes.push([rev.t, L.ja, L.zh, L.by, L.at]);
  applyFixes(S.d, fixes);
  for (const x of S.items.subs) x.f = undefined;   // the search's folded text
}
async function reviewUndo() {   // the review just made, taken back: waiting again (an approved line back as it was)
  const L = RV.last;
  if (!L) return;
  try {
    const { rev } = await adminApi("/api/admin/act", { id: L.s.id, action: "reopen" });
    const k = lineKey(rev.part, rev.t);
    (RV.byLine.get(k) || RV.byLine.set(k, []).get(k)).unshift({ ...L.s, ...rev });
    RV.total++; RV.last = { s: L.s, action: "undone" }; RV.at = { part: rev.part, t: rev.t };
    if (L.action === "approve") liveLine(rev);
    updateReviewBar();
    if (S.d) redrawSubs();
  } catch (e) { toast(e.message); }
}
function reviewGo(dir) {   // the next (or the one before) waiting line, from the last gone to, else from where playback is
  const lines = waitingLines();
  if (!lines.length) return;
  const pos = x => x.part * 1e7 + x.t, ref = RV.at ? pos(RV.at) : pos({ part: S.part, t: t10(nowT()) });
  const x = dir > 0 ? lines.find(s => pos(s) > ref) || lines[0] : [...lines].reverse().find(s => pos(s) < ref) || lines[lines.length - 1];
  RV.at = { part: x.part, t: x.t };
  updateReviewBar();
  if (x.part === S.part) { redrawSubs(); playFrom(x.t / 10); }   // from 2 s before it, every pane there
  else location.hash = `#p=${x.part}&t=${hms(Math.ceil(x.t / 10))}`;   // another part: there, standing (a click on the row plays it)
}
function reviewKey(k) {   // N / P: the next / the one before; A / E / R: approve, edit and approve, turn down the line gone to
  if (k === "n") return reviewGo(1);
  if (k === "p") return reviewGo(-1);
  const s = curSuggestion();
  if (!s) { toast("先点「下一处」，或点一句待审核的字幕"); return; }
  reviewAction(s.id, { a: "approve", e: "edit", r: "reject" }[k]);
}

// ---------------------------------------------------------------- viewer search
let sugg = [], suggAt = -1;
// the viewers to pick from, the most active first: on focus all of the part's, while typing those whose name has the text
function suggest() {
  const box = $("suggest"), typed = $("who").value.trim();
  if (!S.d) { box.hidden = true; return; }
  const v = S.who != null && typed === S.d.names[S.who] ? "" : fold(typed);   // the chosen one's name counts as no text
  const out = [];
  S.d.names.forEach((nm, n) => { if (S.activity[n] && (!v || fold(nm).includes(v))) out.push(n); });
  out.sort((a, b) => S.activity[b] - S.activity[a]);
  sugg = out; suggAt = v && sugg.length ? 0 : -1;
  box.scrollTop = 0;
  const head = `<div class="sh"><span>${!sugg.length ? "这一P没有这位观众" : v ? `找到 ${num(sugg.length)} 位` : `这一P全部 ${num(sugg.length)} 位观众，按发言条数排`}</span>`
    + `<button type="button" class="shut" data-shut>收起</button></div>`;
  const rows = sugg.map((n, j) => `<button type="button" data-n="${n}" class="${j === suggAt ? "hl" : ""}${n === S.who ? " on" : ""}">${avHTML(n, 22)}`
    + `<span class="n">${esc(S.d.names[n])}</span><span class="c">${S.activity[n]} 条</span></button>`).join("");
  box.innerHTML = S.mobile ? rows + head : head + rows;   // the 收起 row next to the box: under the list on a phone
  if (S.mobile) {   // upward from both boxes and as wide as them, into the room above (see style.css)
    const who = $("whoBox"), wr = who.getBoundingClientRect(), tr = who.parentElement.getBoundingClientRect();
    box.style.left = `${tr.left - wr.left - who.clientLeft}px`;
    box.style.maxHeight = `${Math.max(150, wr.top - 12)}px`;
  } else box.style.left = box.style.maxHeight = "";
  box.hidden = false;
  S.suggBar?.update();
}

// ---------------------------------------------------------------- events
function onRowClick(p, e) {
  if (e.target.closest(".row.editing")) {   // in the line being edited only its own buttons do anything (no playing from it)
    const b = e.target.closest("[data-ed]");
    if (b) editorAct(b.dataset.ed);
    return;
  }
  const rva = e.target.closest("[data-rva]");   // reviewing: a waiting suggestion's 通过 / 改一下再通过 / 不采纳
  if (rva) { reviewAction(+rva.closest(".rvs").dataset.rv, rva.dataset.rva); return; }
  const pp = e.target.closest("[data-pop]");   // a line's tag or dot: its card (a phone has no hover), no playing
  if (pp) {
    const x = p.view[+pp.closest(".row")?.dataset.v];
    if (x) { if (POP.i === x.i && !$("linePop").hidden) hidePop(); else openPop(pp, x.i, pp.dataset.pop); }
    return;
  }
  const nm = e.target.closest("[data-n]");
  if (nm) { setWho(+nm.dataset.n); return; }
  const row = e.target.closest(".row");
  if (!row) return;
  const i = +row.dataset.v, x = p.view[i];
  if (!x) return;
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "link") { copy(linkFor(x.t)); return; }
  if (act === "ctx") { showContext(x.t); return; }
  if (act === "fix") { openEditor(i); return; }
  if (act === "undo") { DR.map.delete(lineKey(S.part, t10(x.t))); saveDrafts(); redrawSubs(); return; }
  const sel = getSelection();
  if (sel && !sel.isCollapsed && row.contains(sel.anchorNode)) return;   // selecting text, not jumping
  p.anchor = p.prefix[i] - p.list.scrollTop;   // the clicked row stays under the pointer
  p.kept = i; p.detached = false;
  p.cur = i; p.mark(x.t, true);   // the row clicked is the current one, also among rows at the same time
  if (RV.on) {   // reviewing: a waiting line clicked is the one the keys act on; 下一处 goes on from here
    const k = t10(x.t);
    RV.at = RV.byLine.has(lineKey(S.part, k)) ? { part: S.part, t: k } : null;
    updateReviewBar(); redrawSubs();
  }
  playFrom(x.t, p);
}

const MQ = matchMedia("(max-width: 899px)");
function placePanes() {   // on a phone the super chats join the other panes under tabs
  S.mobile = MQ.matches;
  const sc = P.sc.el, home = S.mobile ? $("panes") : $("stage");
  if (sc.parentElement !== home) home.append(sc);
  setTab(S.tab);
  if (S.d) for (const p of PANES) p.reveal(nowT());
}
function setTab(name) {
  S.tab = name;
  for (const b of $("ptabs").children) b.classList.toggle("on", b.dataset.tab === name);
  for (const p of PANES) p.el.classList.toggle("show", !S.mobile || p.name === name);
}

function wire() {
  $("parts").addEventListener("click", e => {
    const b = e.target.closest("[data-part]");
    if (b && +b.dataset.part !== S.part) { loadPart(+b.dataset.part); history.replaceState(null, "", `#p=${b.dataset.part}`); }
  });
  $("ptabs").addEventListener("click", e => { const b = e.target.closest("[data-tab]"); if (b) setTab(b.dataset.tab); });
  window.addEventListener("pointerup", () => { for (const p of PANES) p.pressed = false; });
  window.addEventListener("pointercancel", () => { for (const p of PANES) p.pressed = false; });

  $("chips").addEventListener("click", e => {
    const b = e.target.closest(".chip");
    if (!b) return;
    S.show[b.dataset.kind] = !S.show[b.dataset.kind];
    applyFilters();
  });
  $("mention").addEventListener("click", () => { S.mention = !S.mention; applyFilters(); });

  let qt = 0;
  $("q").addEventListener("input", () => { clearTimeout(qt); qt = setTimeout(() => setQuery($("q").value), 220); });
  $("qForm").addEventListener("submit", e => { e.preventDefault(); clearTimeout(qt); setQuery($("q").value); });
  $("qForm").addEventListener("mousedown", e => {   // the icon and the edges of the box go to the text too
    if (!e.target.closest("input, button")) { e.preventDefault(); $("q").focus(); }
  });

  $("who").addEventListener("input", suggest);
  $("who").addEventListener("focus", suggest);
  $("who").addEventListener("click", () => { if ($("suggest").hidden) suggest(); });
  $("who").addEventListener("keydown", e => {
    const box = $("suggest");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!sugg.length || box.hidden) return;
      e.preventDefault();
      const down = e.key === "ArrowDown", n = sugg.length;
      suggAt = suggAt < 0 ? (down ? 0 : n - 1) : (suggAt + (down ? 1 : n - 1)) % n;
      const items = [...box.querySelectorAll("button[data-n]")];
      items.forEach((b, j) => b.classList.toggle("hl", j === suggAt));
      items[suggAt]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!box.hidden && suggAt >= 0) setWho(sugg[suggAt]);
      else if (!$("who").value.trim()) setWho(null);
    } else if (e.key === "Escape") { box.hidden = true; }
  });
  $("who").addEventListener("blur", () => setTimeout(() => {
    $("suggest").hidden = true;
    if (S.d) $("who").value = S.who == null ? "" : S.d.names[S.who];   // typed but not chosen: show what applies
  }, 150));
  $("suggest").addEventListener("mousedown", e => {
    if (e.target.closest("[data-shut]")) { e.preventDefault(); $("suggest").hidden = true; $("who").blur(); return; }   // and the keyboard
    const b = e.target.closest("[data-n]");
    if (b) { e.preventDefault(); setWho(+b.dataset.n); $("who").blur(); }
  });
  $("whoClear").addEventListener("click", () => setWho(null));
  for (const id of ["whoClear", "whoGo"]) $(id).addEventListener("mousedown", e => e.preventDefault());   // the box keeps the focus
  $("whoGo").addEventListener("click", () => {   // the best match of what is typed; with nothing typed, the list
    const typed = $("who").value.trim();
    if (!typed || (S.who != null && typed === S.d.names[S.who])) { $("who").focus(); suggest(); return; }
    suggest();
    if (sugg.length) { setWho(sugg[0]); $("who").blur(); }
    else toast("这一P没有这位观众");
  });

  // jumping to a time: the icon opens a thin line to type on; Enter jumps, Esc or leaving it empty closes it
  const gotoOpen = open => {
    $("gotoForm").classList.toggle("open", open);
    $("gotoInput").tabIndex = open ? 0 : -1;
    if (open) $("gotoInput").focus(); else { $("gotoInput").value = ""; $("gotoInput").blur(); }
  };
  $("gotoBtn").addEventListener("mousedown", e => e.preventDefault());   // the line keeps the focus while it is open
  $("gotoBtn").addEventListener("click", () => {
    if (!$("gotoForm").classList.contains("open")) gotoOpen(true);
    else if ($("gotoInput").value.trim()) $("gotoForm").requestSubmit();
    else gotoOpen(false);
  });
  $("gotoInput").addEventListener("keydown", e => { if (e.key === "Escape") gotoOpen(false); });
  $("gotoInput").addEventListener("blur", () => setTimeout(() => { if (!$("gotoInput").value.trim()) gotoOpen(false); }, 150));
  $("gotoForm").addEventListener("submit", e => {
    e.preventDefault();
    const t = parseTime($("gotoInput").value);
    if (t == null || t > S.d.length) { toast("时间格式像 1:23:45，且不能超过这一P的长度"); return; }
    gotoOpen(false);
    playFrom(t);
  });
  $("follow").addEventListener("change", e => {
    S.follow = e.target.checked;
    if (S.follow) for (const p of PANES) p.detached = false;
  });
  $("player").addEventListener("load", playerLoaded);
  const vid = $("vid");   // our own <video> (stream mode): it owns the clock, so wire its state to the UI
  vid.addEventListener("play", () => { if (S.stream) { S.play = STREAM; showSync(); } });
  vid.addEventListener("pause", () => { if (S.stream && !vid.seeking) { S.play = null; showSync(); } });
  vid.addEventListener("ended", () => { if (S.stream) { S.play = null; showSync(); } });
  vid.addEventListener("waiting", () => { if (S.stream) $("buf").hidden = false; });
  for (const ev of ["playing", "canplay", "seeked"]) vid.addEventListener(ev, () => $("buf").hidden = true);
  $("speed").addEventListener("click", cycleRate);
  window.addEventListener("blur", () => setTimeout(() => {   // the moment of a click into the embed, when the page had the focus
    if (!S.stream && S.touch == null && document.activeElement === $("player")) { S.touch = performance.now(); S.playerFocused = true; }
  }, 0));
  $("sync").addEventListener("click", e => {
    if (e.target.closest("[data-sync]") && S.lost) playFrom(S.lost.t, null, 0);
  });
  $("nudge").addEventListener("click", e => {
    const n = e.target.closest("[data-nudge]");
    if (n) nudge(+n.dataset.nudge);
  });
  $("tPlay").addEventListener("click", togglePlay);
  for (const id of ["hitA", "hitB"]) {
    $(id).addEventListener("click", hitClick);
    $(id).addEventListener("dblclick", toggleFullscreen);
  }
  new ResizeObserver(placeHits).observe($("screen"));
  S.suggBar = new Bar($("suggest"), $("whoBox"));   // thousands of viewers: the page's own bar there too
  $("suggest").addEventListener("scroll", () => S.suggBar.update(), { passive: true });
  new ResizeObserver(() => S.suggBar.update()).observe($("suggest"));

  const tr = $("tlTrack");
  tr.addEventListener("pointerdown", e => {
    if (!S.d || e.button > 0) return;
    e.preventDefault();
    tr.setPointerCapture(e.pointerId);
    tr.focus({ preventScroll: true });
    TL.drag = { t: tlTime(e.clientX) };
    tr.classList.add("drag");
    tlTip(TL.drag.t, e.clientX);
    tlScrub();
  });
  tr.addEventListener("pointermove", e => {
    if (!S.d) return;
    const t = tlTime(e.clientX);
    if (TL.drag) { TL.drag.t = t; tlScrub(); }
    if (TL.drag || e.pointerType === "mouse") tlTip(t, e.clientX);
  });
  const letGo = (e, cancel) => {
    if (!TL.drag) return;
    const t = TL.drag.t;
    TL.drag = null;
    tr.classList.remove("drag");
    if (e.pointerType !== "mouse") $("tlTip").hidden = true;
    if (cancel) tick(true); else seekTo(t);
  };
  tr.addEventListener("pointerup", e => letGo(e, false));
  tr.addEventListener("pointercancel", e => letGo(e, true));
  tr.addEventListener("pointerleave", () => { if (!TL.drag) $("tlTip").hidden = true; });
  tr.addEventListener("keydown", e => {   // on the bar: the arrows step 10 s, with Shift a minute
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    seekBy((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 60 : 10));
  });
  new ResizeObserver(tlDraw).observe(tr);
  $("tBack").addEventListener("click", () => seekBy(-10));
  $("tFwd").addEventListener("click", () => seekBy(10));
  $("aboutBtn").addEventListener("click", () => {   // opened at its top, the box itself focused (no ring on a link or the button)
    const box = $("about");
    box.showModal();
    $("aboutBody").scrollTop = 0;
    box.focus({ preventScroll: true });
  });
  for (const b of document.querySelectorAll("dialog [data-close]")) b.addEventListener("click", () => b.closest("dialog").close());
  for (const d of [$("about"), $("mineBox"), $("recentBox")]) d.addEventListener("click", e => { if (e.target === d) d.close(); });   // a click outside it
  $("recentBtn").addEventListener("click", openRecent);
  $("recentBtn2").addEventListener("click", () => { $("about").close(); openRecent(); });
  $("recentTabs").addEventListener("click", e => { const b = e.target.closest("[data-rp]"); if (b && +b.dataset.rp !== RC.part) { RC.part = +b.dataset.rp; loadRecent(true); } });
  $("recentMore").addEventListener("click", () => loadRecent());
  $("recentList").addEventListener("click", e => {   // 跳到这句: there, a little after its start (the current line then)
    const it = e.target.closest("[data-r]")?.closest(".mitem");
    if (!it) return;
    $("recentBox").close();
    location.hash = `#p=${it.dataset.part}&t=${hms(Math.ceil(+it.dataset.t / 10))}`;
  });

  // proofreading: the line being edited in its row (typed into: it grows, the rows under it move down; Enter keeps
  // it as a draft, Esc drops the edit; an IME's own Enter only picks its words), the drafts' bar, 我的校对
  const subsList = P.subs.list;
  subsList.addEventListener("input", e => {
    const f = e.target.dataset.f;
    if (!ED || !f || !e.target.closest(".row.editing")) return;
    ED[f] = e.target.value;
    if (e.target.tagName === "TEXTAREA") { grow(e.target); P.subs.remeasure(); }
  });
  subsList.addEventListener("keydown", e => {
    if (!ED || !e.target.closest(".row.editing") || e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") { e.preventDefault(); closeEditor(true); }
    else if (e.key === "Escape") { e.preventDefault(); closeEditor(false); }
  });
  P.subs.drawn = sp => { for (const ta of sp.querySelectorAll(".row.editing textarea")) grow(ta); };
  $("draftGo").addEventListener("click", openMine);
  $("draftSend").addEventListener("click", sendDrafts);
  $("draftDrop").addEventListener("click", () => {
    if (!confirm(`撤销全部 ${DR.map.size} 处待提交的修改？`)) return;
    DR.map.clear(); saveDrafts();
    if (S.d) redrawSubs();
    openMine();
  });
  $("draftList").addEventListener("click", mineAct);
  $("mineList").addEventListener("click", mineAct);
  $("mineBtn").addEventListener("click", () => { $("about").close(); openMine(); });
  $("mineSave").addEventListener("click", saveNick);
  $("mineNick").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); saveNick(); } });
  $("rvPrev").addEventListener("click", () => reviewGo(-1));
  $("rvNext").addEventListener("click", () => reviewGo(1));
  $("rvExit").addEventListener("click", stopReview);
  $("rvUndoGo").addEventListener("click", reviewUndo);
  $("ownGo").addEventListener("click", enterReview);
  $("mineTabs").addEventListener("click", e => { const b = e.target.closest("[data-mt]"); if (b) { MINE.tab = b.dataset.mt; renderMine(); } });
  $("linePop").addEventListener("click", e => { const b = e.target.closest("[data-pa]"); if (b) popAct(b.dataset.pa); });
  document.addEventListener("pointerdown", e => {   // a click anywhere but the card (or another tag) closes it
    if (!$("linePop").hidden && !e.target.closest("#linePop, [data-pop]")) hidePop();
  }, true);
  // scrolled by the reader's wheel or finger closes it, not the list settling after an edit or a keypress (its bar:
  // pressing it is a click outside the card, which closes it)
  for (const ev of ["wheel", "touchmove"]) P.subs.list.addEventListener(ev, () => { POP.scrolledAt = performance.now(); }, { passive: true });
  P.subs.list.addEventListener("scroll", () => { if (performance.now() - (POP.scrolledAt || 0) < 900) hidePop(); }, { passive: true });
  window.addEventListener("resize", hidePop);
  document.addEventListener("visibilitychange", () => {   // back on the tab: results may have come in, more may wait
    if (document.hidden) return;
    if (isBound() && Date.now() - DR.at > 60000) refreshSent().catch(() => {});
    if (adminKey() && !RV.on && Date.now() - OWN.at > 60000) refreshOwner();
  });
  $("keyForm").addEventListener("submit", bindKey);
  $("keyCancel").addEventListener("click", () => $("keyBox").close());
  $("keyBox").addEventListener("close", () => { afterKey = null; });
  $("mineKeyBtn").addEventListener("click", () => askKey());
  $("mineUnbind").addEventListener("click", unbindMe);

  document.addEventListener("keydown", e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || !!document.querySelector("dialog[open]");   // a box open (说明, 我的校对, the key): no shortcuts behind it
    const bare = !typing && !e.ctrlKey && !e.metaKey && !e.altKey, k = e.key.toLowerCase();
    if (e.key === "Escape" && !$("linePop").hidden) { hidePop(); return; }
    if (bare && RV.on && !RV.loading && "npaer".includes(k) && k.length === 1) { e.preventDefault(); reviewKey(k); return; }   // reviewing
    if (e.key === "/" && !typing) { e.preventDefault(); $("q").focus(); $("q").select(); }
    else if (e.key === "Escape" && document.activeElement === $("q")) { $("q").value = ""; setQuery(""); $("q").blur(); }
    else if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey) {   // the transport: space or K, J and L
      const k = e.key.toLowerCase();
      if (k === " " || k === "k") { e.preventDefault(); togglePlay(); }
      else if (k === "j") seekBy(-10);
      else if (k === "l") seekBy(10);
      else if (k === "]" || k === "[") nudge(k === "]" ? 1 : -1);
    }
  });
  window.addEventListener("hashchange", fromHash);
  MQ.addEventListener("change", placePanes);
  // the clock: every 40 ms while following playback (the current row changes on time), every 250 ms otherwise
  let lastTick = 0;
  const loop = now => {
    if (now - lastTick >= (S.play ? 40 : 250)) { lastTick = now; tick(); }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  setInterval(() => { if (document.hidden) tick(); }, 1000);   // a hidden tab gets no frames
}

function fromHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const part = +h.get("p") || 1, t = parseTime(h.get("t"));
  if (!S.meta.parts.some(p => p.part === part)) return false;
  if (part !== S.part || !S.d) loadPart(part, t);
  else if (t != null) {
    S.play = null; S.lost = null; standAt(t);
    if (S.stream) vidStand(); else setPlayer(S.cur, false);
    for (const p of PANES) p.reveal(t);
    showSync();
    tick(true);
  }
  return true;
}

(async function main() {
  P.subs = new Pane("subs", { est: () => 52, row: subRow, noun: "字幕", where: 0.3 });
  P.chat = new Pane("chat", { est: x => (x.k === "chat" ? 30 : 32), row: chatRow, noun: "弹幕", align: "bottom" });
  P.sc = new Pane("sc", { est: () => 132, row: scRow, noun: "SC", where: 0, desc: true });   // the current one at the top
  PANES = [P.subs, P.chat, P.sc];
  try { S.meta = await loadJSON("data/videos.json"); }
  catch (e) { toast("数据载入失败：" + e.message); return; }
  wire();
  loadDrafts(); saveDrafts();   // the drafts kept from before, and their bar
  if (isBound()) refreshSent().catch(() => {});   // a proofreader: still bound? their suggestions and how they went
  if (new URLSearchParams(location.search).has("review")) startReview();   // the owner, reviewing here
  else if (adminKey()) refreshOwner();   // the owner's browser: how many wait (in the bar)
  placePanes();
  if (!location.hash || !fromHash()) loadPart(1);
})();
