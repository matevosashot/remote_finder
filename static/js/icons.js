// Inline SVG icons (Finder-like). Each returns markup sized to its container.
import { category, extOf } from "./util.js";

const folder = (accent = "#61a8f4", tab = "#4e95e3") => `
<svg viewBox="0 0 64 64" class="ico"><path d="M6 14a4 4 0 0 1 4-4h14l5 5h25a4 4 0 0 1 4 4v3H6z" fill="${tab}"/>
<path d="M6 20h52a2 2 0 0 1 2 2v28a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V22a2 2 0 0 1 2-2z" fill="${accent}"/>
<path d="M4 24h56" stroke="#ffffff55" stroke-width="1.5"/></svg>`;

const doc = (color, label = "", glyph = "") => `
<svg viewBox="0 0 64 64" class="ico"><path d="M14 4h26l14 14v40a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="var(--doc-bg)" stroke="var(--doc-stroke)" stroke-width="1.5"/>
<path d="M40 4v12a2 2 0 0 0 2 2h12" fill="var(--doc-fold)" stroke="var(--doc-stroke)" stroke-width="1.5"/>
${glyph}
${label ? `<rect x="12" y="40" width="${Math.max(18, label.length * 6 + 8)}" height="13" rx="2.5" fill="${color}"/><text x="${12 + Math.max(18, label.length * 6 + 8) / 2}" y="50" font-size="9" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif" font-weight="700" fill="#fff" text-anchor="middle">${label}</text>` : ""}
</svg>`;

const lines = (c = "var(--doc-lines)") => `<g stroke="${c}" stroke-width="2.2" stroke-linecap="round"><path d="M20 22h20M20 28h24M20 34h16"/></g>`;
const glyphs = {
  image: `<g><rect x="19" y="18" width="28" height="20" rx="2" fill="#8fd18f"/><circle cx="27" cy="25" r="3" fill="#fff"/><path d="M19 36l9-8 6 5 5-4 8 7v2H19z" fill="#3e9b52"/></g>`,
  video: `<g><rect x="18" y="18" width="30" height="20" rx="3" fill="#7a6ff0"/><path d="M30 23l8 5-8 5z" fill="#fff"/></g>`,
  audio: `<g fill="#ef5b8d"><path d="M28 18l16-3v18a4 4 0 1 1-3-3.9V20l-10 2v14a4 4 0 1 1-3-3.9z"/></g>`,
  archive: `<g fill="#a07a50"><rect x="30" y="8" width="6" height="4"/><rect x="30" y="16" width="6" height="4"/><rect x="30" y="24" width="6" height="4"/><rect x="27" y="30" width="12" height="9" rx="2"/></g>`,
  code: `<g stroke="#5b8def" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M26 20l-7 7 7 7M40 20l7 7-7 7M35 17l-4 20"/></g>`,
  pdf: `<g fill="#e5483f"><path d="M22 34c4-6 8-14 9-18 1 5 4 12 10 16-5 0-12 1-19 2zm0 0c-2 3-4 4-4 2s4-3 4-2z" opacity=".85"/></g>`,
};
const LABELS = { py: "PY", js: "JS", ts: "TS", json: "JSON", md: "MD", csv: "CSV", tsv: "TSV", yaml: "YAML", yml: "YML",
  toml: "TOML", sh: "SH", html: "HTML", css: "CSS", ipynb: "IPYNB", txt: "TXT", log: "LOG", c: "C", cpp: "C++", h: "H",
  go: "GO", rs: "RS", java: "JAVA", sql: "SQL", xml: "XML", zip: "ZIP", "tar.gz": "TGZ", "tar.xz": "TXZ",
  "tar.zst": "TZST", gz: "GZ", xz: "XZ", zst: "ZST", tar: "TAR", pdf: "PDF", jsonl: "JSONL", ini: "INI", cfg: "CFG",
  conf: "CONF", rb: "RB", lua: "LUA", r: "R", jl: "JL", tex: "TEX", diff: "DIFF", patch: "DIFF", svg: "SVG",
  mp4: "MP4", mov: "MOV", mkv: "MKV", webm: "WEBM", mp3: "MP3", wav: "WAV", flac: "FLAC" };
const COLORS = { code: "#4a7fe0", data: "#2f9e8f", doc: "#8a8f98", archive: "#a07a50", image: "#3e9b52",
  video: "#7a6ff0", audio: "#e2457a", pdf: "#e5483f", file: "#8a8f98" };

