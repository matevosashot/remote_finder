// Quick Look (Space): overlay preview; arrows step through items; Space/Esc closes.
import { entryUrl } from "./api.js";
import { renderPreview } from "./preview.js";
import { focusIndex, moveTo } from "./selection.js";
import { on, state } from "./state.js";
import { fmtSize, h, kindLabel, openTab } from "./util.js";

let overlay = null;
let unsub = null;

export const isOpen = () => !!overlay;

export function quickLook() {
  if (overlay) return close();
  const i = focusIndex();
  const entry = state.items[i >= 0 ? i : 0];
  if (!entry) return;
  const title = h("div", { class: "ql-title" });
  const body = h("div", { class: "ql-body" });
  const openBtn = h("button", { class: "btn small" }, "Open in New Tab");
  overlay = h("div", { class: "ql-overlay" },
    h("div", { class: "ql-window" },
      h("div", { class: "ql-bar" },
        h("button", { class: "ql-close", title: "Close (Space)", onclick: close }, "×"),
        title, openBtn),
      body));
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.body.append(overlay);

  const show = () => {
    const idx = focusIndex();
    const e = state.items[idx >= 0 ? idx : 0];
    if (!e || e.path === overlay._shown) return;
    overlay._shown = e.path;
    title.replaceChildren(h("b", {}, e.name), h("span", { class: "muted" },
      ` — ${kindLabel(e)}${e.kind === "file" ? ` · ${fmtSize(e.size)}` : ""}`));
    openBtn.onclick = () => openTab(entryUrl(e));
    renderPreview(body, e, "quicklook");
  };
  show();
  unsub = on("selection", show);
}

export function close() {
  overlay?.remove();
  overlay = null;
  unsub?.();
  unsub = null;
}

/** Keys while Quick Look is open; returns true if handled. */
export function key(e) {
  if (!overlay) return false;
  if (e.key === " " || e.key === "Escape") { e.preventDefault(); close(); return true; }
  const i = focusIndex();
  if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); moveTo(i + 1, {}); return true; }
  if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); moveTo(Math.max(0, i - 1), {}); return true; }
  // let media/PDF controls get other keys
  return e.target.closest?.(".ql-overlay") != null;
}
