// Archive list: cleanup candidates kept on the server (nothing is deleted here), with undo/redo
// and a ready-made `rm` command to review and run by hand.
import { get, post } from "../api.js";
import { confirmDialog, modal, toast, toastError } from "../dialogs.js";
import { copyText, fmtSize, h, isInside, store } from "../util.js";

/** Single-quote for bash: safe for spaces, quotes, $, globs and newlines. */
export const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Drop paths inside another listed path (deleting the outer one covers them). */
export function outermost(paths) {
  const out = [];
  for (const p of [...new Set(paths)].sort()) {
    if (!out.length || !isInside(p, out[out.length - 1])) out.push(p);
  }
  return out;
}

export function rmCommand(paths) {
  return `rm -rf -- \\\n${paths.map(shQuote).map((q) => `  ${q}`).join(" \\\n")}\n`;
}

export class Archive {
  /** onChange() runs after every change (the page refetches sizes) */
  constructor(host, { root, metric, onChange }) {
    this.host = host;
    this.root = root;
    this.metric = metric;
    this.onChange = onChange;
    this.items = [];
    this.undoStack = [];
    this.redoStack = [];
    this.open = store.get("du.archiveOpen", true);
    this.onlyHere = true;
  }

  async load() {
    try {
      this.items = (await get("/api/du/archive")).items;
    } catch (e) { toastError(e); }
    this.render();
  }

  has(path) { return this.items.some((i) => i.path === path); }

  async send(body) {
    this.items = (await post("/api/du/archive", body)).items;
    this.render();
  }

  /** Archive data objects from the tree/chart: [{path, kind, apparent, disk, files}] */
  async add(entries) {
    const fresh = entries.filter((e) => e.path && !this.has(e.path))
      .map(({ path, kind, apparent, disk, files }) => ({ path, kind, apparent, disk, files }));
    if (!fresh.length) return;
    if (!await this.do({ type: "add", items: fresh })) return;
    const size = fresh.reduce((s, e) => s + (e[this.metric] || 0), 0);
    toast(`Archived ${fresh.length === 1 ? `“${fresh[0].path.split("/").pop()}”` : `${fresh.length} items`} (${fmtSize(size)})`,
      { actions: [{ label: "Undo", run: () => this.undo() }] });
  }

  async restore(paths) {
    const items = this.items.filter((i) => paths.includes(i.path));
    if (items.length) await this.do({ type: "remove", items });
  }

  async do(op, record = true) {
    try {
      await this.send(op.type === "add" ? { add: op.items } : { remove: op.items.map((i) => i.path) });
    } catch (e) { toastError(e); return false; }
    if (record) { this.undoStack.push(op); this.redoStack = []; this.onChange(); }
    return true;
  }

  async undo() {
    const op = this.undoStack.pop();
    if (!op) return;
    if (!await this.do({ ...op, type: op.type === "add" ? "remove" : "add" }, false)) { this.undoStack.push(op); return; }
    this.redoStack.push(op);
    this.onChange();
  }

  async redo() {
    const op = this.redoStack.pop();
    if (!op) return;
    if (!await this.do(op, false)) { this.redoStack.push(op); return; }
    this.undoStack.push(op);
    this.onChange();
  }

  undoLabel() {
    const op = this.undoStack[this.undoStack.length - 1];
    if (!op) return "";
    const what = op.items.length === 1 ? `“${op.items[0].path.split("/").pop()}”` : `${op.items.length} items`;
    return `${op.type === "add" ? "Archive" : "Restore"} ${what}`;
  }

  shown() {
    return this.onlyHere ? this.items.filter((i) => isInside(i.path, this.root)) : this.items;
  }