export function iconFor(entry) {
  if (entry.kind === "dir") {
    const n = entry.name.toLowerCase();
    if (entry.path === "/" || entry.name === "/") return folder("#9aa3ad", "#87909a");
    if (n === ".git" || n === "node_modules" || n === "__pycache__") return folder("#9fc6f0", "#8ab5e4");
    return folder();
  }
  if (entry.kind !== "file") return doc("#8a8f98", entry.kind.toUpperCase().slice(0, 4), lines());
  const cat = category(entry);
  const e = extOf(entry.name);
  const label = LABELS[e] || (e && e.length <= 5 ? e.toUpperCase() : "");
  const glyph = glyphs[cat] || lines();
  return doc(COLORS[cat] || COLORS.file, label, glyph);
}

export const ICONS = {
  back: `<svg viewBox="0 0 16 16"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  fwd: `<svg viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  icons: `<svg viewBox="0 0 16 16"><g fill="currentColor"><rect x="1.5" y="1.5" width="5" height="5" rx="1"/><rect x="9.5" y="1.5" width="5" height="5" rx="1"/><rect x="1.5" y="9.5" width="5" height="5" rx="1"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/></g></svg>`,
  list: `<svg viewBox="0 0 16 16"><g fill="currentColor"><rect x="1" y="2" width="14" height="2" rx="1"/><rect x="1" y="7" width="14" height="2" rx="1"/><rect x="1" y="12" width="14" height="2" rx="1"/></g></svg>`,
  columns: `<svg viewBox="0 0 16 16"><g fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="2" width="14" height="12" rx="1.5"/><path d="M5.7 2v12M10.3 2v12"/></g></svg>`,
  gallery: `<svg viewBox="0 0 16 16"><g fill="currentColor"><rect x="1" y="1.5" width="14" height="9" rx="1.5"/><rect x="1" y="12" width="3.5" height="2.5" rx=".5"/><rect x="6.25" y="12" width="3.5" height="2.5" rx=".5"/><rect x="11.5" y="12" width="3.5" height="2.5" rx=".5"/></g></svg>`,
  upload: `<svg viewBox="0 0 16 16"><path d="M8 11V2M4.5 5.5L8 2l3.5 3.5M2 11v2.5h12V11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  newfolder: `<svg viewBox="0 0 16 16"><path d="M1.5 4a1 1 0 0 1 1-1h3.5l1.5 1.5h6a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 7v4M6 9h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  terminal: `<svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4 6l2.5 2L4 10M8 10.5h4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  preview: `<svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="9.5" y="2" width="5.5" height="12" fill="currentColor" opacity=".55"/></svg>`,
  search: `<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  hidden: `<svg viewBox="0 0 16 16"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2.2" fill="currentColor"/></svg>`,
  more: `<svg viewBox="0 0 16 16"><g fill="currentColor"><circle cx="3.5" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="12.5" cy="8" r="1.4"/></g></svg>`,
  home: `<svg viewBox="0 0 16 16"><path d="M2 7.5L8 2.5l6 5V14H10V10H6v4H2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
  disk: `<svg viewBox="0 0 16 16"><rect x="1.5" y="4" width="13" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="11.5" cy="8" r="1" fill="currentColor"/></svg>`,
  root: `<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="9" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 14h6M8 11.5V14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  star: `<svg viewBox="0 0 16 16"><path d="M2 3.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`,
  dockBottom: `<svg viewBox="0 0 16 16"><rect x="1.5" y="2" width="13" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="1.5" y="9" width="13" height="5" fill="currentColor" opacity=".6"/></svg>`,
  dockRight: `<svg viewBox="0 0 16 16"><rect x="1.5" y="2" width="13" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="9" y="2" width="5.5" height="12" fill="currentColor" opacity=".6"/></svg>`,
  close: `<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  cd: `<svg viewBox="0 0 16 16"><path d="M2 8h9M8 4.5L11.5 8 8 11.5M14 3v10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  restart: `<svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  chevron: `<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  link: `<svg viewBox="0 0 16 16" class="badge-link"><rect width="16" height="16" rx="3" fill="#fff"/><path d="M5 11l6-6M6.5 5H11v4.5" fill="none" stroke="#222" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};
