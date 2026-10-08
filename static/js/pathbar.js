// Title + full-path bar for the standalone pages (viewer, head/tail, editor):
// the name copies the path on click; each folder in the path opens in a new tab.
import { folderUrl } from "./api.js";
import { toast } from "./dialogs.js";
import { ancestors, basename, copyText, h } from "./util.js";

export async function copyPath(path) {
  if (await copyText(path)) toast("Copied path", { timeout: 1500 });
  else toast("Clipboard is not available", { kind: "error" });
}

/** Fill #name and #path for `path` (call again when the page switches files). */
export function showPath(path) {
  const name = document.getElementById("name");
  name.textContent = basename(path);
  name.title = `${path}\nClick to copy the full path`;
  name.classList.add("copyable");
  name.onclick = () => copyPath(path);

  const bar = document.getElementById("path");
  if (!bar) return;
  const link = (dir, label) => h("a", { href: folderUrl(dir), target: "_blank", title: `Open ${dir} in a new tab` }, label);
  const crumbs = ancestors(path).slice(0, -1).map((dir, i) =>
    i ? [link(dir, basename(dir)), h("span", { class: "path-sep" }, "/")] : link(dir, "/"));
  bar.replaceChildren(
    h("span", { class: "path-crumbs" }, crumbs, h("span", { class: "path-leaf" }, basename(path))),
    h("button", { class: "btn small", title: "Copy the full path", onclick: () => copyPath(path) }, "Copy Path"));
}
