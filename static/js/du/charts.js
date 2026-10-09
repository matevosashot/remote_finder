// Rings (sunburst) and treemap for the disk usage page. d3 (vendored, global) does the layout.
/* global d3 */
import { fmtSize } from "../util.js";

// the app's own icon colors (folder blue first), so the chart reads like the rest of the UI
const PALETTE = ["#4e95e3", "#7a6ff0", "#2f9e8f", "#e2457a", "#3e9b52", "#e8a400", "#a07a50", "#e5483f"];
const NS = "http://www.w3.org/2000/svg";
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Colors stay attached to a path across polls, so nothing flickers while sizes change. */
export class Colors {
  constructor() { this.base = new Map(); this.next = 0; this.theme(); }

  reset() { this.base.clear(); this.next = 0; }

  /** Deeper rings fade toward the page background, so they work in light and dark mode. */
  theme() {
    this.bg = css("--bg") || "#fff";
    this.grey = d3.interpolateRgb(css("--muted") || "#86868b", this.bg)(0.45);
  }

  /** `chain`: data objects from the first level below the chart center down to the item. */
  color(chain) {
    const d = chain[chain.length - 1];
    const extra = d.kind === "rest" || d.kind === "others";
    if (chain.length === 1 && extra) return this.grey;
    const top = chain[0];
    let i = this.base.get(top.path);
    if (i === undefined) this.base.set(top.path, (i = this.next++ % PALETTE.length));
    // the first ring is a little softer than the raw icon color, like the folder icons themselves
    let fade = Math.min(0.62, 0.1 + 0.16 * (chain.length - 1));
    if (d.kind === "file") fade = Math.min(0.66, fade + 0.22);
    if (extra) return d3.interpolateRgb(this.grey, this.bg)(0.2);
    return d3.color(d3.interpolateRgb(PALETTE[i], this.bg)(fade)).formatHex();
  }
}

/** Dark or light text, whichever reads better on `color`. */
export const inkOn = (color) => (d3.lab(color).l > 62 ? "#1d1d1f" : "#ffffff");

export const sizeOf = (d, metric) => Math.max(0, d[metric] || 0);

export function labelOf(d) {
  if (d.kind === "rest") return `${d.count.toLocaleString()} smaller files`;
  if (d.kind === "others") return `${d.count.toLocaleString()} more items`;
  return d.name;
}

