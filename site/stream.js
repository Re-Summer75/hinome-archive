// Play B站's own video in our own <video> through MSE, so the page is frame-perfectly in sync with it.
//
// The stream is DASH: a video track and an audio track, each one fragmented MP4 whose init (moov) and index (sidx)
// sit in the first tens of KB. Both go into one MediaSource (two SourceBuffers), so audio and video are locked
// together. We read init+sidx once (fast metadata), parse the sidx to a time→byte table, and fetch only the
// fragments we need. The bytes come from the Cloudflare Worker (STREAM_API), which adds the Referer B站's CDN
// wants (a browser can't send it cross-origin, and a direct fetch() to the CDN gets 403). The Worker's URLs are
// minted every ~30 min by a GitHub Action and expire in ~2 h; on a 403 we re-fetch the manifest and retry.
window.BiliStream = (() => {
  const STREAM_API = "https://media.renode-editor.com";
  const MS = self.ManagedMediaSource || self.MediaSource;   // ManagedMediaSource: MSE on iPhone (iOS 17.1+)

  function parseSidx(buf, boxFileOffset) {   // → {timescale, refs:[{byte,size,start}]}
    const dv = new DataView(buf), size = dv.getUint32(0);
    let p = 8;
    const version = dv.getUint8(p); p += 4;                // version + flags
    p += 4;                                                // reference_ID
    const timescale = dv.getUint32(p); p += 4;
    let earliest, firstOffset;
    if (version === 0) { earliest = dv.getUint32(p); p += 4; firstOffset = dv.getUint32(p); p += 4; }
    else { earliest = Number(dv.getBigUint64(p)); p += 8; firstOffset = Number(dv.getBigUint64(p)); p += 8; }
    p += 2;                                                // reserved
    const count = dv.getUint16(p); p += 2;
    const refs = [];
    let byte = boxFileOffset + size + firstOffset, time = earliest;
    for (let i = 0; i < count; i++) {
      const refSize = dv.getUint32(p) & 0x7fffffff; p += 4;
      const dur = dv.getUint32(p); p += 4;
      p += 4;                                              // SAP
      refs.push({ byte, size: refSize, start: time / timescale });
      byte += refSize; time += dur;
    }
    return { timescale, refs };
  }

  const AHEAD = 5;   // fragments kept buffered ahead of where we are / seek to
  const rangeEnd = s => +String(s).split("-")[1];

  class Track {
    constructor(t) { this.url = t.url; this.mime = t.mime; this.initEnd = rangeEnd(t.init); this.indexEnd = rangeEnd(t.index);
                     this.want = 0; this.busy = false; this.appended = new Set(); this.ready = false; this.onStale = null; }
    async range(a, b) {   // one Range fetch from the Worker; a 403/404 means the minted URL expired
      const r = await fetch(this.url, { headers: { Range: `bytes=${a}-${b}` } });
      if (!r.ok) { const e = new Error("seg " + r.status); e.stale = r.status === 403 || r.status === 404; throw e; }
      return r.arrayBuffer();
    }
    addBuffer(ms) { this.sb = ms.addSourceBuffer(this.mime); this.sb.addEventListener("updateend", () => { this.busy = false; this.pump(); }); }
    async init() {   // init (moov) + sidx in one request; metadata ready after the init append
      const head = await this.range(0, this.indexEnd);
      this.sidx = parseSidx(head.slice(this.initEnd + 1), this.initEnd + 1);
      await new Promise(res => { this.sb.addEventListener("updateend", res, { once: true }); this.sb.appendBuffer(head.slice(0, this.initEnd + 1)); });
      this.ready = true;
    }
    fragAt(time) {
      const r = this.sidx.refs; let lo = 0, hi = r.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (r[m].start <= time) lo = m; else hi = m - 1; }
      return lo;
    }
    seekTo(time) { this.want = this.fragAt(Math.max(0, time)); this.pump(); }
    pump() {
      if (this.busy || !this.ready || !this.sb || this.sb.updating) return;
      const r = this.sidx.refs;
      let i = this.want;
      while (i < r.length && this.appended.has(i) && i < this.want + AHEAD) i++;
      if (i >= r.length || i >= this.want + AHEAD || this.appended.has(i)) return;
      this.busy = true; this.appended.add(i);
      this.range(r[i].byte, r[i].byte + r[i].size - 1)
        .then(buf => { try { this.sb.appendBuffer(buf); } catch { this.busy = false; this.appended.delete(i); } })
        .catch(e => { this.busy = false; this.appended.delete(i); if (e && e.stale && this.onStale) this.onStale(); });
    }
  }

  class Player {
    constructor(video) { this.v = video; this.ms = null; this.V = null; this.A = null; this.gen = 0; this.part = 1; this._refresh = null; }
    // load a part's manifest and attach MSE; resolves to {duration,width,height} once metadata is ready, or null if
    // superseded by a newer load
    async load(mf) {
      const gen = ++this.gen;
      this.part = mf.part;
      for (const t of [mf.video, mf.audio])
        if (!MS.isTypeSupported(t.mime)) throw new Error("浏览器不支持该视频编码：" + t.mime);
      try { this.v.disableRemotePlayback = true; } catch { /* ManagedMediaSource wants this; harmless elsewhere */ }
      const ms = this.ms = new MS();
      this.v.src = URL.createObjectURL(ms);
      await new Promise(res => ms.addEventListener("sourceopen", res, { once: true }));
      if (gen !== this.gen) return null;
      const V = this.V = new Track(mf.video), A = this.A = new Track(mf.audio);
      V.onStale = A.onStale = () => this.refreshUrls();
      V.addBuffer(ms); A.addBuffer(ms);                    // both buffers before any append
      await Promise.all([V.init(), A.init()]);
      if (gen !== this.gen) return null;
      try { ms.duration = mf.duration; } catch {}
      const feed = () => { if (this.V) { this.V.seekTo(this.v.currentTime); this.A.seekTo(this.v.currentTime); } };
      this.v.addEventListener("seeking", feed);
      this.v.addEventListener("timeupdate", () => { if (this.V?.sidx && !this.V.appended.has(this.V.fragAt(this.v.currentTime) + 3)) feed(); });
      feed();
      return { duration: mf.duration, width: mf.width, height: mf.height };
    }
    // the minted URLs expired (seg 403): fetch a fresh manifest, swap the track URLs (the file is the same, so the
    // parsed sidx still holds), and resume. Deduped so many simultaneous failures trigger one refresh.
    refreshUrls() {
      if (!this._refresh) {
        const gen = this.gen;
        this._refresh = fetchManifest(this.part).then(mf => {
          this._refresh = null;
          if (gen !== this.gen) return;
          if (this.V) this.V.url = mf.video.url;
          if (this.A) this.A.url = mf.audio.url;
          this.V && this.V.pump(); this.A && this.A.pump();
        }).catch(() => { this._refresh = null; });
      }
      return this._refresh;
    }
    seek(t) { try { this.v.currentTime = Math.max(0, t); } catch {} }
    play() { return this.v.play(); }
    pause() { this.v.pause(); }
    get currentTime() { return this.v.currentTime; }
    get paused() { return this.v.paused; }
    get ended() { return this.v.ended; }
    set rate(r) { this.v.playbackRate = r; }
    get rate() { return this.v.playbackRate; }
  }

  // fetch the Worker's manifest for a part; throws if the Worker/stream is not there (page falls back to the embed)
  async function fetchManifest(part) {
    const r = await fetch(`${STREAM_API}/api/manifest?part=${part}`, { cache: "no-store" });
    if (!r.ok) throw new Error("manifest " + r.status);
    return r.json();
  }
  return { Player, fetchManifest, parseSidx, supported: !!MS };
})();
