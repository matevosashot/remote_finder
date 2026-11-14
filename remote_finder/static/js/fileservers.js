// File servers (like `python -m http.server`): the start dialog, the server window with its log,
// and the live list the sidebar shows. A WebSocket per tab tells the backend this tab is still open.
import { get, post, wsUrl } from "./api.js";
import { modal, toast, toastError } from "./dialogs.js";
import { navigate } from "./nav.js";
import { emit, state } from "./state.js";
import { copyText, fmtSize, h, openTab, store } from "./util.js";

/** This tab's id: kept across reloads of the tab (so a reload doesn't stop its servers), new for each tab. */
export const tabId = (() => {
  const make = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    let id = sessionStorage.getItem("remote-finder.tab");
    if (!id) sessionStorage.setItem("remote-finder.tab", (id = make()));
    return id;
  } catch { return make(); }
})();

/** Keep the presence socket open; it also delivers the server list and stop notices. */
export function connectFileServers() {
  let delay = 1000;
  const open = () => {
    const ws = new WebSocket(wsUrl("/ws/fileservers", { tab: tabId }));
    ws.onopen = () => { delay = 1000; };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.servers) {
        state.fileServers = m.servers;
        state.fileServersAt = Date.now();
        emit("fileservers");
      }
      for (const s of m.stopped || []) {
        if (s.reason !== "stopped") toast(`File server :${s.port} (${s.name}) stopped: ${s.reason}`, { timeout: 10000 });
      }
    };
    ws.onclose = () => { setTimeout(open, delay); delay = Math.min(delay * 2, 30000); };
  };
  open();
}

/** Seconds until an idle server stops, counted down locally since the last list. */
export function idleLeft(s) {
  if (s.idle_limit == null || s.idle_left == null) return null;
  return Math.max(0, s.idle_left - (Date.now() - (state.fileServersAt || Date.now())) / 1000);
}

export const fmtLeft = (sec) => (sec >= 90 ? `${Math.round(sec / 60)} min` : `${Math.ceil(sec)} s`);

export const stopServer = (id) => post(`/api/fileservers/${id}/stop`).catch(toastError);

const OPTS_KEY = "fileserver.opts";

/** "File Server Here…": pick port, interface and stop rules, then start and show the server window. */
export async function startDialog(dir, file = null) {
  const o = { port: 8000, host: "0.0.0.0", idle_min: 10, stop_with_tab: true, cors: false, ...store.get(OPTS_KEY, {}) };
  const already = state.fileServers.find((s) => s.root === dir);
  let submit;
  const opts = await modal((close) => {
    const port = h("input", { class: "text fs-port", type: "number", min: 1, max: 65535, value: String(o.port) });
    const warn = h("div", { class: "fs-note" }, "Anyone who can reach this machine can read every file in this folder.");
    warn.hidden = o.host !== "0.0.0.0";
    const radio = (value, label) => h("label", { class: "check" },
      h("input", { type: "radio", name: "fs-host", value, checked: o.host === value,
        onchange: () => { o.host = value; warn.hidden = value !== "0.0.0.0"; } }), label);
    const idle = h("select", { class: "text fs-idle" },
      [[10, "10 min unused"], [60, "1 hour unused"], [0, "Never"]].map(([v, label]) =>
        h("option", { value: String(v), selected: (o.idle_min || 0) === v }, label)));
    const withTab = h("input", { type: "checkbox", checked: o.stop_with_tab });
    const cors = h("input", { type: "checkbox", checked: o.cors });
    submit = () => {
      const n = Number(port.value);
      if (!Number.isInteger(n) || n < 1 || n > 65535) { port.focus(); port.select(); return; }
      close({ port: n, host: o.host, idle_min: Number(idle.value) || null, stop_with_tab: withTab.checked, cors: cors.checked });
    };
    return [
      h("h3", {}, "File Server Here"),
      h("table", { class: "info-table fs-form" },
        h("tr", {}, h("th", {}, "Folder"), h("td", {}, dir)),
        file ? h("tr", {}, h("th", {}, "Opens"), h("td", {}, file)) : null,
        h("tr", {}, h("th", {}, "Port"), h("td", {}, port)),
        h("tr", {}, h("th", {}, "Listen on"), h("td", {}, radio("0.0.0.0", "0.0.0.0 (all interfaces)"), radio("127.0.0.1", "localhost only"), warn)),
        h("tr", {}, h("th", {}, "Stop after"), h("td", {}, idle)),
        h("tr", {}, h("th", {}, ""), h("td", {},
          h("label", { class: "check" }, withTab, "Stop when this tab closes"),
          h("label", { class: "check" }, cors, "Allow cross-origin requests (CORS)")))),
      already ? h("p", { class: "fs-note" }, `Already serving this folder on :${already.port}. `,
        h("button", { class: "btn small", onclick: () => { close(null); serverWindow(already.id); } }, "Show It")) : null,
      h("div", { class: "dialog-buttons" },
        h("button", { class: "btn", onclick: () => close(null) }, "Cancel"),
        h("button", { class: "btn primary", autofocus: true, onclick: () => submit() }, "Start")),
    ];
  }, { onKey: (e) => { if (e.key === "Enter" && e.target.tagName !== "BUTTON") { e.preventDefault(); submit(); } } });
  if (!opts) return;
  store.set(OPTS_KEY, opts);
  try {
    const s = await post("/api/fileservers", { path: dir, open: file, tab: tabId, ...opts });
    if (s.note) toast(s.note, { timeout: 6000 });
    serverWindow(s.id);
  } catch (e) { toastError(e); }
}

