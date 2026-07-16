// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

import { ref, computed } from "vue";
import { useRouter } from "vue-router";

// management-shaped moved to /tag, /storage, /edgesonic.
const REST_BASE = "/rest";
const TAG_BASE = "/tag";
const STORAGE_BASE = "/storage";
const EDGESONIC_BASE = "/edgesonic";

function audioMimeFromName(name: string): string | null {
  const suffix = name.split(".").pop()?.toLowerCase() || "";
  switch (suffix) {
    case "flac": return "audio/flac";
    case "mp3": return "audio/mpeg";
    case "m4a": return "audio/mp4";
    case "aac": return "audio/aac";
    case "ogg": return "audio/ogg";
    case "opus": return "audio/opus";
    case "wav": return "audio/wav";
    default: return null;
  }
}

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
//
// After the httpOnly-cookie login upgrade the SPA no longer keeps the
// session token in JS-readable storage: the browser carries
// `edgesonic_session` as an HttpOnly+Secure+SameSite=Lax cookie and
// attaches it to every same-origin request (fetch / <audio> / <img> /
// XHR). `token` here is just a non-secret "I am logged in" flag held in
// localStorage so `isLoggedIn`, the router guard and the player store can
// answer "are we authenticated" without ever touching the credential
// itself. The backend rejects management calls whose cookie is expired,
// at which point handleAuthError logs out and bounces to /login.
const token = ref(localStorage.getItem("edgesonic_logged_in") || "");
const username = ref(localStorage.getItem("edgesonic_user") || "");
const level = ref(parseInt(localStorage.getItem("edgesonic_level") || "0"));
const salt = ref("");

