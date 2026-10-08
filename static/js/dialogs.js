// Modal dialogs, toasts and job progress.
import { post, waitJob } from "./api.js";
import { fmtSize, h } from "./util.js";

let toastBox;
function box() {
  if (!toastBox) document.body.append((toastBox = h("div", { class: "toasts" })));
  return toastBox;
}

export function toast(message, { kind = "info", timeout = 3500, actions = [] } = {}) {
  const el = h("div", { class: `toast ${kind}` },
    h("div", { class: "toast-msg" }, message),
    ...actions.map((a) => h("button", { class: "btn small", onclick: () => { a.run(); el.remove(); } }, a.label)),
    h("button", { class: "toast-x", title: "Dismiss", onclick: () => el.remove() }, "×"));
  box().append(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}
export const toastError = (e) => toast(String(e?.message || e), { kind: "error", timeout: 7000 });

/** A toast with a progress bar and a Cancel button. update(fraction, detail): fraction null = indeterminate. */
export function progressToast(label, onCancel) {
  const fill = h("div", { class: "fill" });
  const bar = h("div", { class: "bar" }, fill);
  const detail = h("div", { class: "toast-detail" });
  const el = h("div", { class: "toast job" },
    h("div", { class: "toast-msg" }, h("b", {}, label), detail, bar),
    h("button", { class: "btn small", onclick: onCancel }, "Cancel"));
  return {
    show: () => box().append(el),
    close: () => el.remove(),
    update(fraction, text = "") {
      fill.style.width = fraction == null ? "100%" : `${Math.min(100, 100 * fraction)}%`;
      bar.classList.toggle("indeterminate", fraction == null);
      detail.textContent = text;
    },
  };
}

/** Run a server job with a progress toast (shown only if it takes a moment). Resolves with the finished job. */
export async function runJob(promise, { label } = {}) {
  let job;
  try {
    job = await promise;
  } catch (e) {
    toastError(e);
    throw e;
  }
  const title = label || job.title;
  const progress = progressToast(title, () => post(`/api/jobs/${job.id}/cancel`).catch(() => {}));
  const showTimer = setTimeout(progress.show, 400); // fast jobs: no flash
  try {
    return await waitJob(job, (j) => {
      const amount = j.total ? `${fmtSize(j.done)} of ${fmtSize(j.total)}` : j.kind === "du" ? fmtSize(j.done) : "";
      progress.update(j.total ? j.done / j.total : null, amount + (j.message ? ` — ${j.message}` : ""));
    });
  } catch (e) {
    if (e.job?.status === "cancelled") toast(`${title}: cancelled`);
    else toastError(e);
    throw e;
  } finally {
    clearTimeout(showTimer);
    progress.close();
  }
}

/** Generic modal. `build(close)` returns content; resolves with what close() is given. */
export function modal(build, { cls = "", onKey } = {}) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const overlay = h("div", { class: "overlay" });
    const close = (v) => { overlay.remove(); document.removeEventListener("keydown", key, true); prev?.focus?.(); resolve(v); };
    const key = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(null); }
      else onKey?.(e, close);
    };
    const dlg = h("div", { class: `dialog ${cls}`, role: "dialog" }, build(close));
    overlay.append(dlg);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(null); });
    document.addEventListener("keydown", key, true);
    document.body.append(overlay);
    (dlg.querySelector("[autofocus]") || dlg.querySelector("input,button.primary,button"))?.focus();
  });
}

export function confirmDialog(title, message, { ok = "OK", danger = false, detail } = {}) {
  return modal((close) => [
    h("h3", {}, title),
    h("p", {}, message),
    detail ? h("div", { class: "dialog-detail" }, detail) : null,
    h("div", { class: "dialog-buttons" },
      h("button", { class: "btn", onclick: () => close(false) }, "Cancel"),
      h("button", { class: `btn primary ${danger ? "danger" : ""}`, autofocus: true, onclick: () => close(true) }, ok)),
  ]).then((v) => !!v);
}

export function promptDialog(title, value = "", { ok = "OK", label = "" } = {}) {
  return modal((close) => {
    const input = h("input", { class: "text", value, autofocus: true, spellcheck: false });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") close(input.value); });
    return [h("h3", {}, title), label ? h("label", {}, label) : null, input,
      h("div", { class: "dialog-buttons" },
        h("button", { class: "btn", onclick: () => close(null) }, "Cancel"),
        h("button", { class: "btn primary", onclick: () => close(input.value) }, ok))];
  });
}

/** Ask what to do for each conflicting name. Returns {name: action} or null if cancelled. */
export async function resolveConflicts(names, dest) {
  const decisions = {};
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const left = names.length - i;
    const res = await modal((close) => {
      const all = h("input", { type: "checkbox", id: "apply-all" });
      return [
        h("h3", {}, `An item named “${name}” already exists in this location.`),
        h("p", {}, `Do you want to replace it with the one you’re moving or copying into “${dest}”?`),
        left > 1 ? h("label", { class: "check" }, all, ` Apply to all (${left} conflicts)`) : null,
        h("div", { class: "dialog-buttons" },
          h("button", { class: "btn", onclick: () => close(null) }, "Stop"),
          h("button", { class: "btn", onclick: () => close({ a: "skip", all: all.checked }) }, "Skip"),
          h("button", { class: "btn", onclick: () => close({ a: "keep", all: all.checked }) }, "Keep Both"),
          h("button", { class: "btn primary", autofocus: true, onclick: () => close({ a: "replace", all: all.checked }) }, "Replace")),
      ];
    });
    if (!res) return null;
    if (res.all) {
      for (const n of names.slice(i)) decisions[n] = res.a;
      break;
    }
    decisions[name] = res.a;
  }
  return decisions;
}
