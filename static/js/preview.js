// One preview renderer for Quick Look, the preview pane, the columns view and gallery.
import { get, rawUrl, thumbUrl } from "./api.js";
import { iconFor } from "./icons.js";
import { category, extOf, fmtDate, fmtSize, h, isText, kindLabel } from "./util.js";
import { langFor, renderCode } from "./viewers/text.js";
import { renderCsv, renderJson, renderMarkdown, renderNotebook } from "./viewers/rich.js";

const PREVIEW_LINES = 400;
const RICH_LIMIT = 2 << 20; // render md/json/ipynb fully below 2 MB

/** Render `entry` into `container`. mode: 'quicklook' | 'pane' | 'column' | 'gallery'. */
export async function renderPreview(container, entry, mode = "pane") {
  const token = Symbol();
  container._token = token;
  const stale = () => container._token !== token;
  container.classList.remove(...[...container.classList].filter((c) => c.startsWith("preview")));
  container.classList.add("preview", `preview-${mode}`);
  if (!entry) return container.replaceChildren(h("div", { class: "preview-empty" }, "No selection"));

  const body = h("div", { class: "preview-body" });
  const showInfo = mode !== "quicklook";
  const info = showInfo ? infoBlock(entry) : null;
  container.replaceChildren(body, info || "");

  try {
    await fillBody(body, entry, mode, stale);
  } catch (e) {
    if (!stale()) body.replaceChildren(bigIcon(entry), h("p", { class: "muted" }, String(e.message || e)));
  }
}

function bigIcon(entry) {
  return h("div", { class: "preview-icon", html: iconFor(entry) });
}

function infoBlock(entry) {
  const rows = [
    ["Kind", kindLabel(entry)],
    entry.kind === "file" ? ["Size", `${fmtSize(entry.size)}`] : null,
    ["Modified", fmtDate(entry.mtime)],
    entry.perm ? ["Permissions", entry.perm] : null,
    entry.link ? ["Alias to", entry.target || "?"] : null,
  ].filter(Boolean);
  return h("div", { class: "preview-info" },
    h("div", { class: "preview-name" }, entry.name),
    h("dl", {}, rows.map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])));
}

async function fillBody(body, entry, mode, stale) {
  if (entry.kind === "dir") {
    body.append(bigIcon(entry));
    if (mode !== "column") {
      const res = await get("/api/list", { path: entry.path }).catch(() => null);
      if (stale()) return;
      if (res) body.append(h("p", { class: "muted center" }, `${res.entries.length.toLocaleString()} items`));
    }
    return;
  }
  if (entry.kind !== "file" || entry.broken) return body.append(bigIcon(entry));

  const cat = category(entry);
  const ext = extOf(entry.name);
  const url = rawUrl(entry.path);

  if (cat === "image") {
    const src = ext === "svg" || mode === "quicklook" ? url : thumbUrl(entry.path, mode === "gallery" ? 1024 : 512, entry.mtime);
    const img = h("img", { class: "preview-img", src, alt: entry.name, draggable: false });
    img.onerror = () => { if (img.src !== location.origin + url) img.src = url; };
    return body.append(img);
  }
  if (cat === "video") return body.append(h("video", { class: "preview-media", src: url, controls: true, preload: "metadata" }));
  if (cat === "audio") return body.append(bigIcon(entry), h("audio", { src: url, controls: true, preload: "metadata" }));
  if (cat === "pdf") return body.append(h("iframe", { class: "preview-frame", src: url, title: entry.name }));
  if (cat === "archive") {
    const res = await get("/api/archive/list", { path: entry.path, limit: 300 }).catch(() => null);
    if (stale()) return;
    body.append(bigIcon(entry));
    if (res) {
      body.append(h("p", { class: "muted center" }, `${res.count.toLocaleString()} entries`),
        h("ul", { class: "archive-list" }, res.items.slice(0, 300).map((i) => h("li", {}, i.name))));
    }
    return;
  }
  if (!isText(entry) && entry.size > 0) {
    // unknown binary: peek to see if it is actually text
    const peek = await get("/api/text", { path: entry.path, mode: "head", n: 1 }).catch(() => null);
    if (stale()) return;
    if (!peek || peek.binary) return body.append(bigIcon(entry));
  }

  const rich = entry.size <= RICH_LIMIT;
  if (rich && (ext === "md" || ext === "markdown" || ext === "ipynb" || ext === "json")) {
    const text = await (await fetch(url)).text();
    if (stale()) return;
    const box = h("div", { class: "preview-rich" });
    body.append(box);
    if (ext === "ipynb") renderNotebook(box, text, entry.path);
    else if (ext === "json") renderJson(box, text, { collapsedDepth: 2 });
    else renderMarkdown(box, text, entry.path);
    return;
  }
  const res = await get("/api/text", { path: entry.path, mode: "head", n: PREVIEW_LINES });
  if (stale()) return;
  const text = res.lines.map((l) => l.t).join("\n");
  const box = h("div", { class: "preview-text" });
  body.append(box);
  if (ext === "csv" || ext === "tsv") return renderCsv(box, text, { delim: ext === "tsv" ? "\t" : ",", maxRows: 300 });
  renderCode(box, text, { lang: langFor(entry.name), lineNumbers: mode !== "column" });
  if (res.lines.length >= PREVIEW_LINES || res.truncated) {
    body.append(h("p", { class: "muted center" }, `First ${res.lines.length} lines of ${fmtSize(res.size)}`));
  }
}