  showCommand() {
    const live = outermost(this.shown().filter((i) => i.exists).map((i) => i.path));
    if (!live.length) { toast("Nothing to delete: the list is empty or everything on it is already gone"); return; }
    const total = this.shown().filter((i) => live.includes(i.path)).reduce((s, i) => s + (i[this.metric] || 0), 0);
    const cmd = rmCommand(live);
    modal((close) => {
      const ta = h("textarea", { class: "du-cmd", readonly: true, spellcheck: false });
      ta.value = cmd;
      return [
        h("h3", {}, `Delete ${live.length} archived item${live.length > 1 ? "s" : ""} (${fmtSize(total)})`),
        h("p", { class: "muted" }, "Remote Finder never runs this. Review it, then paste it into a terminal yourself. Paths inside another archived folder are left out."),
        ta,
        h("div", { class: "dialog-buttons" },
          h("button", { class: "btn", onclick: () => close() }, "Close"),
          h("button", { class: "btn primary", autofocus: true, onclick: async () => {
            if (await copyText(cmd)) toast("Copied the command", { timeout: 1800 });
            else toast("Clipboard is not available; select the text and copy it", { kind: "error" });
          } }, "Copy Command")),
      ];
    }, { cls: "du-cmd-dialog wide" });
  }

  render() {
    const items = this.shown();
    const top = new Set(outermost(items.map((i) => i.path)));
    const total = items.filter((i) => top.has(i.path)).reduce((s, i) => s + (i[this.metric] || 0), 0);
    const gone = items.filter((i) => !i.exists);
    const others = this.items.length - items.length;
    const head = h("div", { class: "du-archive-head" },
      h("span", { class: "title", onclick: () => { this.open = !this.open; store.set("du.archiveOpen", this.open); this.render(); } },
        h("span", { class: `disclosure ${this.open ? "open" : ""}` }),
        `Archived · ${items.length.toLocaleString()} item${items.length === 1 ? "" : "s"} · ${fmtSize(total)}`),
      h("span", { class: "spacer" }),
      h("button", { class: "btn small primary", disabled: !items.length, onclick: () => this.showCommand() }, "Show Delete Command…"),
      h("button", { class: "btn small", disabled: !items.length, onclick: async () => {
        if (await copyText(items.map((i) => i.path).join("\n") + "\n")) toast("Copied paths", { timeout: 1500 });
      } }, "Copy Paths"),
      gone.length ? h("button", { class: "btn small", title: "Forget entries that no longer exist on disk",
        onclick: () => this.restore(gone.map((i) => i.path)) }, `Remove ${gone.length} Deleted`) : null,
      h("button", { class: "btn small", disabled: !items.length, onclick: async () => {
        if (await confirmDialog("Clear the archive list?", `${items.length} entries will be removed from the list. Nothing on disk changes. You can undo this.`, { ok: "Clear" })) {
          this.restore(items.map((i) => i.path));
        }
      } }, "Clear List"),
      h("label", { title: "Show only entries inside the folder being analyzed" },
        h("input", { type: "checkbox", checked: this.onlyHere, onchange: (e) => { this.onlyHere = e.target.checked; this.render(); } }),
        `Only this folder${others && this.onlyHere ? ` (${others} elsewhere)` : ""}`));
    const list = this.open ? h("div", { class: "du-archive-list" },
      items.length ? [...items].sort((a, b) => (b[this.metric] || 0) - (a[this.metric] || 0)).map((i) => h("div", { class: "arow" },
        h("span", { class: `apath ${i.exists ? "" : "gone"}` }, i.path,
          !top.has(i.path) ? h("span", { class: "nested" }, "  (inside another archived folder)") : null),
        !i.exists ? h("span", { class: "du-badge", title: "No longer on disk" }, "deleted") : null,
        h("span", { class: "asize" }, i.exists ? fmtSize(i[this.metric] || 0) : ""),
        h("button", { class: "btn small", title: "Take it off the list and show it again", onclick: () => this.restore([i.path]) }, "Restore")))
        : h("div", { class: "empty" }, "Select folders or files and press Delete or Archive to collect them here. Nothing is deleted.")) : null;
    this.host.replaceChildren(head, list || "");
  }
}
