// Resizable list columns: drag the edge between two header cells, double-click it to fit the content.
// One column (the name) takes whatever room is left, so an edge right of it resizes the column after
// the edge and the edge stays under the pointer. Widths are CSS variables (--col-<key>) on the host,
// remembered in localStorage per list.
import { h, store } from "./util.js";

const MIN = 44;

export class ColumnWidths {
  constructor(host, storeKey, { flex = "name", minFlex = 160 } = {}) {
    Object.assign(this, { host, storeKey, flex, minFlex });
    this.widths = store.get(storeKey, {});
    for (const [k, w] of Object.entries(this.widths)) this.apply(k, w);
  }

  apply(key, w) { this.host.style.setProperty(`--col-${key}`, `${w}px`); }

  /** Put grips on a freshly rendered header whose cells are .col-<key> in this order. */
  decorate(header, keys) {
    const fi = keys.indexOf(this.flex);
    keys.forEach((key, i) => {
      const target = i < fi ? key : keys[i + 1];  // the column this edge resizes
      if (!target) return;
      const sign = i < fi ? 1 : -1;
      header.querySelector(`.col-${key}`)?.append(h("span", {
        class: "col-grip", title: "Drag to resize · double-click to fit",
        onmousedown: (e) => this.drag(e, header, target, sign),
        ondblclick: (e) => { e.stopPropagation(); this.fit(header, target); },
        onclick: (e) => e.stopPropagation(),
      }));
    });
  }

  /** How much the flexible column can still give up. */
  room(header) {
    const cell = header.querySelector(`.col-${this.flex}`);
    return cell ? Math.max(0, cell.getBoundingClientRect().width - this.minFlex) : Infinity;
  }

  drag(e, header, key, sign) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const start = header.querySelector(`.col-${key}`).getBoundingClientRect().width;
    const max = start + this.room(header);
    const x0 = e.clientX;
    document.body.classList.add("resizing-x");
    const move = (ev) => this.set(key, Math.max(MIN, Math.min(max, start + sign * (ev.clientX - x0))));
    const up = () => {
      document.body.classList.remove("resizing-x");
      removeEventListener("mousemove", move);
      removeEventListener("mouseup", up);
      // the click that ends a drag must not sort by the column under the pointer
      const swallow = (ev) => ev.stopPropagation();
      addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => removeEventListener("click", swallow, { capture: true }));
      store.set(this.storeKey, this.widths);
    };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
  }

  /** Fit the header and the rows on screen. */
  fit(header, key) {
    const cur = header.querySelector(`.col-${key}`).getBoundingClientRect().width;
    const max = cur + this.room(header);
    this.host.style.setProperty(`--col-${key}`, "max-content");
    let w = MIN;
    for (const el of this.host.querySelectorAll(`.col-${key}`)) w = Math.max(w, Math.ceil(el.getBoundingClientRect().width));
    this.set(key, Math.min(max, w + 2));
    store.set(this.storeKey, this.widths);
  }

  set(key, w) {
    this.widths[key] = Math.round(w);
    this.apply(key, this.widths[key]);
  }

  /** Forget the variables on a host other views reuse. */
  detach() {
    for (const k of Object.keys(this.widths)) this.host.style.removeProperty(`--col-${k}`);
  }
}
