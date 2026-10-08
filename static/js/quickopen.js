// Ctrl+P quick open: fuzzy match over a bounded walk of the current folder.
import { entryUrl, get } from "./api.js";
import { modal } from "./dialogs.js";
import { iconFor } from "./icons.js";
import { navigate } from "./nav.js";
import { state } from "./state.js";
import { K, basename, dirname, esc, h, join, mod, openTab } from "./util.js";

const cache = new Map(); // root -> {at, paths, truncated}

async function pathsUnder(root) {
  const c = cache.get(root);
  if (c && Date.now() - c.at < 60_000) return c;
  const res = await get("/api/walk", { root, hidden: state.showHidden });
  const v = { at: Date.now(), paths: res.paths, truncated: res.truncated };
  cache.set(root, v);
  return v;
}

/** Subsequence fuzzy score; higher is better. Returns null if no match. Also returns matched indices. */
export function fuzzy(query, text) {
  const q = query.toLowerCase(), t = text.toLowerCase();
  const nameStart = t.lastIndexOf("/", t.length - 2) + 1;

  // greedy left-to-right matching from `from`
  const scan = (from) => {
    let qi = 0, score = 0, prev = -2;
    const idx = [];
    for (let i = from; i < t.length && qi < q.length; i++) {
      if (t[i] !== q[qi]) continue;
      let s = 1;
      if (i === prev + 1) s += 4;                              // consecutive
      if (i === 0 || "/_-. ".includes(t[i - 1])) s += 3;       // word start
      if (i >= nameStart) s += 2;                              // inside the basename
      if (text[i] === query[qi]) s += 0.5;                     // exact case
      score += s;
      idx.push(i);
      prev = i;
      qi++;
    }
    if (qi < q.length) return null;
    return { score: score - (idx[0] || 0) * 0.05, idx };      // prefer early matches
  };

  // Matching from the start can spend the query on folder names ("logs/eval.log" -> the "log" of
  // "logs"), so also try starting at each occurrence of the first letter inside the basename.
  let best = scan(0);
  if (!best) return null;
  for (let i = t.indexOf(q[0], nameStart); i >= 0; i = t.indexOf(q[0], i + 1)) {
    const m = scan(i);
    if (!m) break; // later starts can't match either
    if (m.score > best.score) best = m;
  }
  best.score -= t.length * 0.02;                               // prefer short paths
  if (t.slice(nameStart).replace(/\/$/, "").startsWith(q)) best.score += 6;
  return best;
}

function highlight(text, idx) {
  const set = new Set(idx);
  return [...text].map((c, i) => (set.has(i) ? `<mark>${esc(c)}</mark>` : esc(c))).join("");
}

export async function quickOpen() {
  const root = state.path;
  let data = null;
  const input = h("input", { class: "text qo-input", placeholder: `Go to file or folder in ${root}…`, spellcheck: false, autofocus: true });
  const list = h("div", { class: "qo-list" });
  const status = h("div", { class: "qo-status muted" }, "Indexing…");
  let results = [], cur = 0;

  const draw = () => {
    list.replaceChildren(...results.map((r, i) => {
      const isDir = r.p.endsWith("/");
      const name = basename(r.p.replace(/\/$/, ""));
      const entry = { name, kind: isDir ? "dir" : "file" };
      const nameStart = r.p.replace(/\/$/, "").lastIndexOf("/") + 1;
      const el = h("div", { class: `qo-item ${i === cur ? "cur" : ""}`, onmousemove: () => { if (cur !== i) { cur = i; draw(); } } },
        h("span", { class: "qo-icon", html: iconFor(entry) }),
        h("span", { class: "qo-name", html: highlight(name, r.idx.filter((x) => x >= nameStart).map((x) => x - nameStart)) }),
        h("span", { class: "qo-dir muted" }, dirname("/" + r.p.replace(/\/$/, "")).slice(1)));
      el.addEventListener("click", (e) => choose(i, e));
      return el;
    }));
    list.children[cur]?.scrollIntoView({ block: "nearest" });
  };

  const search = () => {
    if (!data) return;
    const q = input.value.trim();
    if (!q) {
      results = data.paths.slice(0, 50).map((p) => ({ p, idx: [] }));
    } else {
      const scored = [];
      for (const p of data.paths) {
        const m = fuzzy(q, p);
        if (m) scored.push({ p, ...m });
      }
      scored.sort((a, b) => b.score - a.score);
      results = scored.slice(0, 50);
    }
    cur = 0;
    status.textContent = `${data.paths.length.toLocaleString()} items${data.truncated ? " (limited)" : ""} · Enter open · ${K.mod}Enter new tab · ${K.alt}Enter reveal`;
    draw();
  };

  let closeFn;
  const choose = (i, e) => {
    const r = results[i];
    if (!r) return;
    const entry = { path: join(root, r.p.replace(/\/$/, "")), kind: r.p.endsWith("/") ? "dir" : "file" };
    closeFn();
    if (e?.altKey) return navigate(dirname(entry.path), { select: entry.path });
    if (entry.kind === "dir" && !(e && mod(e))) return navigate(entry.path);
    openTab(entryUrl(entry)); // files always open in a tab; Mod+Enter opens folders in one too
  };

  input.addEventListener("input", search);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); cur = Math.min(results.length - 1, cur + 1); draw(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); cur = Math.max(0, cur - 1); draw(); }
    else if (e.key === "Enter") { e.preventDefault(); choose(cur, e); }
  });

  pathsUnder(root).then((d) => { data = d; search(); }).catch((e) => (status.textContent = String(e.message || e)));
  await modal((close) => { closeFn = close; return [input, list, status]; }, { cls: "quickopen" });
}
