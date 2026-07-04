import { ref, computed } from "vue";

// 055 — API surface split into 4 buckets. /rest stays Subsonic; everything
// management-shaped moved to /tag, /storage, /edgesonic.
const REST_BASE = "/rest";
const TAG_BASE = "/tag";
const STORAGE_BASE = "/storage";
const EDGESONIC_BASE = "/edgesonic";

export function md5(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const nblk = ((bytes.length + 8) >> 6) + 1;
  const x = new Array<number>(nblk * 16).fill(0);
  for (let i = 0; i < bytes.length; i++) x[i >> 2] |= bytes[i] << ((i % 4) * 8);
  x[bytes.length >> 2] |= 0x80 << ((bytes.length % 4) * 8);
  x[nblk * 16 - 2] = bytes.length * 8;

  const rotl = (n: number, s: number) => (n << s) | (n >>> (32 - s));
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const K: number[] = [];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0;

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  for (let i = 0; i < x.length; i += 16) {
    const aa = a, bb = b, cc = c, dd = d;
    for (let j = 0; j < 64; j++) {
      let f: number, g: number;
      if (j < 16) { f = (b & c) | (~b & d); g = j; }
      else if (j < 32) { f = (d & b) | (~d & c); g = (5 * j + 1) % 16; }
      else if (j < 48) { f = b ^ c ^ d; g = (3 * j + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * j) % 16; }
      const tmp = d;
      d = c; c = b;
      b = (b + rotl((a + f + K[j] + x[i + g]) | 0, S[(j >> 4) * 4 + (j % 4)])) | 0;
      a = tmp;
    }
    a = (a + aa) | 0; b = (b + bb) | 0; c = (c + cc) | 0; d = (d + dd) | 0;
  }
  return [a, b, c, d].map((n) => {
    const v = n >>> 0;
    return ((v & 0xff).toString(16).padStart(2, "0") + ((v >>> 8) & 0xff).toString(16).padStart(2, "0") + ((v >>> 16) & 0xff).toString(16).padStart(2, "0") + ((v >>> 24) & 0xff).toString(16).padStart(2, "0"));
  }).join("");
}

interface LoginResult { ok: boolean; name?: string; level?: number; error?: string; }

// Module-level singleton state so every component shares the same reactive auth.
const token = ref(localStorage.getItem("edgesonic_auth") || "");
const username = ref(localStorage.getItem("edgesonic_user") || "");
const level = ref(parseInt(localStorage.getItem("edgesonic_level") || "0"));
const salt = ref("");

