// Head / tail / from-line / from-byte with grep and live follow, for files of any size.
import { get, pageQuery, rawUrl, viewerUrl, wsUrl } from "./api.js";
import { showPath } from "./pathbar.js";
import { $, basename, clickLink, downloadBlob, esc, fmtDate, fmtSize, h, openTab, store } from "./util.js";

const params = new URLSearchParams(location.search);
const path = params.get("path");
const els = Object.fromEntries(["mode", "n", "start", "grep", "icase", "invert", "grepmode", "follow", "wrap", "status", "out", "gutter", "text", "start-wrap", "start-label"]
  .map((id) => [id.replace("-", "_"), $(`#${id}`)]));
let lines = [];    // {n?, o?, t, cut?, notice?}
let ws = null;
let lastRes = null;

document.title = `${basename(path)} — Head/Tail`;
showPath(path);
$("#actions").append(
  h("button", { class: "btn small", onclick: () => openTab(viewerUrl(path)) }, "Open Viewer"),
  h("button", { class: "btn small", onclick: () => clickLink(rawUrl(path, { download: 1 })) }, "Download File"));

// restore controls from the URL (bookmarkable)
els.mode.value = params.get("mode") || "tail";
for (const k of ["n", "start", "grep"]) if (params.get(k)) els[k].value = params.get(k);
for (const k of ["icase", "invert", "follow"]) els[k].checked = params.get(k) === "1";
if (params.get("grepmode")) els.grepmode.value = params.get("grepmode");
els.wrap.checked = store.get("tail.wrap", false);
els.out.classList.toggle("wrap", els.wrap.checked);

function syncControls() {
  const m = els.mode.value;
  els.start_wrap.hidden = !(m === "line" || m === "byte");
  els.start_label.textContent = m === "line" ? "from line" : "from byte";
  if (m === "line" && +els.start.value < 1) els.start.value = 1;
}
els.mode.addEventListener("change", () => { if (els.mode.value !== "tail") els.follow.checked = false; syncControls(); run(); });
els.wrap.addEventListener("change", () => {
  els.out.classList.toggle("wrap", els.wrap.checked);
  store.set("tail.wrap", els.wrap.checked);
});
els.follow.addEventListener("change", () => {
  if (els.follow.checked && els.mode.value !== "tail") { els.mode.value = "tail"; syncControls(); }
  run();
});
els.grepmode.addEventListener("change", run);
$("#form").addEventListener("submit", (e) => { e.preventDefault(); run(); });
$("#dl").addEventListener("click", () => downloadBlob(new Blob([lines.filter((l) => !l.notice).map((l) => l.t).join("\n") + "\n"], { type: "text/plain" }), `${basename(path)}.${els.mode.value}.txt`));
syncControls();

function regex() {
  const g = els.grep.value;
  if (!g) return null;
  try { return new RegExp(g, els.icase.checked ? "gi" : "g"); } catch { return null; }
}

function updateUrl() {
  const m = els.mode.value;
  history.replaceState(null, "", `?${pageQuery({
    path, mode: m, n: els.n.value,
    start: m === "line" || m === "byte" ? els.start.value : null,
    grep: els.grep.value || null, grepmode: els.grep.value ? els.grepmode.value : null,
    icase: els.icase.checked ? 1 : null, invert: els.invert.checked ? 1 : null, follow: els.follow.checked ? 1 : null,
  })}`);
}

async function run() {
  updateUrl();
  ws?.close();
  ws = null;
  const serverGrep = els.grep.value && els.grepmode.value === "filter";
  setStatus("Loading…");
  let res;
  try {
    res = await get("/api/text", {
      path, mode: els.mode.value, n: Math.max(1, +els.n.value || 200),
      start: els.mode.value === "line" ? Math.max(1, +els.start.value || 1) : els.mode.value === "byte" ? Math.max(0, +els.start.value || 0) : undefined,
      grep: serverGrep ? els.grep.value : undefined, icase: els.icase.checked || undefined, invert: serverGrep && els.invert.checked ? true : undefined,
    });
  } catch (e) {
    setStatus(e.message, true);
    lines = [];
    draw();
    return;
  }
  lastRes = res;
  lines = res.lines;
  draw(true);
  setStatus();
  if (els.follow.checked) follow(res.end);
}

