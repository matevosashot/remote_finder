// Markdown, JSON tree, CSV table and Jupyter notebook renderers.
import { rawUrl, viewerUrl } from "../api.js";
import { dirname, esc, h, join } from "../util.js";
import { renderCode } from "./text.js";

// ---------------------------------------------------------------- markdown

function resolveRel(base, href) {
  if (!href || /^([a-z]+:|#|\/\/)/i.test(href)) return null;
  const parts = (href.startsWith("/") ? href : join(base, href)).split("/");
  const out = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return "/" + out.join("/");
}

export function renderMarkdown(container, text, filePath) {
  const html = window.marked ? marked.parse(text, { gfm: true }) : `<pre>${esc(text)}</pre>`;
  const clean = window.DOMPurify ? DOMPurify.sanitize(html) : esc(text);
  const div = h("div", { class: "markdown-body", html: clean });
  const base = dirname(filePath);
  // relative images and links -> our raw / viewer URLs
  div.querySelectorAll("img[src]").forEach((img) => {
    const p = resolveRel(base, img.getAttribute("src"));
    if (p) img.src = rawUrl(p);
  });
  div.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href");
    const p = resolveRel(base, href?.split("#")[0]);
    if (p) a.href = viewerUrl(p);
    if (!href.startsWith("#")) a.target = "_blank";
  });
  div.querySelectorAll("pre code").forEach((c) => window.hljs && hljs.highlightElement(c));
  container.replaceChildren(div);
}

// ---------------------------------------------------------------- JSON tree

export function renderJson(container, text, { collapsedDepth = 2 } = {}) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // JSON Lines: parse each line
    const lines = text.split("\n").filter((l) => l.trim());
    try { data = lines.map((l) => JSON.parse(l)); }
    catch (e) { return renderCode(container, text, { lang: "json" }); }
  }
  const node = (value, key, depth) => {
    const keyEl = key !== undefined ? h("span", { class: "j-key" }, typeof key === "number" ? `${key}` : JSON.stringify(key), ": ") : null;
    if (value && typeof value === "object") {
      const isArr = Array.isArray(value);
      const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
      const summary = h("summary", {}, keyEl, h("span", { class: "j-brace" }, isArr ? `[${entries.length}]` : `{${entries.length}}`));
      const det = h("details", { open: depth < collapsedDepth }, summary);
      let filled = false;
      const fill = () => {
        if (filled) return;
        filled = true;
        const kids = h("div", { class: "j-kids" });
        const MAX = 2000;
        entries.slice(0, MAX).forEach(([k, v]) => kids.append(node(v, k, depth + 1)));
        if (entries.length > MAX) kids.append(h("div", { class: "j-more" }, `… ${entries.length - MAX} more`));
        det.append(kids);
      };
      if (det.open) fill();
      det.addEventListener("toggle", fill);
      return h("div", { class: "j-node" }, det);
    }
    const cls = value === null ? "j-null" : typeof value === "string" ? "j-str" : typeof value === "number" ? "j-num" : "j-bool";
    return h("div", { class: "j-leaf" }, keyEl, h("span", { class: cls }, JSON.stringify(value)));
  };
  container.replaceChildren(h("div", { class: "json-tree" }, node(data, undefined, 0)));
}

// ---------------------------------------------------------------- CSV

export function parseCsv(text, delim) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"' && field === "") q = true;
    else if (c === delim) { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function renderCsv(container, text, { delim = ",", maxRows = 10000 } = {}) {
  const rows = parseCsv(text, delim).slice(0, maxRows + 1);
  if (!rows.length) return container.replaceChildren(h("p", { class: "muted" }, "Empty file"));
  const header = rows[0];
  let body = rows.slice(1);
  let sortCol = -1, sortDir = 1;
  const table = h("table", { class: "csv" });
  const num = (v) => (v !== "" && !isNaN(+v) ? +v : null);
  const draw = () => {
    const thead = h("thead", {}, h("tr", {}, h("th", { class: "rownum" }, "#"),
      header.map((c, i) => h("th", { onclick: () => { sortDir = sortCol === i ? -sortDir : 1; sortCol = i; sort(); draw(); } },
        c, sortCol === i ? (sortDir > 0 ? " ▲" : " ▼") : ""))));
    const tbody = h("tbody");
    const frag = document.createDocumentFragment();
    body.forEach((r, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="rownum">${i + 1}</td>` + header.map((_, j) => `<td>${esc(r[j] ?? "")}</td>`).join("");
      frag.append(tr);
    });
    tbody.append(frag);
    table.replaceChildren(thead, tbody);
  };
  const sort = () => {
    body.sort((a, b) => {
      const x = a[sortCol] ?? "", y = b[sortCol] ?? "";
      const nx = num(x), ny = num(y);
      return (nx != null && ny != null ? nx - ny : x.localeCompare(y, undefined, { numeric: true })) * sortDir;
    });
  };
  draw();
  const note = rows.length > maxRows ? h("p", { class: "muted" }, `Showing first ${maxRows.toLocaleString()} rows`) : null;
  container.replaceChildren(h("div", { class: "csv-wrap" }, table), note || "");
}

// ---------------------------------------------------------------- notebook

export function renderNotebook(container, text, filePath) {
  let nb;
  try { nb = JSON.parse(text); } catch { return renderCode(container, text, { lang: "json" }); }
  const lang = nb.metadata?.kernelspec?.language || nb.metadata?.language_info?.name || "python";
  const src = (s) => (Array.isArray(s) ? s.join("") : s || "");
  const wrap = h("div", { class: "notebook" });
  for (const cell of nb.cells || []) {
    const box = h("div", { class: `nb-cell nb-${cell.cell_type}` });
    if (cell.cell_type === "markdown") {
      renderMarkdown(box, src(cell.source), filePath);
    } else if (cell.cell_type === "code") {
      const prompt = h("div", { class: "nb-prompt" }, `In [${cell.execution_count ?? " "}]:`);
      const codeBox = h("div", { class: "nb-src" });
      renderCode(codeBox, src(cell.source), { lang, lineNumbers: false });
      box.append(prompt, codeBox);
      for (const out of cell.outputs || []) {
        const o = h("div", { class: "nb-out" });
        const data = out.data || {};
        if (out.output_type === "stream") o.append(h("pre", { class: out.name === "stderr" ? "nb-err" : "" }, src(out.text)));
        else if (out.output_type === "error") o.append(h("pre", { class: "nb-err" }, (out.traceback || []).join("\n").replace(/\x1b\[[0-9;]*m/g, "")));
        else if (data["image/png"]) o.append(h("img", { src: `data:image/png;base64,${src(data["image/png"]).trim()}` }));
        else if (data["image/jpeg"]) o.append(h("img", { src: `data:image/jpeg;base64,${src(data["image/jpeg"]).trim()}` }));
        else if (data["image/svg+xml"]) o.append(h("img", { src: `data:image/svg+xml;utf8,${encodeURIComponent(src(data["image/svg+xml"]))}` }));
        else if (data["text/html"]) o.append(h("div", { class: "nb-html", html: window.DOMPurify ? DOMPurify.sanitize(src(data["text/html"])) : esc(src(data["text/html"])) }));
        else if (data["text/markdown"]) renderMarkdown(o, src(data["text/markdown"]), filePath);
        else if (data["text/plain"]) o.append(h("pre", {}, src(data["text/plain"])));
        box.append(o);
      }
    } else box.append(h("pre", {}, src(cell.source)));
    wrap.append(box);
  }
  container.replaceChildren(wrap);
}
