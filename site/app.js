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
      this.spacer.innerHTML = html;
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

const actsHTML = p => `<div class="acts">${p.filtered ? `<button type="button" data-act="ctx" title="清掉筛选，在完整时间线里看前后"><svg><use href="#i-ctx"/></svg></button>` : ""}`
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

function subRow(x, i, p) {
  const r = S.d.subs[x.i];
  return rowOpen("sub", i, p) + `<div class="t">${hms(r[0])}</div><div class="body"><div class="ja" lang="ja">${hl(r[2], true)}</div>`
       + `<div class="zh">${hl(r[3], true)}</div></div>${actsHTML(p)}</div>`;
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
async function loadJSON(url) {
  const r = await fetch(url);
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
  S.part = part;
  renderTabs();
  const L = $("layout");
  L.classList.add("busy");
  let d;
  try {
    d = S.cache[part] || (S.cache[part] = await loadJSON(`data/p${part}.json`));
  } catch (e) {
    L.classList.remove("busy");
    toast("数据载入失败：" + e.message);
    return;
  }
  if (part !== S.part) return;   // another part was chosen meanwhile
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
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("已复制链接"); }
  catch { prompt("复制这个链接：", text); }
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
  box.innerHTML = (sugg.length ? `<div class="sh">${v ? `找到 ${num(sugg.length)} 位` : `这一P全部 ${num(sugg.length)} 位观众，按发言条数排`}</div>` : "")
    + (sugg.length ? sugg.map((n, j) => `<button type="button" data-n="${n}" class="${j === suggAt ? "hl" : ""}${n === S.who ? " on" : ""}">${avHTML(n, 22)}`
        + `<span class="n">${esc(S.d.names[n])}</span><span class="c">${S.activity[n]} 条</span></button>`).join("")
       : `<div class="sh">这一P没有这位观众</div>`);
  box.hidden = false;
  S.suggBar?.update();
}

// ---------------------------------------------------------------- events
function onRowClick(p, e) {
  const nm = e.target.closest("[data-n]");
  if (nm) { setWho(+nm.dataset.n); return; }
  const row = e.target.closest(".row");
  if (!row) return;
  const i = +row.dataset.v, x = p.view[i];
  if (!x) return;
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "link") { copy(linkFor(x.t)); return; }
  if (act === "ctx") { showContext(x.t); return; }
  const sel = getSelection();
  if (sel && !sel.isCollapsed && row.contains(sel.anchorNode)) return;   // selecting text, not jumping
  p.anchor = p.prefix[i] - p.list.scrollTop;   // the clicked row stays under the pointer
  p.kept = i; p.detached = false;
  p.cur = i; p.mark(x.t, true);   // the row clicked is the current one, also among rows at the same time
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
      const items = [...box.querySelectorAll("button")];
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
    box.scrollTop = 0;
    box.focus({ preventScroll: true });
  });

  document.addEventListener("keydown", e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || $("about").open;
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
  placePanes();
  if (!location.hash || !fromHash()) loadPart(1);
})();
