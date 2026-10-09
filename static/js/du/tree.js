// Disk usage tree list: Folder / Size / Contents / Modified, with usage bars, virtualized.
import { collator, fmtSize, h } from "../util.js";
import { iconFor } from "../icons.js";
import { VirtualList } from "../virtual.js";
import { labelOf, sizeOf } from "./charts.js";

const ROW = 24;
const COLS = [["name", "Folder"], ["size", "Size"], ["items", "Contents"], ["mtime", "Modified"]];

export function relTime(sec) {
  if (!sec) return "";
  const s = Date.now() / 1000 - sec;
  const day = 86400;
  if (s < day) return "Today";
  if (s < 2 * day) return "Yesterday";
  if (s < 31 * day) return `${Math.floor(s / day)} days`;
  if (s < 365 * day) { const m = Math.floor(s / (30.4 * day)); return m === 1 ? "1 month" : `${m} months`; }
  const y = Math.floor(s / (365 * day));
  return y === 1 ? "1 year" : `${y} years`;
}

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const items = (d) => (d.kind === "dir" ? d.files + d.dirs : d.kind === "file" ? null : d.count);
const isExtra = (d) => d.kind === "rest" || d.kind === "others";

/**
 * Callbacks get the row's data object: onSelect(d, event), onOpen(d), onToggle(d),
 * onHover(d|null, event), onContext(d, event), onInclude(d)
 */
export class TreeList {
  constructor(host, callbacks) {
    this.cb = callbacks;
    this.sort = { key: "size", dir: -1 };
    this.rows = [];
    this.header = h("div", { class: "list-header" });
    this.scroller = h("div", { class: "list-scroll view-bg" });
    host.append(this.header, this.scroller);
    this.vl = new VirtualList(this.scroller, { rowHeight: ROW, count: 0, renderRow: (i) => this.row(i) });
    this.scroller.addEventListener("mouseleave", () => this.cb.onHover(null));
    this.renderHeader();
  }

  renderHeader() {
    this.header.replaceChildren(...COLS.map(([key, label]) => h("div", {
      class: `col col-${key} ${this.sort.key === key ? "sorted" : ""}`,
      onclick: () => {
        this.sort = this.sort.key === key ? { key, dir: -this.sort.dir } : { key, dir: key === "name" ? 1 : -1 };
        this.renderHeader();
        if (this.last) this.render(...this.last);
      },
    }, label, this.sort.key === key ? h("span", { class: "sort-arrow" }, this.sort.dir > 0 ? "▲" : "▼") : null)));
  }

  sorted(children, metric) {
    const { key, dir } = this.sort;
    const val = (d) => (key === "size" ? sizeOf(d, metric) : key === "items" ? items(d) ?? -1 : d.mtime || 0);
    const main = children.filter((d) => !isExtra(d));
    main.sort((a, b) => (key === "name" ? collator.compare(a.name, b.name) : val(a) - val(b)) * dir);
    return [...main, ...children.filter(isExtra)];
  }

  /** opts: {metric, expanded: Set, selected: Set, colors: Map(path -> css color)} */
  render(tree, opts) {
    this.last = [tree, opts];
    this.opts = opts;
    this.rows = [];
    const walk = (d, level, parent) => {
      this.rows.push({ d, level, parent });
      if (d.children && (level === 0 || opts.expanded.has(d.path))) {
        for (const c of this.sorted(d.children, opts.metric)) walk(c, level + 1, d);
      }
    };
    if (tree) walk(tree, 0, null);
    const top = this.scroller.scrollTop;
    this.vl.setCount(this.rows.length);
    this.scroller.scrollTop = top;
  }

  indexOf(path) { return this.rows.findIndex((r) => r.d.path === path); }

  scrollTo(path) {
    const i = this.indexOf(path);
    if (i >= 0) this.vl.scrollToRow(i);
  }

  setSelection(selected) {
    if (this.opts) this.opts.selected = selected;
    for (const el of this.scroller.querySelectorAll(".row[data-path]")) el.classList.toggle("sel", selected.has(el.dataset.path));
  }

  setHover(path) {
    this.scroller.querySelectorAll(".row.hover").forEach((el) => el.classList.remove("hover"));
    if (path) this.scroller.querySelector(`.row[data-path="${CSS.escape(path)}"]`)?.classList.add("hover");
  }

  row(i) {
    const { d, level, parent } = this.rows[i];
    const { metric, expanded, selected, colors } = this.opts;
    const size = sizeOf(d, metric);
    const share = parent ? size / Math.max(1, sizeOf(parent, metric)) : 1;
    const open = level === 0 || expanded.has(d.path);
    const badges = [];
    if (d.state === "mount") badges.push(h("span", { class: "du-badge" }, "other filesystem"),
      h("span", { class: "du-badge action", title: "Count this mount point too", onclick: (e) => { e.stopPropagation(); this.cb.onInclude(d); } }, "Scan"));
    else if (d.state === "skipped") badges.push(h("span", { class: "du-badge", title: "System folders (/proc, /sys, /dev, /run) are not counted" }, "not counted"),
      h("span", { class: "du-badge action", onclick: (e) => { e.stopPropagation(); this.cb.onInclude(d); } }, "Scan"));
    else if (d.state === "error") badges.push(h("span", { class: "du-badge", title: "This folder can't be read" }, "no permission"));
    const el = h("div", {
      class: `row ${i % 2 ? "odd" : ""} ${level === 0 ? "root" : ""} ${isExtra(d) ? "extra" : ""} ${d.path && selected.has(d.path) ? "sel" : ""}`,
      "data-path": d.path || null,
    },
    h("div", { class: "col col-name", style: { paddingLeft: `${8 + level * 16}px` } },
      h("span", {
        class: `disclosure ${d.expandable && level > 0 ? (open ? "open" : "") : "none"}`,
        onclick: (e) => { e.stopPropagation(); if (d.expandable && level > 0) this.cb.onToggle(d); },
      }),
      h("span", { class: "item-icon", html: iconFor(isExtra(d) ? { kind: "file", name: "" } : d) }),
      h("span", { class: "name", title: d.path || "" }, labelOf(d)),
      badges),
    h("div", { class: "col col-size" },
      h("div", { class: "du-bar", title: `${(share * 100).toFixed(1)}% of ${parent ? parent.name : "total"}` },
        h("div", { style: { width: `${Math.min(100, share * 100)}%`, background: (level && colors.get(d.path)) || "var(--muted)" } })),
      d.kind === "dir" && !d.complete && d.state !== "mount" && d.state !== "skipped" ? h("span", { class: "du-spin", title: "Still counting" }) : null,
      d.state === "mount" || d.state === "skipped" ? "--" : fmtSize(size)),
    h("div", { class: "col col-items" }, items(d) == null ? "" : plural(items(d), d.kind === "rest" ? "file" : "item")),
    h("div", { class: "col col-mtime" }, relTime(d.mtime)));
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      // rows are rebuilt on every poll, so a double-click is two presses on the same path
      const now = Date.now();
      const dbl = this.lastDown && this.lastDown.key === (d.path || i) && now - this.lastDown.t < 450;
      this.lastDown = dbl ? null : { key: d.path || i, t: now };
      if (dbl) this.cb.onOpen(d);
      else this.cb.onSelect(d, e, i);
    });
    el.addEventListener("mouseenter", (e) => this.cb.onHover(d, e));
    el.addEventListener("contextmenu", (e) => { e.preventDefault(); this.cb.onContext(d, e, i); });
    return el;
  }
}
