// Terminal panel: xterm.js over /ws/terminal; dock bottom/right; drag to resize; state in localStorage.
import { wsUrl } from "./api.js";
import { toast } from "./dialogs.js";
import { ICONS } from "./icons.js";
import { state } from "./state.js";
import { h, store } from "./util.js";

const prefs = { dock: "bottom", size: 300, open: false, ...store.get("terminal", {}) };
const save = () => store.set("terminal", prefs);

let panel, host, term, fit, ws, title, dockBtn;
let pendingCd = null;

export function initTerminal(workspace) {
  panel = h("section", { class: "term-panel", hidden: true });
  const resizer = h("div", { class: "term-resizer" });
  title = h("span", { class: "term-title" }, "Terminal");
  dockBtn = h("button", { class: "tb-btn", title: "Move to side / bottom", onclick: toggleDock });
  host = h("div", { class: "term-host" });
  panel.append(resizer,
    h("div", { class: "term-bar" }, title,
      h("div", { class: "spacer" }),
      h("button", { class: "tb-btn", title: "cd to the current folder", html: ICONS.cd, onclick: () => cdTo(state.path) }),
      h("button", { class: "tb-btn", title: "Restart shell", html: ICONS.restart, onclick: restart }),
      dockBtn,
      h("button", { class: "tb-btn", title: "Hide (Ctrl+`)", html: ICONS.close, onclick: () => toggleTerminal(false) })),
    host);
  workspace.append(panel);
  applyDock();
  bindResize(resizer);
  if (prefs.open) toggleTerminal(true);
}

function applyDock() {
  const workspace = panel.parentElement;
  workspace.classList.toggle("dock-right", prefs.dock === "right");
  workspace.classList.toggle("dock-bottom", prefs.dock !== "right");
  panel.style.flexBasis = `${prefs.size}px`;
  dockBtn.innerHTML = prefs.dock === "right" ? ICONS.dockBottom : ICONS.dockRight;
  requestAnimationFrame(doFit);
}

function toggleDock() {
  prefs.dock = prefs.dock === "right" ? "bottom" : "right";
  prefs.size = prefs.dock === "right" ? Math.round(innerWidth * 0.4) : Math.round(innerHeight * 0.35);
  save();
  applyDock();
}

function bindResize(handle) {
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const start = prefs.dock === "right" ? e.clientX : e.clientY;
    const startSize = prefs.size;
    document.body.classList.add(prefs.dock === "right" ? "resizing-x" : "resizing-y");
    const move = (ev) => {
      const delta = start - (prefs.dock === "right" ? ev.clientX : ev.clientY);
      const max = (prefs.dock === "right" ? innerWidth : innerHeight) - 160;
      prefs.size = Math.max(120, Math.min(max, startSize + delta));
      panel.style.flexBasis = `${prefs.size}px`;
      doFit();
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing-x", "resizing-y");
      save();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

function doFit() {
  if (!term || panel.hidden) return;
  try { fit.fit(); } catch {}
}

function ensureTerm() {
  if (term) return;
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  term = new Terminal({
    fontFamily: '"SF Mono", Menlo, "JetBrains Mono", "DejaVu Sans Mono", Consolas, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    theme: dark
      ? { background: "#1e1e1e", foreground: "#e6e6e6", cursor: "#e6e6e6", selectionBackground: "#3a5d8f" }
      : { background: "#ffffff", foreground: "#1d1d1f", cursor: "#1d1d1f", selectionBackground: "#b3d1ff",
          black: "#1d1d1f", brightBlack: "#6e6e73", white: "#c7c7cc", brightWhite: "#f2f2f7",
          yellow: "#9a6b00", brightYellow: "#b07d00" },
  });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  // Ctrl+` toggles the panel even when the terminal has focus
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === "keydown" && e.ctrlKey && e.key === "`") { toggleTerminal(); return false; }
    return true;
  });
  term.onData((d) => send({ t: "i", d }));
  term.onResize(({ cols, rows }) => send({ t: "r", c: cols, r: rows }));
  new ResizeObserver(doFit).observe(host);
}

function send(m) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(m));
}

function connect(cwd) {
  ensureTerm();
  doFit();
  ws = new WebSocket(wsUrl("/ws/terminal", { cwd, cols: term.cols, rows: term.rows }));
  ws.binaryType = "arraybuffer";
  title.textContent = `Terminal — ${state.user}@${state.host}`;
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") return term.write(new Uint8Array(ev.data));
    const m = JSON.parse(ev.data);
    if (m.t === "busy") toast("Terminal is busy (a program is running) — not changing directory", { kind: "warn" });
    else if (m.t === "exit") {
      term.write(`\r\n\x1b[2m[process exited with code ${m.code} — press Enter to restart]\x1b[0m\r\n`);
      ws = null;
      const d = term.onData(() => { d.dispose(); restart(); });
    }
  };
  ws.onopen = () => {
    if (pendingCd) { send({ t: "cd", p: pendingCd }); pendingCd = null; }
  };
  ws.onclose = () => { if (ws) { ws = null; term.write("\r\n\x1b[2m[disconnected]\x1b[0m\r\n"); } };
}

function restart() {
  const old = ws;
  ws = null;
  old?.close();
  term?.reset();
  connect(state.path);
  term?.focus();
}

export function toggleTerminal(show = panel.hidden, cwd = state.path) {
  panel.hidden = !show;
  prefs.open = show;
  save();
  if (show) {
    if (!ws) connect(cwd);
    requestAnimationFrame(() => { doFit(); term.focus(); });
  } else document.querySelector(".view-bg")?.focus();
}

export function cdTo(path) {
  if (!ws || ws.readyState !== 1) { pendingCd = path; return; }
  send({ t: "cd", p: path });
  term.focus();
}

export function openTerminal(path) {
  if (!ws) return toggleTerminal(true, path); // a new shell starts right there
  if (panel.hidden) toggleTerminal(true);
  cdTo(path);
}