export function useAuth() {
  // useRouter() must run inside a component setup; useAuth() is always called
  // from setup so this is safe. Used by handleAuthError to force /login on
  // session expiry without every call site re-implementing the redirect.
  const router = useRouter();
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
    // /edgesonic/auth/login sets the `edgesonic_session` HttpOnly cookie
    // (see worker/src/endpoints/edgesonic/auth.ts) AND returns the
    // sessionToken in JSON — the SPA keeps only the non-secret username +
    // level + a boolean "logged in" marker in localStorage. The cookie
    // itself is unreadable from JS so an XSS can no longer exfiltrate the
    // credential the way it could when it was sitting in localStorage.
    const resp = await fetch(`${EDGESONIC_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ username: u, password: p }),
    });
    const data = await resp.json();
    if (data.ok) {
      token.value = "1";
      username.value = data.username;
      level.value = data.level;
      localStorage.setItem("edgesonic_logged_in", "1");
      localStorage.setItem("edgesonic_user", data.username);
      localStorage.setItem("edgesonic_level", String(data.level));
      return { ok: true, name: data.username, level: data.level };
    }
    return { ok: false, error: data.error || "Login failed" };
  }

  async function logout() {
    token.value = ""; username.value = ""; level.value = 0;
    localStorage.removeItem("edgesonic_logged_in");
    localStorage.removeItem("edgesonic_user");
    localStorage.removeItem("edgesonic_level");
    // Best-effort: clear the cookie + delete the session row server-side.
    // If the request fails (offline, worker down) the SPA-side state is
    // already cleared; the cookie will lapse at its natural 24h expiry
    // and can't be re-used because the row still exists but the SPA's
    // logged-in flag is gone so the user is back at /login anyway.
    try {
      await fetch(`${EDGESONIC_BASE}/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({}),
      });
    } catch {
      // swallow — see above
    }
  }

  /**
   * Build the Subsonic protocol params for an SPA-side URL or fetch.
   *
   * Post httpOnly-cookie upgrade: the SPA relies on the `edgesonic_session`
   * cookie attached to every same-origin request for authentication. No `u`,
   * `t`, or `s` parameters are needed; credentials flow via the cookie.
   * We emit `v`/`c` for format detection and Subsonic spec compliance.
   *
   * A value can be a string[] to emit the same key multiple times (Subsonic's
   * convention for repeatable params like createShare/star's `id`).
   */
  function signedParams(extra?: Record<string, string | string[]>): URLSearchParams {
    const params = new URLSearchParams({
      v: "1.16.1", c: "EdgeSonicWeb",
    });
    for (const [key, value] of Object.entries(extra ?? {})) {
      if (Array.isArray(value)) {
        for (const v of value) params.append(key, v);
      } else {
        params.append(key, value);
      }
    }
    return params;
  }

  /** Build a fully signed /rest URL (for <audio src>, <img src>, download links…). */
  function restUrl(path: string, params?: Record<string, string | string[]>): string {
    return `${REST_BASE}/${path}?${signedParams(params).toString()}`;
  }

  function streamUrl(songId: string): string {
    return restUrl("stream", { id: songId });
  }

  function coverArtUrl(coverId: string, size?: number): string {
    return restUrl("getCoverArt", { id: coverId, ...(size ? { size: String(size) } : {}) });
  }

  function downloadUrl(songId: string): string {
    return restUrl("download", { id: songId });
  }

  // -------- Subsonic protocol (/rest/*) --------
  async function authFetch(path: string, params?: Record<string, string | string[]>): Promise<string> {
    const resp = await fetch(`${REST_BASE}/${path}?${signedParams(params).toString()}`, {
      credentials: "same-origin",
    });
    if (resp.status === 401 || resp.status === 403) {
      handleAuthError(new Error("session expired"));
      return "";
    }
    return resp.text();
  }

  async function authPost(path: string, body: unknown): Promise<string> {
    const resp = await fetch(`${REST_BASE}/${path}?${signedParams().toString()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
    if (resp.status === 401 || resp.status === 403) {
      handleAuthError(new Error("session expired"));
      return "";
    }
    return resp.text();
  }

  // call sites only need to swap function names + paths.
  // Auth failures (401/403) are surfaced as a typed error so the caller can
  // distinguish "session expired" from "request failed" and toast + redirect
  // accordingly (see handleAuthError). The body is still text() so XML-shaped
  // /rest errors keep working for Subsonic callers.
  async function fetchAt(base: string, path: string, params?: Record<string, string>, signal?: AbortSignal): Promise<string> {
    const resp = await fetch(`${base}/${path}?${signedParams(params).toString()}`, {
      credentials: "same-origin",
      signal,
    });
    if (resp.status === 401 || resp.status === 403) {
      const err = new Error("session expired") as Error & { status: number };
      err.status = resp.status;
      throw err;
    }
    return resp.text();
  }
  async function postAt(base: string, path: string, body: unknown, signal?: AbortSignal): Promise<string> {
    const resp = await fetch(`${base}/${path}?${signedParams().toString()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      signal,
    });
    if (resp.status === 401 || resp.status === 403) {
      const err = new Error("session expired") as Error & { status: number };
      err.status = resp.status;
      throw err;
    }
    return resp.text();
  }

  // 401/403 from the management buckets means the web session is gone (expired
  // server-side or revoked). Centralises the logout + redirect so each call
  // site only has to toast + bail. Returns true when it handled the error so
  // callers can `if (handleAuthError(e)) return;`.
  function handleAuthError(e: unknown): boolean {
    const status = (e as { status?: number })?.status;
    if (status === 401 || status === 403) {
      logout();
      router.push("/login");
      return true;
    }
    return false;
  }

  const tagFetch = (path: string, params?: Record<string, string>) => fetchAt(TAG_BASE, path, params);
  const tagPost = (path: string, body: unknown) => postAt(TAG_BASE, path, body);
  const storageFetch = (path: string, params?: Record<string, string>) => fetchAt(STORAGE_BASE, path, params);
  const storagePost = (path: string, body: unknown) => postAt(STORAGE_BASE, path, body);
  const edgesonicFetch = (path: string, params?: Record<string, string>, signal?: AbortSignal) => fetchAt(EDGESONIC_BASE, path, params, signal);
  const edgesonicPost = (path: string, body: unknown, signal?: AbortSignal) => postAt(EDGESONIC_BASE, path, body, signal);

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

  interface RescanResult { ok: boolean; error?: string; dispatched?: number; skipped?: number; }
  // Library.vue batch toolbar "重新扫描" action: force-requeues the
  // given song master ids' original instances for metadata re-parsing.
  async function rescanSongs(masterIds: string[]): Promise<RescanResult> {
    return JSON.parse(await tagPost("rescan", { ids: masterIds }));
  }

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
    return new Promise<string>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${STORAGE_BASE}/files/upload?${qs.toString()}`);
      xhr.setRequestHeader("Content-Type", file.type || audioMimeFromName(file.name) || "application/octet-stream");
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
    login, logout, handleAuthError, authFetch, authPost, uploadFile, crossCopy, makeSalt, md5,
    tagFetch, tagPost, storageFetch, storagePost, edgesonicFetch, edgesonicPost,
    readTags, writeTags, batchWriteTags, rescanSongs, submitMetadata, tidyFolder,
    signedParams, restUrl, streamUrl, coverArtUrl, downloadUrl };
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
