// New-tab viewer: code, JSON, Markdown, CSV, notebooks, images (with folder stepping), media, PDF.
import { editorUrl, folderUrl, get, rawUrl, tailUrl, viewerUrl } from "./api.js";
import { toastError } from "./dialogs.js";
import { showPath } from "./pathbar.js";
import { $, basename, canEdit, category, clickLink, dirname, extOf, fmtDate, fmtSize, h, isText, join, kindLabel, openTab, store } from "./util.js";
import { langFor, renderCode } from "./viewers/text.js";
import { renderCsv, renderJson, renderMarkdown, renderNotebook } from "./viewers/rich.js";

const params = new URLSearchParams(location.search);
let path = params.get("path");
const body = $("#body");
const RAW_LIMIT = 5 << 20; // above this, text loads in chunks

let wrap = store.get("viewer.wrap", false);

function setHeader(st) {
  document.title = basename(path);
  showPath(path);
  $("#meta").textContent = `  ${kindLabel(st)} · ${fmtSize(st.size)} · ${fmtDate(st.mtime)}`;
}

function actions(st, extra = []) {
  const a = (label, onclick, title) => h("button", { class: "btn small", onclick, title }, label);
  const list = [
    ...extra,
    a("Show in Folder", () => openTab(folderUrl(dirname(path)))),
    isText(st) ? a("Head/Tail", () => openTab(tailUrl(path))) : null,
    canEdit(st) ? a("Edit", () => openTab(editorUrl(path))) : null,
    a("Download", () => clickLink(rawUrl(path, { download: 1 }))),
  ].filter(Boolean);
  $("#actions").replaceChildren(...list);
}

function modes(list, current, onPick) {
  $("#modes").replaceChildren(...list.map(([key, label]) =>
    h("button", { class: `seg-btn ${key === current ? "on" : ""}`, onclick: () => onPick(key) }, label)));
}

async function load() {
  let st;
  try { st = await get("/api/stat", { path }); } catch (e) { body.replaceChildren(h("p", { class: "page-msg" }, e.message)); return; }
  st.name = st.name || basename(path);
  if (st.kind === "dir") { location.replace(folderUrl(path)); return; }
  setHeader(st);
  const ext = extOf(st.name);
  const cat = category(st);
  actions(st);
  $("#modes").replaceChildren();

  if (cat === "image" && ext !== "svg") return showImage(st);
  if (ext === "svg") return showToggle(st, [["image", "Image"], ["source", "Source"]], "image", (m, box) =>
    m === "image" ? box.append(h("div", { class: "img-stage" }, h("img", { src: rawUrl(path) }))) : showText(st, box));
  if (cat === "video") return body.replaceChildren(h("video", { class: "media", src: rawUrl(path), controls: true, autoplay: false }));
  if (cat === "audio") return body.replaceChildren(h("div", { class: "page-msg" }, h("audio", { src: rawUrl(path), controls: true })));
  if (cat === "pdf") return body.replaceChildren(h("iframe", { class: "full-frame", src: rawUrl(path), title: st.name }));
  if (ext === "html" || ext === "htm") return showToggle(st, [["source", "Source"], ["render", "Render (sandboxed)"]], "source", (m, box) =>
    m === "render" ? box.append(h("iframe", { class: "full-frame", sandbox: "allow-scripts", src: rawUrl(path, { render: 1 }) })) : showText(st, box));

  const small = st.size <= RAW_LIMIT;
  if (small && (ext === "md" || ext === "markdown")) return showToggle(st, [["rendered", "Rendered"], ["source", "Source"]], "rendered", async (m, box) =>
    m === "rendered" ? renderMarkdown(box, await text(), path) : showText(st, box));
  if (small && ["json", "jsonl", "ndjson", "geojson"].includes(ext)) return showToggle(st, [["tree", "Tree"], ["source", "Source"]], "tree", async (m, box) =>
    m === "tree" ? renderJson(box, await text(), { collapsedDepth: 3 }) : showText(st, box, { pretty: ext === "json" }));
  if (small && ext === "ipynb") return showToggle(st, [["notebook", "Notebook"], ["source", "Source"]], "notebook", async (m, box) =>
    m === "notebook" ? renderNotebook(box, await text(), path) : showText(st, box));
  if (small && (ext === "csv" || ext === "tsv")) return showToggle(st, [["table", "Table"], ["source", "Source"]], "table", async (m, box) =>
    m === "table" ? renderCsv(box, await text(), { delim: ext === "tsv" ? "\t" : "," }) : showText(st, box));

  if (!isText(st)) {
    const peek = await get("/api/text", { path, mode: "head", n: 1 }).catch(() => null);
    if (!peek || peek.binary) {
      return body.replaceChildren(h("div", { class: "page-msg" },
        h("p", {}, `${kindLabel(st)} — no preview available.`),
        h("p", {}, h("button", { class: "btn", onclick: () => { body.replaceChildren(); const b = h("div", { class: "page-scroll" }); body.append(b); showText(st, b); } }, "Show as Text Anyway"), " ",
          h("button", { class: "btn", onclick: () => openTab(tailUrl(path, "head")) }, "Head/Tail"))));
    }
  }
  const box = h("div", { class: "page-scroll" });
  body.replaceChildren(box);
  showText(st, box);
}