function svgEl(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/**
 * Renders either chart into `stage`. Callbacks get the item's data object:
 * onSelect(d, event), onOpen(d) (double-click), onUp() (center), onHover(d|null, event), onContext(d, event)
 */
export class Chart {
  constructor(stage, colors, callbacks) {
    this.stage = stage;
    this.colors = colors;
    this.cb = callbacks;
    this.els = new Map();   // path -> svg element, for hover/selection styling
    this.last = null;
    new ResizeObserver(() => this.last && this.render(...this.last)).observe(stage);
  }

  /** opts: {kind: "rings"|"treemap", metric, depth, selected: Set, focusLabel} */
  render(tree, opts) {
    this.last = [tree, opts];
    this.els.clear();
    this.colorMap = new Map();
    const w = this.stage.clientWidth, hgt = this.stage.clientHeight;
    if (!tree || !w || !hgt || sizeOf(tree, opts.metric) === 0) {
      this.stage.replaceChildren(Object.assign(document.createElement("div"), {
        className: "du-empty", textContent: tree ? "Nothing to show" : "Scanning…" }));
      return;
    }
    const svg = svgEl("svg", { viewBox: `0 0 ${w} ${hgt}`, role: "img" });
    if (opts.kind === "treemap") this.treemap(svg, tree, opts, w, hgt);
    else this.rings(svg, tree, opts, w, hgt);
    this.stage.replaceChildren(svg);
    this.setSelection(opts.selected);
  }

  chainOf(node) {
    return node.ancestors().reverse().slice(1).map((n) => n.data);
  }

  bind(el, d) {
    if (d.path) this.els.set(d.path, el);
    el.addEventListener("mouseenter", (e) => this.cb.onHover(d, e));
    el.addEventListener("mousemove", (e) => this.cb.onHover(d, e));
    el.addEventListener("mouseleave", () => this.cb.onHover(null));
    el.addEventListener("click", (e) => {
      // the chart is redrawn on every poll, so a double-click is two clicks on the same path
      const now = Date.now();
      const dbl = d.path && this.lastClick?.path === d.path && now - this.lastClick.t < 450;
      this.lastClick = dbl ? null : { path: d.path, t: now };
      if (dbl) this.cb.onOpen(d);
      else this.cb.onSelect(d, e);
    });
    el.addEventListener("contextmenu", (e) => { e.preventDefault(); this.cb.onContext(d, e); });
  }

  fill(node) {
    const c = this.colors.color(this.chainOf(node));
    if (node.data.path) this.colorMap.set(node.data.path, c);
    return c;
  }

  rings(svg, tree, { metric, depth }, w, hgt) {
    const root = d3.hierarchy(tree, (d) => d.children);
    // each folder's own total (not the sum of what is shown) sets its angle, like Baobab
    root.each((n) => { n.value = sizeOf(n.data, metric); });
    d3.partition().size([2 * Math.PI, 1])(root);
    const radius = Math.max(40, Math.min(w, hgt) / 2 - 10);
    const levels = Math.max(1, Math.min(depth, root.height || 1));
    const r0 = Math.max(34, radius * 0.2);
    const ring = (radius - r0) / levels;
    const arc = d3.arc().padAngle(0.0015).padRadius(radius);
    const g = svgEl("g", { transform: `translate(${w / 2},${hgt / 2})` });
    const minAngle = 0.004;
    for (const n of root.descendants()) {
      if (!n.depth || n.depth > levels || n.x1 - n.x0 < minAngle || !n.value) continue;
      const p = svgEl("path", {
        class: "du-seg",
        d: arc({ innerRadius: r0 + (n.depth - 1) * ring, outerRadius: r0 + n.depth * ring - 1, startAngle: n.x0, endAngle: n.x1 }),
        fill: this.fill(n),
      });
      if (n.data.path) p.dataset.path = n.data.path;
      this.bind(p, n.data);
      g.append(p);
    }
    const center = svgEl("circle", { class: "du-center", r: r0 - 3 });
    center.addEventListener("click", () => this.cb.onUp());
    center.addEventListener("mouseenter", (e) => this.cb.onHover(tree, e));
    center.addEventListener("mousemove", (e) => this.cb.onHover(tree, e));
    center.addEventListener("mouseleave", () => this.cb.onHover(null));
    const label = svgEl("text", { class: "du-center-label", y: -4 });
    label.textContent = fmtSize(sizeOf(tree, metric));
    const sub = svgEl("text", { class: "du-center-sub", y: 13 });
    const name = tree.path === "/" ? "/" : tree.path.split("/").pop();
    sub.textContent = name.length > 14 ? name.slice(0, 13) + "…" : name;
    g.append(center, label, sub);
    svg.append(g);
  }

  treemap(svg, tree, { metric }, w, hgt) {
    const root = d3.hierarchy(tree, (d) => d.children)
      .sum((d) => (d.children?.length ? 0 : sizeOf(d, metric)));
    d3.treemap().tile(d3.treemapSquarify).size([w, hgt]).round(true)
      .paddingOuter(2).paddingInner(1).paddingTop((n) => (n.depth ? 16 : 2))(root);
    for (const n of root.descendants()) {
      if (!n.depth) continue;
      const cw = n.x1 - n.x0, ch = n.y1 - n.y0;
      if (cw < 2 || ch < 2) continue;
      const color = this.fill(n);
      const rect = svgEl("rect", { class: "du-cell du-seg", x: n.x0, y: n.y0, width: cw, height: ch, fill: color });
      if (n.data.path) rect.dataset.path = n.data.path;
      this.bind(rect, n.data);
      svg.append(rect);
      if (cw > 44 && ch > 13) {
        const t = svgEl("text", { class: "du-label", x: n.x0 + 4, y: n.y0 + 12 });
        t.style.fill = inkOn(color);   // a style, since the stylesheet sets fill
        const text = `${labelOf(n.data)}  ${fmtSize(sizeOf(n.data, metric))}`;
        const max = Math.floor((cw - 8) / 6.2);
        t.textContent = text.length > max ? text.slice(0, Math.max(1, max - 1)) + "…" : text;
        svg.append(t);
      }
    }
  }

  setHover(path) {
    this.stage.querySelectorAll(".du-seg.hover").forEach((el) => el.classList.remove("hover"));
    if (path) this.els.get(path)?.classList.add("hover");
  }

  setSelection(selected) {
    if (this.last) this.last[1].selected = selected;
    this.stage.querySelectorAll(".du-seg.sel").forEach((el) => el.classList.remove("sel"));
    for (const p of selected || []) this.els.get(p)?.classList.add("sel");
  }
}
