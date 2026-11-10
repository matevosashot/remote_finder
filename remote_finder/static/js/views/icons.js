// Icons view: virtualized grid, size slider, thumbnails, rubber-band selection.
import { focusIndex, indexOf, moveTo } from "../selection.js";
import { state } from "../state.js";
import { h } from "../util.js";
import { VirtualList } from "../virtual.js";
import { bindBand, iconEl, itemAttrs, itemClasses } from "./common.js";

const PAD = 12;

export class IconsView {
  constructor() { this.name = "icons"; }

  mount(root) {
    this.root = root;
    this.scroller = h("div", { class: "icons-scroll view-bg", tabindex: "-1" });
    root.append(this.scroller);
    this.cols = 1;
    this.vl = new VirtualList(this.scroller, { rowHeight: 100, count: 0, renderRow: (r) => this.row(r), overscan: 3 });
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.scroller);
    this.bindBand();
  }

  metrics() {
    const s = state.iconSize;
    const cellW = Math.max(84, s + 36);
    const cellH = s + 52;
    return { s, cellW, cellH };
  }

  layout(force = false) {
    const { cellW, cellH } = this.metrics();
    const width = this.scroller.clientWidth - PAD * 2;
    const cols = Math.max(1, Math.floor(width / cellW));
    if (force || cols !== this.cols || this.vl.opts.rowHeight !== cellH) {
      this.cols = cols;
      this.vl.setCount(Math.ceil(state.items.length / cols), cellH);
    }
  }

  render() {
    this.root.style.setProperty("--icon", `${state.iconSize}px`);
    this.layout(true);
  }

  row(r) {
    const { s, cellW } = this.metrics();
    const row = h("div", { class: "icon-row", style: { paddingLeft: `${PAD}px` } });
    for (let c = 0; c < this.cols; c++) {
      const e = state.items[r * this.cols + c];
      if (!e) break;
      const cell = h("div", { class: "icon-cell", style: { width: `${cellW}px` }, ...itemAttrs(e), title: e.name },
        h("div", { class: "icon-box" }, iconEl(e, s >= 48 ? s : 0)),
        h("div", { class: "name" }, e.name));
      itemClasses(cell, e);
      row.append(cell);
    }
    return row;
  }

  updateSelection() {
    for (const [r, row] of this.vl.rows) {
      [...row.children].forEach((cell, c) => itemClasses(cell, state.items[r * this.cols + c]));
    }
  }

  reveal(path) {
    const i = indexOf(path);
    if (i >= 0) this.vl.scrollToRow(Math.floor(i / this.cols));
  }

  key(e) {
    const i = focusIndex();
    const n = state.items.length;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: this.cols, ArrowUp: -this.cols }[e.key];
    if (step) {
      if (i < 0) moveTo(0, e);
      else if (i + step >= 0 && i + step < n) moveTo(i + step, e);
      else if (e.key === "ArrowDown") moveTo(n - 1, e);
      return true;
    }
    if (e.key === "Home") { moveTo(0, e); return true; }
    if (e.key === "End") { moveTo(n - 1, e); return true; }
    return false;
  }

  /** Drag on empty space draws a selection rectangle. */
  bindBand() {
    bindBand(this.scroller, {
      canStart: (e) => !e.target.closest("[data-path]"),
      hitTest: (L, T, R, B) => {
        const { cellW, cellH } = this.metrics();
        const out = [];
        const r0 = Math.max(0, Math.floor(T / cellH)), r1 = Math.floor(B / cellH);
        for (let r = r0; r <= r1; r++) {
          for (let c = 0; c < this.cols; c++) {
            const cx = PAD + c * cellW, cy = r * cellH;
            // hit-test the icon+label area, not the whole cell
            if (cx + cellW - 8 < L || cx + 8 > R || cy + cellH - 6 < T || cy + 4 > B) continue;
            const it = state.items[r * this.cols + c];
            if (it) out.push(it.path);
          }
        }
        return out;
      },
    });
  }

  bgPathAt() { return state.search ? null : state.path; }
  destroy() { this.ro.disconnect(); this.vl.destroy(); this.root.replaceChildren(); }
}
