// The owner's page for proofreaders' subtitle fixes (worker/fixes.js): approve one, as it is or edited; turn one
// down; or tick several waiting ones and approve or turn them down together; take a live one back off, or put it back
// on. And the proofreaders' keys: make one, look its code up any time, renew it, stop it, take a browser off it, rename
// its holder. What goes live or comes off shows on the site at once. The owner's own key (secrets/admin-key.txt) is
// asked for once and kept in this browser. Not linked from the site.
"use strict";

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pad = n => String(n).padStart(2, "0");
const hms = t => { t = Math.max(0, Math.floor(t)); return `${Math.floor(t / 3600)}:${pad(Math.floor(t / 60) % 60)}:${pad(t % 60)}`; };
const KEY = "hinome-archive.adminKey";
const STATUS = { pending: "待审核", approved: "已上线", rejected: "未采纳", reverted: "已撤下", withdrawn: "读者撤回了" };
const R = { st: "pending", part: "", key: "", who: "", offset: 0, more: false, revs: [], counts: {}, data: {}, sel: new Set() };   // sel: the ticked waiting ones
const main = $("main");

const ago = s => {
  const d = Date.now() / 1000 - s;
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  const t = new Date(s * 1000);
  return `${t.getMonth() + 1}/${t.getDate()}`;
};
const when = s => new Date(s * 1000).toLocaleString("zh-CN", { hour12: false });
let toastTimer = 0;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

