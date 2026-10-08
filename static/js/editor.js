// CodeMirror 5 editor: Ctrl/Cmd+S saves atomically; warns if the file changed on disk.
import { ApiError, get, post, rawUrl, viewerUrl } from "./api.js";
import { modal, toastError } from "./dialogs.js";
import { showPath } from "./pathbar.js";
import { $, EDIT_LIMIT, K, basename, extOf, fmtSize, h, openTab } from "./util.js";

const path = new URLSearchParams(location.search).get("path");
const MODES = {
  py: "python", pyi: "python", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: { name: "javascript", typescript: true }, tsx: { name: "javascript", typescript: true },
  json: { name: "javascript", json: true }, jsonl: { name: "javascript", json: true }, ipynb: { name: "javascript", json: true },
  md: "gfm", markdown: "gfm", yaml: "yaml", yml: "yaml", toml: "toml", sh: "shell", bash: "shell", zsh: "shell",
  sql: "sql", c: "text/x-csrc", h: "text/x-csrc", cc: "text/x-c++src", cpp: "text/x-c++src", hpp: "text/x-c++src",
  cu: "text/x-c++src", java: "text/x-java", kt: "text/x-kotlin", scala: "text/x-scala", go: "go", rs: "rust",
  html: "htmlmixed", htm: "htmlmixed", xml: "xml", svg: "xml", css: "css", scss: "text/x-scss", less: "text/x-less",
  ini: "properties", cfg: "properties", conf: "properties", properties: "properties", env: "properties",
  diff: "diff", patch: "diff", lua: "lua", r: "r", jl: "julia", pl: "perl", rb: "ruby", cmake: "cmake",
  dockerfile: "dockerfile",
};
const modeFor = (name) => {
  const lower = name.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "cmakelists.txt") return "cmake";
  if ([".bashrc", ".zshrc", ".profile", ".bash_profile"].includes(lower)) return "shell";
  if (lower.includes("nginx") && lower.endsWith(".conf")) return "nginx";
  return MODES[extOf(name)] || null;
};

let cm, mtime, clean, saving = false;
const dark = matchMedia("(prefers-color-scheme: dark)").matches;

async function init() {
  document.title = `${basename(path)} — Edit`;
  showPath(path);
  let st;
  try { st = await get("/api/stat", { path }); } catch (e) { return fail(e.message); }
  if (st.kind !== "file") return fail("Not a regular file");
  if (st.size > EDIT_LIMIT) return fail(`File is ${fmtSize(st.size)}; the editor opens files up to 10 MB. Use the viewer or head/tail tool.`);
  const text = await (await fetch(rawUrl(path))).text();
  if (text.includes("\u0000")) return fail("This looks like a binary file.");
  mtime = st.mtime_ns;
  $("#meta").textContent = `  ${fmtSize(st.size)}${st.writable ? "" : " · read-only"}`;
  cm = CodeMirror($("#host"), {
    value: text,
    mode: modeFor(st.name),
    lineNumbers: true,
    lineWrapping: false,
    indentUnit: extOf(st.name) === "py" ? 4 : 2,
    tabSize: 4,
    indentWithTabs: /^\t/m.test(text) && !/^ {2,}\S/m.test(text),
    lineSeparator: text.includes("\r\n") ? "\r\n" : null,
    matchBrackets: true,
    autoCloseBrackets: true,
    styleActiveLine: true,
    theme: dark ? "material-darker" : "default",
    extraKeys: {
      "Ctrl-S": save, "Cmd-S": save,
      Tab: (c) => (c.somethingSelected() ? c.indentSelection("add") : c.replaceSelection(c.getOption("indentWithTabs") ? "\t" : " ".repeat(c.getOption("indentUnit")))),
      "Shift-Tab": (c) => c.indentSelection("subtract"),
    },
  });
  clean = cm.changeGeneration();
  cm.on("change", () => { $("#dirty").hidden = cm.isClean(clean); });
  const wrapBtn = h("button", { class: "btn small", onclick: () => { cm.setOption("lineWrapping", !cm.getOption("lineWrapping")); wrapBtn.classList.toggle("on"); } }, "Wrap");
  $("#actions").append(wrapBtn,
    h("button", { class: "btn small", onclick: () => openTab(viewerUrl(path)) }, "View"),
    h("button", { class: "btn small primary", onclick: save, title: `${K.mod}S` }, "Save"));
  if (!st.writable) msg("Read-only: you can edit, but saving will fail");
  cm.focus();
}

function fail(m) {
  $("#host").replaceChildren(h("p", { class: "page-msg" }, m, " ", h("a", { href: viewerUrl(path) }, "Open in viewer")));
}

function msg(t) {
  $("#msg").textContent = t;
}

async function save(force = false) {
  if (!cm || saving) return;
  saving = true;
  const gen = cm.changeGeneration();
  try {
    const res = await post("/api/save", { path, content: cm.getValue(), mtime_ns: mtime, force: force === true });
    mtime = res.mtime_ns;
    clean = gen;
    $("#dirty").hidden = cm.isClean(clean);
    msg(`Saved ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      const choice = await modal((close) => [
        h("h3", {}, "The file changed on disk"),
        h("p", {}, "Someone (or something) modified this file after you opened it."),
        h("div", { class: "dialog-buttons" },
          h("button", { class: "btn", onclick: () => close("cancel") }, "Cancel"),
          h("button", { class: "btn", onclick: () => close("reload") }, "Discard Mine & Reload"),
          h("button", { class: "btn primary danger", onclick: () => close("overwrite") }, "Overwrite")),
      ]);
      saving = false;
      if (choice === "overwrite") return save(true);
      if (choice === "reload") { clean = cm.changeGeneration(); location.reload(); }
      return;
    }
    toastError(e);
  } finally {
    saving = false;
  }
}

window.addEventListener("beforeunload", (e) => {
  if (cm && !cm.isClean(clean)) { e.preventDefault(); e.returnValue = ""; }
});

init();
