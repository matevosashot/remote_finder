// "Update available" banner: the server checks GitHub at most once a day, when the main window opens.
import { get, post } from "./api.js";
import { toastError } from "./dialogs.js";
import { h, store } from "./util.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function checkForUpdate(after) {
  let u;
  try { u = await get("/api/update"); } catch { return; }
  if (!u.enabled || !u.behind || store.get("update.dismissed") === u.latest) return;

  const n = u.behind;
  const status = h("span", { class: "update-status" });
  const upgrade = h("button", { class: "btn small primary", onclick: () => install() }, "Upgrade");
  const later = h("button", { class: "btn small", onclick: () => { store.set("update.dismissed", u.latest); banner.remove(); } }, "Later");
  const notes = h("details", { class: "update-notes" }, h("summary", {}, "What's new"),
    h("ul", {}, u.commits.map((c) => h("li", {}, h("code", {}, c.sha), " ", c.message))));
  const banner = h("div", { class: "update-banner" },
    h("span", {}, h("b", {}, "Update available: "), `${n} new commit${n === 1 ? "" : "s"} on main.`),
    notes, h("span", { class: "spacer" }), status,
    u.kind === "pip" ? upgrade : h("span", { class: "muted" }, "Run git pull in the checkout to update."),
    later);
  after.after(banner);

  async function install() {
    upgrade.disabled = later.disabled = true;
    status.textContent = "Upgrading… (pip is installing the new version)";
    let r;
    try { r = await post("/api/update/install"); } catch (e) {
      upgrade.disabled = later.disabled = false;
      status.textContent = "";
      return toastError(e);
    }
    if (!r.restarting) { status.textContent = "Installed. Restart Remote Finder to use it."; return; }
    status.textContent = "Restarting…";
    await sleep(2000); // the old server lingers a moment before it restarts
    for (let i = 0; i < 120; i++) {
      try { await get("/api/home"); return location.reload(); } catch { await sleep(1000); }
    }
    status.textContent = "The server did not come back; check its logs.";
  }
}
