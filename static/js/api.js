// Backend calls and URL builders. Mutations carry the CSRF header (the server rejects them otherwise).

const CSRF = { "X-Remote-Finder": "1" };

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function handle(res) {
  if (res.ok) return res.headers.get("content-type")?.includes("json") ? res.json() : res.text();
  let msg = res.statusText;
  try {
    const body = await res.json();
    msg = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
  } catch {
    try { msg = await res.text(); } catch {}
  }
  throw new ApiError(res.status, msg || `HTTP ${res.status}`);
}

export const qs = (params) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((x) => u.append(k, x));
    else u.append(k, v);
  }
  return u.toString();
};

export const get = (path, params = {}, opts = {}) => fetch(`${path}?${qs(params)}`, opts).then(handle);

/** JSON request that changes something. `keepalive` lets it finish while the page unloads. */
export const send = (method, path, body, { keepalive = false } = {}) =>
  fetch(path, {
    method,
    keepalive,
    headers: { "Content-Type": "application/json", ...CSRF },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(handle);

export const post = (path, body) => send("POST", path, body);
export const put = (path, body, opts) => send("PUT", path, body, opts);

/** GET an NDJSON stream; onBatch(messages) runs per network chunk and may return false to stop. */
export async function streamNdjson(path, params, { signal, onBatch }) {
  const res = await fetch(`${path}?${qs(params)}`, { signal });
  if (!res.ok) await handle(res);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    if (onBatch(lines.filter(Boolean).map((l) => JSON.parse(l))) === false) return reader.cancel();
  }
}

export const rawUrl = (path, extra = {}) => `/api/raw?${qs({ path, ...extra })}`;
export const thumbUrl = (path, size, mtime) => `/api/thumb?${qs({ path, size, v: Math.floor(mtime || 0) })}`;
/** Query string for page URLs, leaving "/" readable so the address bar shows the path. */
export const pageQuery = (params) => qs(params).replace(/%2F/gi, "/");
export const viewerUrl = (path) => `/viewer.html?${pageQuery({ path })}`;
export const editorUrl = (path) => `/editor.html?${pageQuery({ path })}`;
export const duUrl = (path) => `/du.html?${pageQuery({ path })}`;
export const tailUrl = (path, mode = "tail") => `/tail.html?${pageQuery({ path, mode })}`;
export const folderUrl = (path) => `/#${encodeURIComponent(path).replace(/%2F/g, "/")}`;
export const entryUrl = (entry) => (entry.kind === "dir" ? folderUrl(entry.path) : viewerUrl(entry.path));
export const wsUrl = (path, params) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}?${qs(params)}`;

export function waitJob(job, onProgress) {
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const j = await get(`/api/jobs/${job.id}`);
        onProgress?.(j);
        if (j.status === "running") return setTimeout(tick, 350);
        if (j.status === "done") resolve(j);
        else reject(Object.assign(new Error(j.error || j.status), { job: j }));
      } catch (e) { reject(e); }
    };
    tick();
  });
}

// Stream an upload with progress (fetch can't report upload progress).
export function uploadFile(file, dir, relpath, conflict, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/upload?${qs({ dir, relpath, conflict })}`);
    for (const [k, v] of Object.entries(CSRF)) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded, e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else {
        let msg = xhr.statusText;
        try { msg = JSON.parse(xhr.responseText).detail; } catch {}
        reject(new ApiError(xhr.status, msg));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "network error"));
    xhr.onabort = () => reject(new ApiError(0, "cancelled"));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}
