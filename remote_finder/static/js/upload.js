// Uploads: file picker, folder picker, desktop drag-and-drop (files and folders), with progress.
import { post, uploadFile } from "./api.js";
import { progressToast, resolveConflicts, toast, toastError } from "./dialogs.js";
import { refresh } from "./nav.js";
import { state } from "./state.js";
import { basename, fmtSize, h, join } from "./util.js";

const PARALLEL = 3;

export function pickFiles(dir, folder = false) {
  const input = h("input", { type: "file", multiple: true, style: { display: "none" } });
  if (folder) input.webkitdirectory = true;
  input.addEventListener("change", () => {
    const files = [...input.files].map((f) => ({ file: f, rel: f.webkitRelativePath || f.name }));
    input.remove();
    if (files.length) uploadAll(files, dir);
  });
  document.body.append(input);
  input.click();
}

/** Read a DataTransfer (desktop drop), walking dropped folders. */
export async function uploadDataTransfer(dt, dir) {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  const out = [];
  if (!entries.length) {
    for (const f of dt.files) out.push({ file: f, rel: f.name });
  } else {
    const walk = async (entry, prefix) => {
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        out.push({ file, rel: prefix + entry.name });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
        } while (batch.length);
      }
    };
    for (const e of entries) await walk(e, "");
  }
  if (out.length) return uploadAll(out, dir);
}

export async function uploadAll(files, dir) {
  const tops = [...new Set(files.map((f) => f.rel.split("/")[0]))];
  let decisions = {};
  try {
    const { conflicts } = await post("/api/conflicts", { dest: dir, names: tops });
    if (conflicts.length) {
      decisions = await resolveConflicts(conflicts, basename(dir) || "/");
      if (!decisions) return;
    }
  } catch (e) { return toastError(e); }

  // "keep both" for a folder: upload under a fresh top-level name
  const rename = {};
  for (const [name, action] of Object.entries(decisions)) {
    if (action === "keep") {
      let i = 2;
      const dot = name.lastIndexOf(".");
      const isFolder = files.some((f) => f.rel.startsWith(name + "/"));
      const stem = !isFolder && dot > 0 ? name.slice(0, dot) : name;
      const ext = !isFolder && dot > 0 ? name.slice(dot) : "";
      let cand;
      do { cand = `${stem} ${i++}${ext}`; } while (tops.includes(cand));
      rename[name] = cand;
    }
  }
  const jobs = files
    .filter((f) => decisions[f.rel.split("/")[0]] !== "skip")
    .map((f) => {
      const top = f.rel.split("/")[0];
      return { ...f, rel: rename[top] ? rename[top] + f.rel.slice(top.length) : f.rel };
    });
  if (!jobs.length) return;

  const total = jobs.reduce((s, j) => s + j.file.size, 0);
  const loaded = new Map();
  const ctrl = new AbortController();
  const progress = progressToast(`Uploading ${jobs.length} file(s) to “${basename(dir) || "/"}”`, () => ctrl.abort());
  progress.show();
  const update = (name) => {
    const done = [...loaded.values()].reduce((a, b) => a + b, 0);
    progress.update(total ? done / total : 1, `${fmtSize(done)} of ${fmtSize(total)}${name ? ` — ${name}` : ""}`);
  };

  let failed = 0, i = 0;
  const worker = async () => {
    while (i < jobs.length && !ctrl.signal.aborted) {
      const j = jobs[i++];
      try {
        await uploadFile(j.file, dir, j.rel, "replace", (l) => { loaded.set(j.rel, l); update(j.rel); }, ctrl.signal);
        loaded.set(j.rel, j.file.size);
      } catch (e) {
        if (ctrl.signal.aborted) break;
        failed++;
        toastError(`${j.rel}: ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  progress.close();
  if (ctrl.signal.aborted) toast("Upload cancelled");
  else if (!failed) toast(`Uploaded ${jobs.length} file(s)`, { timeout: 2500 });
  if (dir === state.path) refresh({ select: [...new Set(jobs.map((j) => join(dir, j.rel.split("/")[0])))] });
}
