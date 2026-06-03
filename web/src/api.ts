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

const API_BASE = "/rest";

function md5(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const words: number[] = [];
  for (let i = 0; i < (bytes.length + 8) >> 6; i++) {
    const block: number[] = [];
    for (let j = 0; j < 64; j += 4) {
      block.push(
        (bytes[i * 64 + j] || 0) | ((bytes[i * 64 + j + 1] || 0) << 8) |
        ((bytes[i * 64 + j + 2] || 0) << 16) | ((bytes[i * 64 + j + 3] || 0) << 24)
      );
    }
    if (i === ((bytes.length + 8) >> 6) - 1) {
      const bitLen = bytes.length * 8;
      const idx = (bitLen >> 5) % 16;
      block[idx] |= 0x80 << (bitLen % 32);
      block[14] = bitLen;
    }
    words.push(...block);
  }
  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const K: number[] = [];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);
  for (let i = 0; i < words.length; i += 16) {
    let aa = a, bb = b, cc = c, dd = d;
    for (let j = 0; j < 64; j++) {
      let f: number, g: number;
      if (j < 16) { f = (b & c) | (~b & d); g = j; }
      else if (j < 32) { f = (d & b) | (~d & c); g = (5 * j + 1) % 16; }
      else if (j < 48) { f = b ^ c ^ d; g = (3 * j + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * j) % 16; }
      const temp = d; d = c; c = b;
      b = b + ((a + f + K[j] + words[i + g]) << S[(j >> 4) * 4 + j % 4] | (a + f + K[j] + words[i + g]) >>> (32 - S[(j >> 4) * 4 + j % 4]));
      a = temp;
    }
    a += aa; b += bb; c += cc; d += dd;
  }
  return [a, b, c, d].map((x) => {
    const v = (x >>> 0);
    return ((v & 0xff).toString(16).padStart(2, "0") + ((v >>> 8) & 0xff).toString(16).padStart(2, "0") + ((v >>> 16) & 0xff).toString(16).padStart(2, "0") + ((v >>> 24) & 0xff).toString(16).padStart(2, "0"));
  }).join("");
}

interface LoginResult { ok: boolean; name?: string; level?: number; error?: string; }

export function useAuth() {
  const token = ref(localStorage.getItem("edgesonic_auth") || "");
  const username = ref(localStorage.getItem("edgesonic_user") || "");
  const level = ref(parseInt(localStorage.getItem("edgesonic_level") || "0"));
  const salt = ref("");

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
    // Web login: POST master_password → get session token
    const resp = await fetch(`${API_BASE}/loginWeb`, {
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

  async function authFetch(path: string, params?: Record<string, string>): Promise<string> {
    const s = Array.from({ length: 10 }, () => Math.random().toString(36)[2]).join("");
    const qs = new URLSearchParams({
      u: username.value, t: token.value, s, v: "1.16.1", c: "EdgeSonicWeb",
      ...params,
    });
    const resp = await fetch(`${API_BASE}/${path}?${qs.toString()}`);
    return resp.text();
  }

  async function authPost(path: string, body: unknown): Promise<string> {
    const s = Array.from({ length: 10 }, () => Math.random().toString(36)[2]).join("");
    const qs = new URLSearchParams({
      u: username.value, t: token.value, s, v: "1.16.1", c: "EdgeSonicWeb",
    });
    const resp = await fetch(`${API_BASE}/${path}?${qs.toString()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return resp.text();
  }

  async function uploadFile(file: File, target: string, path?: string, masterId?: string): Promise<string> {
    const s = Array.from({ length: 10 }, () => Math.random().toString(36)[2]).join("");
    const qs = new URLSearchParams({
      u: username.value, t: token.value, s, v: "1.16.1", c: "EdgeSonicWeb",
    });
    const formData = new FormData();
    formData.append("file", file);
    formData.append("target", target);
    if (path) formData.append("path", path);
    if (masterId) formData.append("master_id", masterId);

    const resp = await fetch(`${API_BASE}/upload?${qs.toString()}`, {
      method: "POST",
      body: formData,
    });
    return resp.text();
  }

  return { token, username, level, salt, isLoggedIn, isAdmin, isSuperAdmin, isGuest, isUser,
    login, logout, authFetch, authPost, uploadFile, makeSalt, md5 };
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
