// Syntax-highlighted code with line numbers (highlight.js is a global from vendor/).
import { extOf, h } from "../util.js";

const LANG = {
  py: "python", pyi: "python", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", json: "json", jsonl: "json", ipynb: "json", md: "markdown", markdown: "markdown",
  yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini", sh: "bash", bash: "bash", zsh: "bash",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cxx: "cpp", cu: "cpp", cuh: "cpp", java: "java", kt: "kotlin",
  go: "go", rs: "rust", rb: "ruby", pl: "perl", php: "php", lua: "lua", r: "r", jl: "julia", sql: "sql", css: "css",
  scss: "scss", less: "less", html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml", diff: "diff", patch: "diff",
  dockerfile: "dockerfile", makefile: "makefile", cmake: "cmake", swift: "swift", scala: "scala", tex: "latex",
  proto: "protobuf", properties: "properties", tf: "ini", hcl: "ini", m: "objectivec", log: "accesslog",
};

export function langFor(name) {
  const lower = name.toLowerCase();
  if (lower === "makefile") return "makefile";
  if (lower === "dockerfile" || lower.endsWith(".dockerfile")) return "dockerfile";
  if (lower === "cmakelists.txt") return "cmake";
  if ([".bashrc", ".zshrc", ".profile", ".bash_profile"].includes(lower)) return "bash";
  return LANG[extOf(name)] || null;
}

const HIGHLIGHT_LIMIT = 1 << 20; // ~1 MB: beyond this, plain text keeps the tab responsive

/** Render code. opts: {lang, lineNumbers=true, startLine=1, wrap=false} */
export function renderCode(container, text, opts = {}) {
  const { lang, lineNumbers = true, startLine = 1, wrap = false } = opts;
  container.classList.add("code-view");
  container.classList.toggle("wrap", wrap);
  const code = h("code", { class: "hljs" });
  if (lang && window.hljs && text.length < HIGHLIGHT_LIMIT && hljs.getLanguage(lang)) {
    try { code.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; }
    catch { code.textContent = text; }
  } else code.textContent = text;
  const n = text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
  const gutter = lineNumbers ? h("pre", { class: "gutter", "aria-hidden": "true" }) : null;
  if (gutter) {
    const nums = new Array(n);
    for (let i = 0; i < n; i++) nums[i] = startLine + i;
    gutter.textContent = nums.join("\n");
  }
  container.replaceChildren(h("div", { class: "code-wrap" }, gutter, h("pre", { class: "code" }, code)));
}