function setStatus(msg, warn = false) {
  if (msg) return els.status.replaceChildren(h("span", { class: warn ? "warn" : "" }, msg));
  const r = lastRes;
  if (!r) return;
  const bits = [
    `${fmtSize(r.size)}`,
    `modified ${fmtDate(r.mtime)}`,
    `${lines.filter((l) => !l.notice).length.toLocaleString()} line(s) shown`,
  ];
  const first = lines.find((l) => l.n)?.n, last = [...lines].reverse().find((l) => l.n)?.n;
  if (first) bits.push(`lines ${first.toLocaleString()}–${last.toLocaleString()}`);
  if (r.total_lines) bits.push(`${r.total_lines.toLocaleString()} lines total`);
  const kids = bits.map((b) => h("span", {}, b));
  if (r.binary) kids.push(h("span", { class: "warn" }, "binary content (shown with replacement characters)"));
  if (r.truncated) kids.push(h("span", { class: "warn" }, "output capped at 5 MB — use a smaller line count or grep"));
  if (r.stopped_at != null) kids.push(h("span", { class: "warn" }, `grep stopped after 20 s at byte ${r.stopped_at.toLocaleString()}`));
  if (lines.some((l) => l.cut)) kids.push(h("span", { class: "warn" }, "very long lines shortened to 64 KB"));
  if (ws) kids.push(h("span", {}, "● following"));
  els.status.replaceChildren(...kids);
}

function draw(scrollToEnd = false) {
  const rx = els.grepmode.value === "highlight" ? regex() : null;
  const gutter = [], html = [];
  for (const l of lines) {
    gutter.push(l.n != null ? l.n : "");
    if (l.notice) { html.push(`<span class="notice">${esc(l.t)}</span>`); continue; }
    let s = esc(l.t);
    if (rx) {
      rx.lastIndex = 0;
      s = "";
      let i = 0, m;
      while ((m = rx.exec(l.t)) && m[0] !== "") {
        s += esc(l.t.slice(i, m.index)) + `<mark>${esc(m[0])}</mark>`;
        i = m.index + m[0].length;
      }
      s += esc(l.t.slice(i));
    }
    html.push(l.cut ? `${s}<span class="cut"> … [line shortened]</span>` : s);
  }
  els.gutter.textContent = gutter.join("\n");
  els.text.innerHTML = html.join("\n") || `<span class="notice">${lastRes ? "(no lines)" : ""}</span>`;
  if (scrollToEnd && els.mode.value === "tail") els.out.scrollTop = els.out.scrollHeight;
  else if (scrollToEnd) els.out.scrollTop = 0;
}

function follow(pos) {
  const rx = regex();
  const keep = Math.max(+els.n.value || 200, 1000);
  ws = new WebSocket(wsUrl("/ws/follow", { path, pos }));
  ws.onopen = () => setStatus();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    const atBottom = els.out.scrollTop + els.out.clientHeight >= els.out.scrollHeight - 30;
    if (m.type === "lines") {
      let add = m.lines;
      if (rx && els.grepmode.value === "filter") add = add.filter((t) => { rx.lastIndex = 0; return rx.test(t) !== els.invert.checked; });
      lines.push(...add.map((t) => ({ t })));
      if (lines.length > keep) lines = lines.slice(-keep);
    } else if (m.type === "reset") {
      lines.push({ t: `— file ${m.reason}; following from the start —`, notice: true });
    } else if (m.type === "error") {
      setStatus(m.error, true);
      return;
    }
    draw();
    if (atBottom) els.out.scrollTop = els.out.scrollHeight;
    setStatus();
  };
  ws.onclose = () => { if (ws) { ws = null; setStatus(); } };
}
setInterval(() => ws?.readyState === 1 && ws.send("ping"), 25000);

run();
