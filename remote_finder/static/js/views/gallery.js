// Gallery view: large preview of the focused item over a windowed thumbnail strip.
import { renderPreview } from "../preview.js";
import { focusIndex, indexOf, moveTo } from "../selection.js";
import { state } from "../state.js";
import { h } from "../util.js";
import { iconEl, itemAttrs, itemClasses } from "./common.js";

const CELL = 92;

export class GalleryView {
  constructor() { this.name = "gallery"; }

  mount(root) {
    this.root = root;
    this.stage = h("div", { class: "gallery-stage" });
    this.strip = h("div", { class: "gallery-strip view-bg" });
    this.inner = h("div", { class: "gallery-inner" });
    this.strip.append(this.inner);
    root.append(this.stage, this.strip);
    this.cells = new Map();
    this.strip.addEventListener("scroll", () => this.drawStrip(), { passive: true });
    this.strip.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { this.strip.scrollLeft += e.deltaY; e.preventDefault(); }
    }, { passive: false });
    this.ro = new ResizeObserver(() => this.drawStrip());
    this.ro.observe(this.strip);
  }

  render() {
    this.inner.style.width = `${state.items.length * CELL}px`;
    this.cells.forEach((c) => c.remove());
    this.cells.clear();
    this.drawStrip();
    this.showStage();
  }

  drawStrip() {
    const left = this.strip.scrollLeft, w = this.strip.clientWidth;
    const first = Math.max(0, Math.floor(left / CELL) - 4);
    const last = Math.min(state.items.length - 1, Math.ceil((left + w) / CELL) + 4);
    for (const [i, el] of this.cells) if (i < first || i > last) { el.remove(); this.cells.delete(i); }
    for (let i = first; i <= last; i++) {
      if (this.cells.has(i)) continue;
      const e = state.items[i];
      const el = h("div", { class: "gallery-cell", style: { left: `${i * CELL}px` }, ...itemAttrs(e), title: e.name },
        iconEl(e, 72), h("div", { class: "name" }, e.name));
      itemClasses(el, e);
      this.inner.append(el);
      this.cells.set(i, el);
    }
  }

  current() {
    const i = focusIndex();
    return i >= 0 ? state.items[i] : state.items[0];
  }

  showStage() {
    const e = this.current();
    if (e?.path === this.staged) return;
    this.staged = e?.path;
    renderPreview(this.stage, e, "gallery");
  }

  updateSelection() {
    for (const [i, el] of this.cells) itemClasses(el, state.items[i]);
    this.showStage();
  }

  reveal(path) {
    const i = indexOf(path);
    if (i < 0) return;
    const x = i * CELL, st = this.strip.scrollLeft, w = this.strip.clientWidth;
    if (x < st) this.strip.scrollLeft = x - CELL;
    else if (x + CELL > st + w) this.strip.scrollLeft = x + 2 * CELL - w;
  }

  key(e) {
    const i = focusIndex();
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { moveTo(i + 1, e); return true; }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") { moveTo(Math.max(0, i - 1), e); return true; }
    if (e.key === "Home") { moveTo(0, e); return true; }
    if (e.key === "End") { moveTo(state.items.length - 1, e); return true; }
    return false;
  }

  bgPathAt() { return state.search ? null : state.path; }
  destroy() { this.ro.disconnect(); this.root.replaceChildren(); }
}