const time = (t) => new Date(t * 1000).toLocaleTimeString([], { hour12: false });

/** The server's URLs, tunnel command, counters and a live request log. Closing it keeps the server running. */
export function serverWindow(id) {
  let after = 0, timer = null, closed = false;
  const title = h("h3", {});
  const urls = h("table", { class: "info-table fs-urls" });
  const status = h("div", { class: "fs-status" });
  const log = h("div", { class: "fs-log" }, h("div", { class: "fs-log-empty" }, "No requests yet."));
  const stopBtn = h("button", { class: "btn", onclick: () => stopServer(id) }, "Stop Server");
  let root = null;
  let shownUrls = false;

  const render = (s) => {
    root = s.root;
    title.textContent = `File server :${s.port} · ${s.name}`;
    if (!shownUrls) {
      shownUrls = true;
      const row = (label, text, open) => h("tr", {}, h("th", {}, label), h("td", {}, h("code", {}, text)),
        h("td", { class: "fs-actions" },
          h("button", { class: "btn small", onclick: () => copyText(text).then(() => toast("Copied")) }, "Copy"),
          open ? h("button", { class: "btn small", onclick: () => openTab(text) }, "Open") : null));
      urls.replaceChildren(...s.urls.map((u) => row(u.label, u.url, true)), row("SSH tunnel", s.tunnel, false));
    }
    const left = s.running && s.idle_limit != null ? Math.max(0, s.idle_left) : null;
    status.replaceChildren(s.running
      ? `Serving ${s.root} on ${s.host}:${s.port} · ${s.requests} request${s.requests === 1 ? "" : "s"} · ${fmtSize(s.bytes)} sent`
        + (left != null ? ` · stops after ${s.idle_limit / 60} min unused (in ${fmtLeft(left)})` : " · no idle stop")
        + (s.stop_with_tab ? (s.owner_tab === tabId ? " · stops when this tab closes" : " · stops when its tab closes") : "")
      : h("span", { class: "fs-stopped" }, `Stopped: ${s.reason}`));
    stopBtn.disabled = !s.running;
  };

  const poll = async () => {
    if (closed) return;
    try {
      const r = await get(`/api/fileservers/${id}/log`, { after });
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
      if (r.lines.length) log.querySelector(".fs-log-empty")?.remove();
      for (const l of r.lines) {
        const bad = l.status >= 400 || l.status == null;
        log.append(h("div", { class: `fs-log-line ${bad ? "bad" : ""}` },
          h("span", { class: "fs-t" }, time(l.t)), h("span", { class: "fs-c" }, l.client),
          h("span", { class: "fs-l" }, l.line), h("span", { class: "fs-s" }, l.status ?? "")));
        after = l.n;
      }
      if (atBottom) log.scrollTop = log.scrollHeight;
      render(r.server);
      if (!r.server.running) return;
    } catch (e) {
      status.replaceChildren(h("span", { class: "fs-stopped" }, String(e.message || e)));
      return;
    }
    timer = setTimeout(poll, 1000);
  };

  modal((close) => [
    title, urls, status, log,
    h("div", { class: "dialog-buttons" },
      stopBtn,
      h("button", { class: "btn", onclick: () => { close(); if (root) navigate(root); } }, "Show in Finder"),
      h("button", { class: "btn primary", autofocus: true, onclick: () => close() }, "Close")),
  ], { cls: "wide fs-window" }).then(() => { closed = true; clearTimeout(timer); });
  poll();
}
