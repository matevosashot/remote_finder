// List view: sortable columns, disclosure triangles, virtualized rows.
import { toggleExpand } from "../nav.js";
import { focusIndex, indexOf, moveTo } from "../selection.js";
import { sortBy } from "../settings.js";
import { state } from "../state.js";
import { dirname, fmtDate, fmtSize, h, kindLabel } from "../util.js";
import { VirtualList } from "../virtual.js";
import { iconEl, itemAttrs, itemClasses } from "./common.js";

const ROW = 24;

export class ListView {
  constructor() { this.name = "list"; }

  mount(root) {
    this.root = root;
    this.header = h("div", { class: "list-header" });
    this.scroller = h("div", { class: "list-scroll view-bg", tabindex: "-1" });
    root.append(this.header, this.scroller);
    this.vl = new VirtualList(this.scroller, { rowHeight: ROW, count: 0, renderRow: (i) => this.row(i) });
    this.scroller.addEventListener("click", (e) => {
      const tri = e.target.closest(".disclosure");
      if (tri) toggleExpand(tri.closest("[data-path]").dataset.path);
    });
  }

  columns() {
    const cols = [["name", "Name"], ["mtime", "Date Modified"], ["size", "Size"], ["kind", "Kind"]];
    if (state.search) cols.push(["where", "Where"]);
    return cols;
  }

  renderHeader() {
    this.header.replaceChildren(...this.columns().map(([key, label]) => h("div", {
      class: `col col-${key} ${state.sort.key === key ? "sorted" : ""}`,
      onclick: () => key !== "where" && sortBy(key),
    }, label, state.sort.key === key ? h("span", { class: "sort-arrow" }, state.sort.dir > 0 ? "▲" : "▼") : null)));
    this.root.classList.toggle("searching", !!state.search);
  }

  render() {
    this.renderHeader();
    this.vl.setCount(state.items.length);
  }

  row(i) {
    const e = state.items[i];
    const el = h("div", { class: `row ${i % 2 ? "odd" : ""} ${e.kind === "placeholder" ? "placeholder" : ""}`, ...itemAttrs(e) });
    const indent = { paddingLeft: `${6 + e.depth * 18}px` };
    const tri = e.kind === "dir" && !state.search
      ? h("span", { class: `disclosure ${state.expanded.has(e.path) ? "open" : ""}` }, "")
      : h("span", { class: "disclosure none" });
    const size = e.kind === "dir" ? (state.sizes.has(e.path) ? fmtSize(state.sizes.get(e.path)) : "--") : e.kind === "file" ? fmtSize(e.size) : "";
    el.append(
      h("div", { class: "col col-name", style: indent }, tri, e.kind === "placeholder" ? null : iconEl(e, 0), h("span", { class: "name" }, e.name)),
      h("div", { class: "col col-mtime" }, e.kind === "placeholder" ? "" : fmtDate(e.mtime)),
      h("div", { class: "col col-size" }, size),
      h("div", { class: "col col-kind" }, e.kind === "placeholder" ? "" : kindLabel(e)),
      ...(state.search ? [h("div", { class: "col col-where", title: dirname(e.path) }, dirname(e.path))] : []),
    );
    if (e.error) el.title = e.error;
    itemClasses(el, e);
    return el;
  }

  updateSelection() {
    for (const [i, el] of this.vl.rows) itemClasses(el, state.items[i]);
  }

  reveal(path) {
    const i = indexOf(path);
    if (i >= 0) this.vl.scrollToRow(i);
  }

  key(e) {
    const i = focusIndex();
    const cur = state.items[i];
    switch (e.key) {
      case "ArrowDown": moveTo(i < 0 ? 0 : i + 1, e); return true;
      case "ArrowUp": moveTo(i < 0 ? state.items.length - 1 : i - 1, e); return true;
      case "Home": moveTo(0, e); return true;
      case "End": moveTo(state.items.length - 1, e); return true;
      case "PageDown": moveTo(i + Math.floor(this.scroller.clientHeight / ROW), e); return true;
      case "PageUp": moveTo(i - Math.floor(this.scroller.clientHeight / ROW), e); return true;
      case "ArrowRight":
        if (cur?.kind === "dir" && !state.search) { toggleExpand(cur.path, true); return true; }
        return false;
      case "ArrowLeft":
        if (!cur || state.search) return false;
        if (cur.kind === "dir" && state.expanded.has(cur.path)) { toggleExpand(cur.path, false); return true; }
        if (cur.depth > 0) { moveTo(indexOf(dirname(cur.path))); return true; }
        return false;
    }
    return false;
  }

  bgPathAt() { return state.search ? null : state.path; }
  destroy() { this.vl.destroy(); this.root.replaceChildren(); }
}
