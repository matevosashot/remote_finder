// Columns view (Miller columns): one column per folder from / to the current folder,
// plus a column showing the selected folder's contents or the selected file's preview.
import { get } from "../api.js";
import { decorate, navigate } from "../nav.js";
import { renderPreview } from "../preview.js";
import { focusIndex, indexOf, moveTo } from "../selection.js";
import { state } from "../state.js";
import { ancestors, childToward, collator, dirname, h } from "../util.js";
import { VirtualList } from "../virtual.js";
import { iconEl, itemAttrs, itemClasses } from "./common.js";

const ROW = 22;

/** Non-current columns are always by name, like Finder. */
function sortEntries(entries) {
  return entries.filter((e) => state.showHidden || !e.hidden).sort((a, b) => {
    if (state.foldersFirst && (a.kind === "dir") !== (b.kind === "dir")) return a.kind === "dir" ? -1 : 1;
    return collator.compare(a.name, b.name);
  });
}

export class ColumnsView {
  constructor() {
    this.name = "columns";
    this.cache = new Map(); // dir -> entries (ancestors / selected folder)
    this.lists = [];        // {dir, items, vl, el}
  }

  mount(root) {
    this.root = root;
    this.strip = h("div", { class: "columns-strip" });
    root.append(this.strip);
  }

  async listDir(dir, fresh = false) {
    if (!fresh && this.cache.has(dir)) return this.cache.get(dir);
    const res = await get("/api/list", { path: dir });
    const items = decorate(res.entries, dir);
    this.cache.set(dir, items);
    return items;
  }

  /** Map clicks in non-current columns to navigation (Finder: selecting there moves the window). */
  lookup(path) {
    for (const l of this.lists) {
      const it = l.items.find((i) => i.path === path);
      if (it) return it;
    }
    return null;
  }

  select(path) {
    const dir = dirname(path);
    if (dir === state.path || state.search) return true; // current column: normal selection
    navigate(dir, { select: path });
    return false;
  }

  async render() {
    const token = (this.token = Symbol());
    const dirs = ancestors(state.path);
    const cols = [];
    for (const d of dirs) {
      if (d === state.path) cols.push({ dir: d, items: state.items, current: true });
      else {
        let items = [];
        try { items = await this.listDir(d); } catch {}
        if (this.token !== token) return;
        cols.push({ dir: d, items: sortEntries(items) });
      }
    }
    this.cache.delete(state.path);
    this.columns = cols;
    this.draw();
    this.updateTail();
    requestAnimationFrame(() => (this.strip.scrollLeft = this.strip.scrollWidth));
  }

  draw() {
    this.lists.forEach((l) => l.vl.destroy());
    this.lists = [];
    this.tail = null;
    this.strip.replaceChildren();
    for (const c of this.columns) this.addList(c.dir, c.items, c.current);
    this.tail = h("div", { class: "column column-tail" });
    this.strip.append(this.tail);
  }

  addList(dir, items, current) {
    const el = h("div", { class: `column ${current ? "current view-bg" : ""}`, "data-dir": dir });
    const sc = h("div", { class: "column-scroll" });
    el.append(sc);
    if (this.tail) this.strip.insertBefore(el, this.tail);
    else this.strip.append(el);
    const vl = new VirtualList(sc, { rowHeight: ROW, count: items.length, renderRow: (i) => this.row(items[i], dir) });
    const entry = { dir, items, vl, el, current };
    this.lists.push(entry);
    return entry;
  }

  row(e, dir) {
    const el = h("div", { class: "col-row", ...itemAttrs(e) },
      iconEl(e, 0), h("span", { class: "name" }, e.name), e.kind === "dir" ? h("span", { class: "chev" }, "›") : null);
    this.classes(el, e, dir);
    return el;
  }

  classes(el, e, dir) {
    if (dir === state.path) itemClasses(el, e);
    else el.classList.toggle("trail", e.path === childToward(dir, state.path)); // leads to the next column
  }

  async updateTail() {
    // drop a previous "selected folder" column
    while (this.lists.length && !this.columns.some((c) => c.dir === this.lists[this.lists.length - 1].dir)) {
      const l = this.lists.pop();
      l.vl.destroy();
      l.el.remove();
    }
    const one = state.selection.size === 1 ? state.items.find((i) => state.selection.has(i.path)) : null;
    this.tail.replaceChildren();
    this.tail.className = "column column-tail";
    if (!one) return;
    const token = (this.tailToken = Symbol());
    if (one.kind === "dir") {
      this.tail.className = "column column-tail empty";
      let items = [];
      try { items = sortEntries(await this.listDir(one.path, true)); } catch {}
      if (this.tailToken !== token) return;
      this.addList(one.path, items, false);
    } else {
      const box = h("div", {});
      this.tail.className = "column column-tail preview-col";
      this.tail.append(box);
      renderPreview(box, one, "column");
    }
    requestAnimationFrame(() => (this.strip.scrollLeft = this.strip.scrollWidth));
  }

  updateSelection() {
    for (const l of this.lists) {
      for (const [i, el] of l.vl.rows) this.classes(el, l.items[i], l.dir);
    }
    const key = [...state.selection].join("\0");
    if (key !== this.lastSel) {
      this.lastSel = key;
      if (this.tail) this.updateTail();
    }
  }

  reveal(path) {
    const l = this.lists.find((x) => x.current);
    const i = indexOf(path);
    if (l && i >= 0) l.vl.scrollToRow(i);
  }

  key(e) {
    const i = focusIndex();
    const cur = state.items[i];
    switch (e.key) {
      case "ArrowDown": moveTo(i < 0 ? 0 : i + 1, e); return true;
      case "ArrowUp": moveTo(i < 0 ? state.items.length - 1 : i - 1, e); return true;
      case "ArrowRight":
        if (cur?.kind === "dir") navigate(cur.path).then(() => moveTo(0));
        return true;
      case "ArrowLeft":
        if (state.path !== "/") navigate(dirname(state.path), { select: state.path });
        return true;
    }
    return false;
  }

  bgPathAt(e) {
    const col = e.target.closest?.(".column[data-dir]");
    return col ? col.dataset.dir : state.path;
  }

  destroy() {
    this.lists.forEach((l) => l.vl.destroy());
    this.root.replaceChildren();
  }
}
