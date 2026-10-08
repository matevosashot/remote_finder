// Finder-style keyboard shortcuts (Mod = Ctrl or Cmd). Disabled while typing or in the terminal.
import * as A from "./actions.js";
import { promptDialog } from "./dialogs.js";
import { exitSearch, goBack, goForward, goUp, navigate } from "./nav.js";
import * as QL from "./quicklook.js";
import { quickOpen } from "./quickopen.js"; // static: a lazy import would drop keys typed right after Ctrl+P
import { clearSelection, selectAll, typeSelect } from "./selection.js";
import { setOption } from "./settings.js";
import { state } from "./state.js";
import { canEdit, join, mod } from "./util.js";

const VIEW_KEYS = ["icons", "list", "columns", "gallery"]; // Alt+1..4

const typing = (el) => el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.closest?.(".term-panel, .menu, .dialog"));

export function initKeyboard({ getView, focusSearch }) {
  document.addEventListener("keydown", async (e) => {
    // global, even inside inputs (but not the terminal: it handles Ctrl+` itself)
    if (e.ctrlKey && e.key === "`") { e.preventDefault(); return (await import("./terminal.js")).toggleTerminal(); }
    if (document.querySelector(".overlay")) return; // a modal owns the keyboard
    if (QL.isOpen() && QL.key(e)) return;
    if (mod(e) && !e.shiftKey && e.key.toLowerCase() === "p") { e.preventDefault(); return quickOpen(); }
    if (typing(document.activeElement)) return;

    const k = e.key;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    const sel = A.selected();
    const one = sel.length === 1 ? sel[0] : null;

    if (mod(e) && e.shiftKey && e.code === "Period") { handled(); return setOption("showHidden", !state.showHidden); }
    if (mod(e) && e.shiftKey && k.toLowerCase() === "g") { handled(); return goToFolder(); }
    if (e.altKey && e.shiftKey && e.code === "KeyN") { handled(); return A.newFolder(); }
    if (e.altKey && !mod(e) && /^Digit[1-4]$/.test(e.code)) { handled(); return setOption("view", VIEW_KEYS[+e.code.slice(-1) - 1]); }

    if (mod(e)) {
      const low = k.toLowerCase();
      const textSelected = !!window.getSelection()?.toString();
      if (e.altKey && e.code === "KeyC") { handled(); return A.copyPaths("path"); }
      switch (low) {
        case "a": handled(); return selectAll();
        case "o": handled(); return A.openSelected();
        case "i": handled(); return A.getInfo(one || undefined);
        case "e": if (canEdit(one)) { handled(); return A.edit(one); } return;
        case "f": handled(); return focusSearch();
        case "c": if (!textSelected && state.selection.size) { handled(); return A.copyItems("copy"); } return;
        case "x": if (!textSelected && state.selection.size) { handled(); return A.copyItems("move"); } return;
        case "v": if (state.clipboard) { handled(); return A.paste(); } return;
        case "[": handled(); return goBack();
        case "]": handled(); return goForward();
        case "arrowup": handled(); return goUp();
        case "arrowdown": handled(); return A.openSelected();
        case "backspace": handled(); return A.remove();
      }
      return;
    }
    if (e.altKey) return;

    switch (k) {
      case " ": handled(); return QL.quickLook();
      case "Enter": if (one && !state.search) { handled(); A.rename(one); } else if (one) { handled(); A.revealInFolder(one.path); } return;
      case "Delete": handled(); return A.remove();
      case "Backspace": handled(); return goUp();
      case "Escape":
        if (state.search) { handled(); exitSearch(); return; }
        handled(); return clearSelection();
      case "/": handled(); return focusSearch();
    }
    if (getView()?.key(e)) return handled();
    if (k.length === 1 && !e.ctrlKey && !e.metaKey && /\S/.test(k)) typeSelect(k);
  });
}

export async function goToFolder() {
  const v = await promptDialog("Go to the folder:", state.path, { ok: "Go" });
  if (!v) return;
  const path = v.trim().replace(/^~(?=\/|$)/, state.home);
  try {
    await navigate(path.startsWith("/") ? path : join(state.path, path));
  } catch {}
}
