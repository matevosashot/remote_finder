// Shared bits for views: icon/thumbnail element, item classes, throttled thumbnail loading.
import { thumbUrl } from "../api.js";
import { ICONS, iconFor } from "../icons.js";
import { state } from "../state.js";
import { h, thumbable } from "../util.js";

const queue = [];
let active = 0;
const MAX_ACTIVE = 6;

function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    const { img, src } = queue.shift();
    if (!img.isConnected) continue;
    active++;
    const done = () => { active--; pump(); };
    img.addEventListener("load", done, { once: true });
    img.addEventListener("error", () => { img.replaceWith(h("span", { class: "ico-wrap", html: img._fallback })); done(); }, { once: true });
    img.src = src;
  }
}

/** Icon (or lazy thumbnail when `thumbSize` and the file is an image). */
export function iconEl(entry, thumbSize = 0) {
  const wrap = h("span", { class: "item-icon" });
  if (thumbSize && thumbable(entry) && entry.size < 200e6) {
    const img = h("img", { class: "thumb", alt: "", draggable: false });
    img._fallback = iconFor(entry);
    wrap.append(img);
    queue.push({ img, src: thumbUrl(entry.path, thumbSize * (devicePixelRatio || 1), entry.mtime) });
    requestAnimationFrame(pump);
  } else wrap.innerHTML = iconFor(entry);
  if (entry.link) wrap.insertAdjacentHTML("beforeend", ICONS.link);
  return wrap;
}

export function itemClasses(el, entry) {
  el.classList.toggle("sel", state.selection.has(entry.path));
  el.classList.toggle("focus", state.focus === entry.path);
  el.classList.toggle("cut", !!state.clipboard && state.clipboard.op === "move" && state.clipboard.paths.includes(entry.path));
  el.classList.toggle("hidden-file", !!entry.hidden);
  el.classList.toggle("broken", !!entry.broken);
}

export function itemAttrs(entry) {
  return { "data-path": entry.path, draggable: entry.kind !== "placeholder" ? "true" : null };
}
