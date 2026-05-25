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

  function makeSalt() {
    salt.value = Array.from({ length: 10 }, () => Math.random().toString(36)[2]).join("");
    return salt.value;
  }

  async function login(u: string, p: string): Promise<LoginResult> {
    const s = makeSalt();
    const t = md5(p + s);
    const resp = await fetch(`${API_BASE}/ping?u=${encodeURIComponent(u)}&t=${t}&s=${s}&v=1.16.1&c=EdgeSonicWeb`);
    if (resp.ok) {
      token.value = t; username.value = u;
      localStorage.setItem("edgesonic_auth", t);
      localStorage.setItem("edgesonic_user", u);
      try {
        const ur = await authFetch("getUser", { username: u });
        const lv = parseInt(ur.match(/level="(\d+)"/)?.[1] || "0");
        level.value = lv;
        localStorage.setItem("edgesonic_level", String(lv));
      } catch {}
      return { ok: true, name: u, level: level.value };
    }
    const xml = await resp.text();
    const err = xml.match(/message="([^"]+)"/)?.[1] || "Unknown error";
    return { ok: false, error: err };
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
    const resp = await fetch(`${API_BASE}/${path}?${qs}`);
    return resp.text();
  }

  return { token, username, level, salt, isLoggedIn, isAdmin, login, logout, authFetch, makeSalt };
}