const key = () => { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } };
async function api(path, body) {
  const r = await fetch(BiliStream.API + path, {
    method: body ? "POST" : "GET", cache: "no-store",
    headers: { Authorization: `Bearer ${key()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) {
    try { localStorage.removeItem(KEY); } catch {}
    login("密钥不对，请重新输入");
    throw new Error("密钥不对");
  }
  if (!r.ok) throw new Error(d.error || `出错了（${r.status}）`);
  return d;
}

function login(err = "") {
  main.innerHTML = `<div class="login"><h2>审核密钥</h2><p>在本地项目的 secrets/admin-key.txt 里。只保存在这个浏览器上，点「退出」清掉。</p>`
    + `<form id="loginForm"><input id="keyIn" type="password" autocomplete="off" placeholder="粘贴密钥"><button>进入</button></form>`
    + (err ? `<p class="err">${esc(err)}</p>` : "") + `</div>`;
  $("loginForm").addEventListener("submit", e => {
    e.preventDefault();
    const v = $("keyIn").value.trim();
    if (!v) return;
    try { localStorage.setItem(KEY, v); } catch {}
    load();
  });
  $("keyIn").focus();
}

// a part's data: the lines' own text, and the neighbours of the one a suggestion is for
const partData = p => (R.data[p] ||= fetch(`data/p${p}.json`).then(r => r.json())
  .then(d => ({ subs: d.subs, byT: new Map(d.subs.map((s, i) => [Math.round(s[0] * 10), i])) })));

// a character diff by the longest common subsequence: [op, text], op -1 taken out, 0 kept, 1 put in
function diff(a, b) {
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
const diffHTML = (a, b) => diff(a, b).map(([op, s]) => (op === 0 ? esc(s) : op < 0 ? `<del>${esc(s)}</del>` : `<ins>${esc(s)}</ins>`)).join("");

// one suggestion. A waiting one is shown against the line as the site has it now (what approving would change);
// one that went live, against what its reader saw (what it changed). Only the fields it changed count.
function card(r, d, mode = "") {
  const i = d.byT.get(r.t), line = i === undefined ? null : d.subs[i];
  const base = line ? [line[2], line[3]] : [r.base_ja, r.base_zh];
  const now = [r.live?.ja ?? base[0], r.live?.zh ?? base[1]];
  const waiting = r.status === "pending" || r.status === "rejected";
  const names = { ja: "日文", zh: "中文" };
  let fields = "", notes = "";
  for (const [k, f, n] of [["日", "ja", 0], ["中", "zh", 1]]) {
    const before = r[`before_${f}`], changed = r[f] !== before, cls = f === "ja" ? "v ja" : "v";
    if (!changed) fields += `<div class="f"><span class="k">${k}</span><span class="${cls} same">${esc(waiting ? now[n] : before)}　（没改）</span></div>`;
    else fields += `<div class="f"><span class="k">${k}</span><span class="${cls}">${diffHTML(waiting ? now[n] : before, r[f])}</span></div>`;
    if (changed && waiting && before !== now[n]) notes += `<div class="warn">提交之后这一句的${names[f]}又被改过；读者当时看到的是「${esc(before)}」</div>`;
    if (r[`sub_${f}`] != null) notes += `<div class="sub">读者原本写的${names[f]}：<b>${esc(r[`sub_${f}`])}</b></div>`;
  }
  if (line && (r.base_ja !== line[2] || r.base_zh !== line[3])) notes += `<div class="warn">提交里附带的原文和网站数据对不上，留意一下</div>`;
  if (r.note) notes += `<div class="sub">说明：<b>${esc(r.note)}</b></div>`;
  if (r.status === "rejected" && r.reason) notes += `<div class="sub">理由：<b>${esc(r.reason)}</b></div>`;
  if (r.status === "approved") {
    const on = r.live && (r.live.jaId === r.id || r.live.zhId === r.id);
    notes += `<div class="live${on ? "" : " off"}">${on ? "网站上正显示这一版" : "已被后来通过的修改盖过"}</div>`;
  }
  const ctx = i === undefined ? `<div class="ctx">网站数据里找不到这一句（时间对不上）</div>`
    : `<div class="ctx">${[i - 1, i + 1].filter(k => d.subs[k]).map(k => `<div>${k < i ? "前" : "后"} ${hms(d.subs[k][0])}　`
        + `<span lang="ja">${esc(d.subs[k][2])}</span>　${esc(d.subs[k][3])}</div>`).join("")}</div>`;
  if (mode === "edit") {
    fields = `<div class="edit"><textarea data-e="ja" rows="2" lang="ja">${esc(r.ja)}</textarea><textarea data-e="zh" rows="2">${esc(r.zh)}</textarea></div>`;
  }
  const acts = mode === "edit" ? `<button class="ok" data-a="edit-ok">确认通过</button><button data-a="cancel">取消</button>`
    : mode === "reject" ? `<input data-e="reason" maxlength="200" placeholder="理由（选填，提交的人能看到）"><button class="no" data-a="reject-ok">确认不采纳</button><button data-a="cancel">取消</button>`
    : { pending: `<button class="ok" data-a="approve">通过</button><button data-a="edit">改一下再通过</button><button class="no" data-a="reject">不采纳</button>`,
        rejected: `<button class="ok" data-a="approve">改为通过</button><button data-a="edit">改一下再通过</button>`,
        approved: `<button class="no" data-a="revert">撤下</button>`,
        reverted: `<button class="ok" data-a="restore">重新上线</button>` }[r.status] || "";
  const done = R.st !== "all" && R.st !== r.status;   // acted on here: left in place, dimmed, until the next refresh
  const pick = r.status === "pending" && !mode ? `<input type="checkbox" class="pick" data-pick="${r.id}"${R.sel.has(r.id) ? " checked" : ""} aria-label="选中这一条">` : "";
  return `<article class="card${done ? " done" : ""}${R.sel.has(r.id) ? " picked" : ""}" data-id="${r.id}"><div class="c-hd">${pick}<span class="at">P${r.part} ${hms(r.t / 10)}</span>`
    + `<a href="index.html?review=1#p=${r.part}&t=${hms(Math.ceil(r.t / 10))}" target="_blank" rel="noopener" title="在原页面里听这一句、审核">到原页面 ↗</a>`
    + `<span class="who${r.revoked ? " blocked" : ""}">${esc(r.by)}</span>${r.label ? `<span class="label">${esc(r.label)}</span>` : ""}`
    + `<span title="${when(r.created_at)}">${ago(r.created_at)}</span>`
    + `<span class="st ${r.status}">${STATUS[r.status] || r.status}</span></div>${fields}${notes}${ctx}`
    + (acts ? `<div class="act">${acts}</div>` : "") + `</article>`;
}

function showCounts() {
  for (const b of $("tabs").children) {
    const i = b.querySelector("i");
    if (i) i.textContent = R.counts[b.dataset.st] || "";
    b.classList.toggle("on", b.dataset.st === R.st);
  }
  document.title = `${R.counts.pending ? `(${R.counts.pending}) ` : ""}字幕校对审核 · 千舰史料`;
}

async function load(more = false) {
  if (!key()) { login(); return; }
  showCounts();
  if (R.st === "keys") { loadKeys(); return; }
  if (!more) { R.offset = 0; R.revs = []; R.sel.clear(); main.innerHTML = `<p class="note">载入中…</p>`; }
  const q = new URLSearchParams({ status: R.st, offset: R.offset });
  if (R.part) q.set("part", R.part);
  if (R.key) q.set("key", R.key);
  let res;
  try { res = await api(`/api/admin/revs?${q}`); }
  catch (e) { if (key()) main.innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
  R.counts = res.counts; showCounts();
  R.revs.push(...res.revs); R.offset += res.revs.length; R.more = res.revs.length === 100;
  render();
}
async function render() {
  const datas = {};
  for (const p of new Set(R.revs.map(r => r.part))) datas[p] = await partData(p);
  main.innerHTML = (R.key ? `<div class="filter">只看 ${esc(R.who)} 的提交<button type="button" data-a="unfilter">取消</button></div>` : "")
    + `<div class="bulk" id="bulk" hidden></div>`
    + (R.revs.length ? R.revs.map(r => card(r, datas[r.part])).join("")
       : `<p class="empty">${R.st === "pending" ? "没有待审核的提交。" : "这里还没有内容。"}</p>`)
    + (R.more ? `<button type="button" class="more" data-a="more">加载更多</button>` : "");
  showBulk();
}
async function redraw(r, mode = "") {
  const el = main.querySelector(`.card[data-id="${r.id}"]`);
  if (el) el.outerHTML = card(r, await partData(r.part), mode);
  showBulk();
}

// ticking waiting ones to deal with together: a bar over the list while any of the shown ones wait
function showBulk() {
  const bar = $("bulk");
  if (!bar) return;
  const waiting = R.revs.filter(r => r.status === "pending");
  for (const id of R.sel) if (!waiting.some(r => r.id === id)) R.sel.delete(id);
  bar.hidden = !waiting.length;
  if (!waiting.length) return;
  const n = R.sel.size, all = n === waiting.length;
  bar.innerHTML = `<label><input type="checkbox" data-pick="all"${all ? " checked" : ""}> 全选${R.more ? "已载入的" : ""} ${waiting.length} 条</label>`
    + `<span class="bulk-n">${n ? `已选 ${n} 条` : "勾选几条，可以一起通过或不采纳"}</span>`
    + `<button type="button" class="ok" data-a="bulk-approve"${n ? "" : " disabled"}>通过所选</button>`
    + `<button type="button" class="no" data-a="bulk-reject"${n ? "" : " disabled"}>不采纳所选</button>`;
}
async function bulk(action) {
  const ids = [...R.sel];
  if (!ids.length) return;
  let reason = "";
  if (action === "approve" && !confirm(`通过所选的 ${ids.length} 条？通过后网站上立即换成新的（之后也可以在「已上线」里一条条撤下）。`)) return;
  if (action === "reject") { reason = prompt(`不采纳所选的 ${ids.length} 条。理由（选填，会写在每一条上，提交的人看得到）：`); if (reason === null) return; }
  let done = 0, skipped = 0;
  try {
    for (let k = 0; k < ids.length; k += 100) {
      const res = await api("/api/admin/act", { ids: ids.slice(k, k + 100), action, reason });
      skipped += res.skipped;
      for (const id of res.done) {
        const r = R.revs.find(x => x.id === id);
        if (!r) continue;
        R.counts[r.status] = Math.max(0, (R.counts[r.status] || 1) - 1);
        r.status = action === "approve" ? "approved" : "rejected";
        if (action === "reject") r.reason = reason;
        R.counts[r.status] = (R.counts[r.status] || 0) + 1;
        R.sel.delete(id); done++;
      }
    }
  } catch (e) { toast(e.message); }
  showCounts();
  await render();
  if (done) toast(`${action === "approve" ? "已通过" : "已标为未采纳"} ${done} 条${skipped ? `，${skipped} 条已经被处理过，跳过` : ""}`);
}

async function act(r, action, extra = {}) {
  try {
    const res = await api("/api/admin/act", { id: r.id, action, ...extra });
    R.counts[r.status] = Math.max(0, (R.counts[r.status] || 1) - 1);
    R.counts[res.rev.status] = (R.counts[res.rev.status] || 0) + 1;
    Object.assign(r, res.rev);
    showCounts();
    redraw(r);
    toast({ approve: "已通过，网站上已经换成新的", reject: "已标为未采纳", revert: "已撤下，网站上回到之前的版本",
            restore: "已重新上线" }[action]);
  } catch (e) { toast(e.message); }
}

main.addEventListener("click", e => {
  const b = e.target.closest("[data-a]");
  if (!b) return;
  const a = b.dataset.a;
  if (a === "more") { load(true); return; }
  if (a === "unfilter") { R.key = ""; R.who = ""; load(); return; }
  if (a === "bulk-approve" || a === "bulk-reject") { bulk(a === "bulk-approve" ? "approve" : "reject"); return; }
  const el = b.closest(".card"), r = el && R.revs.find(x => x.id === +el.dataset.id);
  if (!r) return;
  if (a === "approve" || a === "revert" || a === "restore") act(r, a);
  else if (a === "edit" || a === "reject") redraw(r, a).then(() => main.querySelector(`.card[data-id="${r.id}"] [data-e]`)?.focus());
  else if (a === "cancel") redraw(r);
  else if (a === "edit-ok") act(r, "approve", { ja: el.querySelector('[data-e="ja"]').value, zh: el.querySelector('[data-e="zh"]').value });
  else if (a === "reject-ok") act(r, "reject", { reason: el.querySelector('[data-e="reason"]').value });
});
main.addEventListener("change", e => {   // a tick: one card, or all the waiting ones shown
  const p = e.target.dataset?.pick;
  if (!p) return;
  if (p === "all") {
    for (const r of R.revs) if (r.status === "pending") { if (e.target.checked) R.sel.add(r.id); else R.sel.delete(r.id); }
    for (const box of main.querySelectorAll(".pick")) { box.checked = e.target.checked; box.closest(".card").classList.toggle("picked", box.checked); }
  } else {
    if (e.target.checked) R.sel.add(+p); else R.sel.delete(+p);
    e.target.closest(".card").classList.toggle("picked", e.target.checked);
  }
  showBulk();
});
main.addEventListener("keydown", e => {   // Enter in the reason box turns it down
  if (e.key === "Enter" && e.target.matches('[data-e="reason"]')) e.target.closest(".card").querySelector('[data-a="reject-ok"]').click();
});

// the keys: each a proofreader, with up to max browsers bound to it, and its code (a new or renewed one also at the top)
async function loadKeys(code = "", what = "") {
  main.innerHTML = `<p class="note">载入中…</p>`;
  let res;
  try { res = await api("/api/admin/keys"); }
  catch (e) { if (key()) main.innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
  const { keys, max } = res;
  main.innerHTML = `<form class="newkey" id="newKey"><input id="newLabel" maxlength="40" placeholder="备注：给谁的（只有你看得到）"><button>新建密钥</button></form>`
    + (code ? `<div class="codebox"><div>${what}：<b class="code">${esc(code)}</b><button type="button" data-k="copy" data-code="${esc(code)}">复制</button></div>`
        + `<p>发给对方，对方第一次点字幕旁的 ✎ 时输入；一个密钥最多用在 ${max} 个浏览器上。以后在它的卡片上也随时看得到。</p></div>` : "")
    + (!keys.length ? `<p class="empty">还没有密钥。新建一个，发给要参与校对的人。</p>`
       : keys.map(k => `<article class="card${k.revoked ? " done" : ""}" data-kid="${k.id}" data-name="${esc(k.by)}" data-label="${esc(k.label)}" data-nick="${esc(k.nick)}">`
          + `<div class="c-hd"><span class="at">${esc(k.label || "（没写备注）")}</span><span class="who">${esc(k.by)}</span>`
          + `<span title="${when(k.created_at)}">${ago(k.created_at)}新建</span><span class="st ${k.revoked ? "rejected" : "approved"}">${k.revoked ? "已停用" : "可用"}</span></div>`
          + `<div class="kcode">${k.code ? `密钥 <b class="code">${esc(k.code)}</b><button type="button" data-k="copy" data-code="${esc(k.code)}">复制</button>`
              : "密钥看不到：它是 11 月 19 日以前建的，当时库里只存指纹。点「换新密钥」换一个看得到的，已绑定的浏览器照常能用"}</div>`
          + `<div class="sub">已上线 ${k.approved || 0}　待审核 ${k.pending || 0}　未采纳 ${k.rejected || 0}　撤下 ${k.reverted || 0}</div>`
          + `<div class="devs">浏览器 ${k.devices.length}/${max}：${k.devices.length ? k.devices.map(d => `<span class="dev">#${d.tag}　最近 ${ago(d.seen_at)}`
              + `<button type="button" data-k="unbind" data-uid="${d.uid}">解绑</button></span>`).join("") : "还没有绑定"}</div>`
          + `<div class="act"><button type="button" data-k="list">看提交</button><button type="button" data-k="label">改备注</button>`
          + `<button type="button" data-k="nick">改署名</button><button type="button" data-k="renew">换新密钥</button>`
          + `<button type="button" class="${k.revoked ? "ok" : "no"}" data-k="${k.revoked ? "unrevoke" : "revoke"}">${k.revoked ? "恢复" : "停用"}</button></div>`
          + `</article>`).join(""));
}
main.addEventListener("submit", async e => {
  if (e.target.id !== "newKey") return;
  e.preventDefault();
  try { const r = await api("/api/admin/keys", { label: $("newLabel").value }); loadKeys(r.code, "新密钥"); }
  catch (err) { toast(err.message); }
});
main.addEventListener("click", async e => {
  const b = e.target.closest("[data-k]");
  if (!b) return;
  if (b.dataset.k === "copy") {
    try { await navigator.clipboard.writeText(b.dataset.code); toast("已复制密钥"); } catch { prompt("复制这个密钥：", b.dataset.code); }
    return;
  }
  const card = b.closest("[data-kid]"), id = +card.dataset.kid, name = card.dataset.name;
  try {
    if (b.dataset.k === "list") { R.key = String(id); R.who = name; R.st = "all"; load(); return; }
    if (b.dataset.k === "label") {
      const label = prompt("备注（给谁的，只有你看得到）：", card.dataset.label);
      if (label === null) return;
      await api("/api/admin/key", { id, label });
    } else if (b.dataset.k === "nick") {
      const nick = prompt(`把 ${name} 的署名改成（留空就是匿名）：`, card.dataset.nick);
      if (nick === null) return;
      await api("/api/admin/key", { id, nick });
    } else if (b.dataset.k === "renew") {
      if (!confirm("换新密钥后，旧的密钥立即失效；已经绑定的浏览器不受影响，可以接着用。继续吗？")) return;
      const r = await api("/api/admin/key", { id, renew: true });
      loadKeys(r.code, "换好的新密钥");
      return;
    } else if (b.dataset.k === "revoke") {
      if (!confirm(`停用 ${name} 的密钥？它绑定的浏览器都不能再提交，待审核的提交会标为未采纳；已经上线的不受影响。`)) return;
      await api("/api/admin/key", { id, revoked: true });
    } else if (b.dataset.k === "unrevoke") {
      await api("/api/admin/key", { id, revoked: false });
    } else if (b.dataset.k === "unbind") {
      if (!confirm("解绑这个浏览器？它要再输入密钥才能接着校对（会占用一个位置）。")) return;
      await api("/api/admin/key", { id, unbind: b.dataset.uid });
    }
    toast("已更新");
    loadKeys();
  } catch (err) { toast(err.message); }
});

$("tabs").addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b) return;
  R.st = b.dataset.st; R.key = ""; R.who = "";
  load();
});
$("part").addEventListener("change", e => { R.part = e.target.value; load(); });
$("reload").addEventListener("click", () => load());
$("logout").addEventListener("click", () => { try { localStorage.removeItem(KEY); } catch {} login(); });
load();