let cachedText = null;
async function text() {
  if (cachedText == null) cachedText = await (await fetch(rawUrl(path))).text();
  return cachedText;
}

function showToggle(st, list, initial, render) {
  // remember the last mode per file type (e.g. Markdown: rendered vs source)
  const key = `viewer.mode.${extOf(st.name)}`;
  let mode = store.get(key, initial);
  if (!list.some(([k]) => k === mode)) mode = initial;
  const draw = async (m) => {
    mode = m;
    store.set(key, m);
    modes(list, m, draw);
    const box = h("div", { class: "page-scroll" });
    body.replaceChildren(box);
    try { await render(m, box); } catch (e) { box.replaceChildren(h("p", { class: "page-msg" }, String(e.message || e))); }
  };
  draw(mode);
}

/** Code view with line numbers, wrap toggle and chunked loading for big files. */
async function showText(st, box, { pretty = false } = {}) {
  const wrapBtn = h("button", { class: `btn small ${wrap ? "on" : ""}`, onclick: () => {
    wrap = !wrap;
    store.set("viewer.wrap", wrap);
    wrapBtn.classList.toggle("on", wrap);
    box.querySelectorAll(".code-view").forEach((c) => c.classList.toggle("wrap", wrap));
  } }, "Wrap");
  actions(st, [wrapBtn]);
  const lang = langFor(st.name);
  if (st.size <= RAW_LIMIT) {
    let t = await text();
    if (pretty) { try { t = JSON.stringify(JSON.parse(t), null, 2); } catch {} }
    const code = h("div", {});
    box.replaceChildren(code);
    renderCode(code, t, { lang, wrap });
    return;
  }
  // big: first chunk, then "load more" by byte offset
  let next = 0, line = 1;
  const more = h("div", { class: "load-more" });
  box.replaceChildren(more);
  const loadChunk = async () => {
    more.replaceChildren(h("span", { class: "muted" }, "Loading…"));
    const res = await get("/api/text", { path, mode: "byte", start: next, n: 20000 });
    const chunk = h("div", {});
    box.insertBefore(chunk, more);
    renderCode(chunk, res.lines.map((l) => l.t).join("\n"), { lang: null, wrap, startLine: line });
    line += res.lines.length;
    next = res.next ?? res.size;
    const cut = res.lines.filter((l) => l.cut).length;
    more.replaceChildren(
      h("span", { class: "muted" }, `Showing ${fmtSize(next)} of ${fmtSize(st.size)}${cut ? ` · ${cut} very long line(s) shortened` : ""}`),
      ...(next < st.size ? [h("button", { class: "btn small", onclick: () => loadChunk().catch(toastError) }, "Load More")] : []),
      h("button", { class: "btn small", onclick: () => openTab(tailUrl(path)) }, "Open Head/Tail Tool"));
  };
  await loadChunk();
}

// ---------------------------------------------------------------- images with folder stepping

let siblings = null;
async function showImage(st) {
  const img = h("img", { src: rawUrl(path), alt: st.name, draggable: false });
  const stage = h("div", { class: "img-stage fit" }, img);
  stage.addEventListener("click", () => stage.classList.toggle("fit"));
  body.replaceChildren(stage);
  img.onload = () => { $("#meta").textContent = `  ${img.naturalWidth}×${img.naturalHeight} · ${fmtSize(st.size)} · ${fmtDate(st.mtime)}`; };
  if (!siblings) {
    try {
      const res = await get("/api/list", { path: dirname(path) });
      const coll = new Intl.Collator(undefined, { numeric: true });
      siblings = res.entries.filter((e) => e.kind === "file" && category(e) === "image" && extOf(e.name) !== "svg")
        .map((e) => join(dirname(path), e.name)).sort(coll.compare);
    } catch { siblings = []; }
  }
  const i = siblings.indexOf(path);
  const step = (d) => {
    const n = siblings[(i + d + siblings.length) % siblings.length];
    if (!n || n === path) return;
    path = n;
    history.replaceState(null, "", viewerUrl(n));
    cachedText = null;
    load();
  };
  modes(siblings.length > 1 ? [["prev", "‹"], ["count", `${i + 1} / ${siblings.length}`], ["next", "›"]] : [], null,
    (k) => (k === "prev" ? step(-1) : k === "next" ? step(1) : null));
  document.onkeydown = (e) => {
    if (e.key === "ArrowRight") step(1);
    else if (e.key === "ArrowLeft") step(-1);
  };
}

load();