export function useAuth() {
  const isLoggedIn = computed(() => !!token.value);
  const isAdmin = computed(() => level.value >= 2);
  const isSuperAdmin = computed(() => level.value >= 3);
  const isGuest = computed(() => level.value === 0);
  const isUser = computed(() => level.value >= 1);

  function makeSalt() {
    salt.value = Array.from({ length: 10 }, () => Math.random().toString(36)[2]).join("");
    return salt.value;
  }

  async function login(u: string, p: string): Promise<LoginResult> {
    // Web login: POST master_password → get session token (055 — moved to
    // /edgesonic/auth/login during the API four-bucket refactor).
    const resp = await fetch(`${EDGESONIC_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u, password: p }),
    });
    const data = await resp.json();
    if (data.ok) {
      token.value = data.sessionToken;
      username.value = data.username;
      level.value = data.level;
      localStorage.setItem("edgesonic_auth", data.sessionToken);
      localStorage.setItem("edgesonic_user", data.username);
      localStorage.setItem("edgesonic_level", String(data.level));
      return { ok: true, name: data.username, level: data.level };
    }
    return { ok: false, error: data.error || "Login failed" };
  }

  function logout() {
    token.value = ""; username.value = ""; level.value = 0;
    localStorage.removeItem("edgesonic_auth");
    localStorage.removeItem("edgesonic_user");
    localStorage.removeItem("edgesonic_level");
  }

  /** Build standard Subsonic auth params, freshly signed per call: t = md5(sessionToken + salt). */
  function signedParams(extra?: Record<string, string>): URLSearchParams {
    const s = Array.from({ length: 10 }, () => Math.random().toString(36)[2]).join("");
    return new URLSearchParams({
      u: username.value, t: md5(token.value + s), s, v: "1.16.1", c: "EdgeSonicWeb",
      ...extra,
    });
  }

  /** Build a fully signed /rest URL (for <audio src>, <img src>, download links…). */
  function restUrl(path: string, params?: Record<string, string>): string {
    return `${REST_BASE}/${path}?${signedParams(params).toString()}`;
  }

  function streamUrl(songId: string): string {
    return restUrl("stream", { id: songId });
  }

  function coverArtUrl(coverId: string, size?: number): string {
    return restUrl("getCoverArt", { id: coverId, ...(size ? { size: String(size) } : {}) });
  }

  // -------- Subsonic protocol (/rest/*) --------
  async function authFetch(path: string, params?: Record<string, string>): Promise<string> {
    const resp = await fetch(`${REST_BASE}/${path}?${signedParams(params).toString()}`);
    return resp.text();
  }

  async function authPost(path: string, body: unknown): Promise<string> {
    const resp = await fetch(`${REST_BASE}/${path}?${signedParams().toString()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return resp.text();
  }

  // 055 — Bucket-aware helpers. Same signature as authFetch/authPost so the
  // call sites only need to swap function names + paths.
  async function fetchAt(base: string, path: string, params?: Record<string, string>): Promise<string> {
    const resp = await fetch(`${base}/${path}?${signedParams(params).toString()}`);
    return resp.text();
  }
  async function postAt(base: string, path: string, body: unknown): Promise<string> {
    const resp = await fetch(`${base}/${path}?${signedParams().toString()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return resp.text();
  }

  const tagFetch = (path: string, params?: Record<string, string>) => fetchAt(TAG_BASE, path, params);
  const tagPost = (path: string, body: unknown) => postAt(TAG_BASE, path, body);
  const storageFetch = (path: string, params?: Record<string, string>) => fetchAt(STORAGE_BASE, path, params);
  const storagePost = (path: string, body: unknown) => postAt(STORAGE_BASE, path, body);
  const edgesonicFetch = (path: string, params?: Record<string, string>) => fetchAt(EDGESONIC_BASE, path, params);
  const edgesonicPost = (path: string, body: unknown) => postAt(EDGESONIC_BASE, path, body);

  // === Tag edit helpers (task 039) — thin sugar over authFetch/authPost ===
  // readTags returns the latest known song row (used by editors to prefill).
  async function readTags(id: string): Promise<Record<string, string> | null> {
    const xml = await authFetch("getSong", { id });
    const m = /<song\s+([^>]+?)\s*\/?>/.exec(xml);
    if (!m) return null;
    const attrs: Record<string, string> = {};
    const attrRe = /(\w+)="([^"]*)"/g;
    let am;
    while ((am = attrRe.exec(m[1]))) attrs[am[1]] = am[2];
    return attrs;
  }

  interface WriteTagsResult { ok: boolean; error?: string; files?: Array<{ instanceId: string; uri: string; written: boolean; reason?: string }>; masterId?: string; }
  // `cover.data` is the raw base64 string (no data: prefix); the worker accepts
  // either form. 042 ships ≤500KB JPEG/PNG produced by the canvas compressor
  // in TagEditor.vue.
  async function writeTags(
    id: string,
    tags: Record<string, string | number>,
    cover?: { data: string; mime: string },
  ): Promise<WriteTagsResult> {
    const body: Record<string, unknown> = { id, tags };
    if (cover) { body.coverData = cover.data; body.coverMime = cover.mime; }
    return JSON.parse(await tagPost("write", body));
  }

  interface BatchWriteResult { ok: boolean; error?: string; succeeded?: number; failed?: number; results?: Array<{ id: string; ok: boolean; error?: string; masterId?: string }>; }
  async function batchWriteTags(
    ids: string[],
    patch: Record<string, string | number>,
    cover?: { data: string; mime: string },
  ): Promise<BatchWriteResult> {
    const body: Record<string, unknown> = { ids, patch };
    if (cover) { body.coverData = cover.data; body.coverMime = cover.mime; }
    return JSON.parse(await tagPost("batchWrite", body));
  }

  // 042 — tidy folder via template; dryRun:true returns plan only.
  interface TidyFolderResult {
    ok: boolean;
    error?: string;
    planned?: Array<{ id: string; instanceId: string; from: string; to: string; skipped?: string }>;
    applied?: Array<{ id: string; instanceId: string; ok: boolean; error?: string }>;
    failed?: number;
    dryRun?: boolean;
  }
  async function tidyFolder(
    ids: string[],
    template: string,
    opts?: { dryRun?: boolean; source?: "r2" | "webdav" },
  ): Promise<TidyFolderResult> {
    return JSON.parse(await tagPost("tidyFolder", { ids, template, dryRun: !!opts?.dryRun, source: opts?.source }));
  }

  // 041 — submit browser-parsed metadata for an instance (OGG/Opus/M4A/...).
  // `tags` is an ExtractedMetadata shape from web/src/lib/metadata.ts.
  interface SubmitMetadataResult { ok: boolean; error?: string; masterId?: string; albumId?: string; artistId?: string; }
  async function submitMetadata(instanceId: string, tags: Record<string, string | number>): Promise<SubmitMetadataResult> {
    return JSON.parse(await tagPost("submit", { instanceId, tags }));
  }

  // 089/S4 — XHR-based upload exposes onProgress for per-file progress bars.
  // Auth is via signedParams() query string (same as all other storage calls).
  async function uploadFile(
    file: File,
    target: string,
    path?: string,
    opts?: { masterId?: string; onProgress?: (loaded: number, total: number) => void },
  ): Promise<string> {
    const qs = signedParams();
    qs.set("name", file.name);
    qs.set("source", target);
    if (path) qs.set("path", path);
    if (opts?.masterId) qs.set("master_id", opts.masterId);
    // 055 — moved from /rest/files/upload to /storage/files/upload
    return new Promise<string>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${STORAGE_BASE}/files/upload?${qs.toString()}`);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      if (opts?.onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) opts.onProgress!(e.loaded, e.total);
        };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
        else reject(new Error(`Upload failed: ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error("Upload network error"));
      xhr.send(file);
    });
  }

  // 089/S4 — Cross-source copy: POST /storage/files/crossCopy with JSON body.
  // Throws with the backend error message when ok:false so callers can surface it.
  // 093f — optional registerInstance for the mirror-to-R2 flow: when present,
  // the backend also creates a song_instances row for the new R2 copy.
  interface CrossCopyResult { ok: boolean; destUri?: string; instanceId?: string; error?: string; }
  interface RegisterInstanceOpts {
    masterId: string; suffix: string; contentType: string; size: number; sourceInstanceId: string;
  }
  async function crossCopy(
    srcUri: string,
    destSource: string,
    destPath: string,
    registerInstance?: RegisterInstanceOpts,
  ): Promise<CrossCopyResult> {
    const text = await storagePost("files/crossCopy", {
      srcUri, destSource, destPath,
      ...(registerInstance ? { registerInstance } : {}),
    });
    const data: CrossCopyResult = JSON.parse(text);
    if (!data.ok) throw new Error(data.error || "Cross-copy failed");
    return data;
  }

  return { token, username, level, salt, isLoggedIn, isAdmin, isSuperAdmin, isGuest, isUser,
    login, logout, authFetch, authPost, uploadFile, crossCopy, makeSalt, md5,
    tagFetch, tagPost, storageFetch, storagePost, edgesonicFetch, edgesonicPost,
    readTags, writeTags, batchWriteTags, submitMetadata, tidyFolder,
    signedParams, restUrl, streamUrl, coverArtUrl };
}

/** Parse XML tag attributes into array of objects */
export function parseXmlAttrs(xml: string, tag: string): Record<string, string>[] {
  const items: Record<string, string>[] = [];
  const re = new RegExp(`<${tag}\\s+([^>]+?)\\s*/?>`, "g");
  let m;
  while ((m = re.exec(xml))) {
    const attrs: Record<string, string> = {};
    const attrRe = /(\w+)="([^"]*)"/g;
    let am;
    while ((am = attrRe.exec(m[1]))) {
      attrs[am[1]] = am[2];
    }
    items.push(attrs);
  }
  return items;
}

/** Extract inner XML of a tag */
export function parseXmlInner(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = re.exec(xml);
  return m ? m[1] : "";
}

/** Format seconds to mm:ss */
export function formatDuration(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

/** Format bytes to human readable */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
