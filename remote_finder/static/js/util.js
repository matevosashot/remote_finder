// Small shared helpers.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function fmtSize(n) {
  if (n == null) return "--";
  if (n < 1000) return `${n} bytes`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let i = -1;
  do { n /= 1000; i++; } while (n >= 1000 && i < units.length - 1);
  return `${n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)} ${units[i]}`;
}

const dtFull = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const dtTime = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
export function fmtDate(sec) {
  if (!sec) return "--";
  const d = new Date(sec * 1000);
  const now = new Date();
  const day = 864e5;
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= startToday) return `Today at ${dtTime.format(d)}`;
  if (d.getTime() >= startToday - day) return `Yesterday at ${dtTime.format(d)}`;
  return dtFull.format(d);
}
export const fmtDateFull = (sec) => (sec ? new Date(sec * 1000).toLocaleString() : "--");

export const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// ---------------------------------------------------------------- paths (absolute, normalized)

export const join = (dir, name) => (dir === "/" ? "/" + name : dir + "/" + name);
export const dirname = (p) => (p === "/" ? "/" : p.replace(/\/[^/]*$/, "") || "/");
export const basename = (p) => (p === "/" ? "/" : p.slice(p.lastIndexOf("/") + 1));
/** `path` is `dir` or somewhere below it. */
export const isInside = (path, dir) => path === dir || path.startsWith(dir === "/" ? "/" : dir + "/");
/** "/a/b/c" -> ["/", "/a", "/a/b", "/a/b/c"] */
export function ancestors(path) {
  const out = ["/"];
  let acc = "";
  for (const part of path.split("/").filter(Boolean)) out.push((acc += "/" + part));
  return out;
}
/** The child of `dir` on the way to `path` ("/a", "/a/b/c" -> "/a/b"), or null if `path` isn't below `dir`. */
export function childToward(dir, path) {
  if (path === dir || !isInside(path, dir)) return null;
  return join(dir, path.slice(dir === "/" ? 1 : dir.length + 1).split("/")[0]);
}
export function extOf(name) {
  const lower = name.toLowerCase();
  for (const e of [".tar.gz", ".tar.xz", ".tar.zst", ".tar.bz2"]) if (lower.endsWith(e)) return e.slice(1);
  const i = lower.lastIndexOf(".");
  return i > 0 ? lower.slice(i + 1) : "";
}
export function stemLength(name) {
  const e = extOf(name);
  return e && !name.startsWith(".") ? name.length - e.length - 1 : name.length;
}

export const debounce = (fn, ms) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

const CATS = {
  image: "png jpg jpeg gif webp bmp ico tif tiff avif heic svg",
  video: "mp4 webm mkv mov avi m4v ogv",
  audio: "mp3 wav flac ogg oga m4a aac opus",
  archive: "zip tar gz tgz xz txz bz2 tbz2 zst tzst 7z rar tar.gz tar.xz tar.zst tar.bz2",
  pdf: "pdf",
  code: "py pyi js mjs cjs ts tsx jsx c h cc cpp hpp cxx cu cuh java kt go rs rb pl php lua r jl sql sh bash zsh fish css scss less html htm xml vue svelte swift scala m tf hcl proto cmake dockerfile",
  data: "json jsonl ndjson yaml yml toml ini cfg conf env csv tsv ipynb lock properties",
  doc: "md markdown rst txt log tex bib srt vtt diff patch",
};
const CAT_OF = {};
for (const [c, list] of Object.entries(CATS)) for (const e of list.split(" ")) CAT_OF[e] = c;

export function category(entry) {
  if (entry.kind === "dir") return "folder";
  const e = extOf(entry.name);
  if (CAT_OF[e]) return CAT_OF[e];
  if (entry.text) return "doc";
  return "file";
}

const KIND_LABELS = {
  py: "Python Source", js: "JavaScript", ts: "TypeScript", json: "JSON", jsonl: "JSON Lines", md: "Markdown",
  txt: "Plain Text", log: "Log File", csv: "CSV", tsv: "TSV", yaml: "YAML", yml: "YAML", toml: "TOML",
  sh: "Shell Script", html: "HTML", css: "CSS", ipynb: "Jupyter Notebook", pdf: "PDF Document",
  zip: "ZIP Archive", "tar.gz": "Gzip Tarball", "tar.xz": "XZ Tarball", "tar.zst": "Zstd Tarball",
  gz: "Gzip Archive", xz: "XZ Archive", zst: "Zstd Archive", tar: "Tar Archive", png: "PNG Image",
  jpg: "JPEG Image", jpeg: "JPEG Image", gif: "GIF Image", svg: "SVG Image", webp: "WebP Image",
  mp4: "MPEG-4 Movie", mp3: "MP3 Audio", wav: "WAV Audio", c: "C Source", cpp: "C++ Source", h: "C Header",
  go: "Go Source", rs: "Rust Source", java: "Java Source", sql: "SQL", xml: "XML", ini: "Config",
  cfg: "Config", conf: "Config",
};
export function kindLabel(entry) {
  if (entry.kind === "dir") return entry.link ? "Folder Alias" : "Folder";
  if (entry.broken) return "Broken Alias";
  if (entry.kind !== "file") return entry.kind[0].toUpperCase() + entry.kind.slice(1);
  const e = extOf(entry.name);
  const label = KIND_LABELS[e] || (e ? `${e.toUpperCase()} File` : entry.text ? "Text" : "Document");
  return entry.link ? `${label} (alias)` : label;
}

export const isImage = (entry) => entry.kind === "file" && category(entry) === "image";
export const isArchive = (entry) => entry.kind === "file" && category(entry) === "archive";
export const isText = (entry) => entry.kind === "file" && (entry.text || ["code", "data", "doc"].includes(category(entry)));
export const thumbable = (entry) => isImage(entry) && !/\.svg$/i.test(entry.name);
export const EDIT_LIMIT = 10 << 20; // the editor opens text files up to 10 MB
export const canEdit = (entry) => !!entry && isText(entry) && entry.size <= EDIT_LIMIT;

// ---------------------------------------------------------------- browser helpers

export const openTab = (url) => window.open(url, "_blank");

/** Follow a link the way a click would (downloads keep the page in place). */
export function clickLink(href, download = "") {
  const a = h("a", { href, download });
  document.body.append(a);
  a.click();
  a.remove();
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  clickLink(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** localStorage with a namespace and JSON values; never throws (private mode, quota). */
export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`remote-finder.${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`remote-finder.${key}`, JSON.stringify(value)); } catch {}
  },
};

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h("textarea", { style: { position: "fixed", opacity: "0" } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
/** Mod = Ctrl or Cmd: both count, so Mac and Linux/Windows keyboards work alike. */
export const mod = (e) => e.ctrlKey || e.metaKey;
/** Shortcut labels for menus and tooltips: `${K.mod}C` is "⌘C" on a Mac, "Ctrl+C" elsewhere. */
export const K = isMac ? { mod: "⌘", alt: "⌥", shift: "⇧" } : { mod: "Ctrl+", alt: "Alt+", shift: "Shift+" };
