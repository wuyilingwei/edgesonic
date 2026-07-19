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

// EdgeSonic-private artist scrape surface. Sits under /edgesonic/* (web
// session) — deliberately NOT under /rest/* (OpenSubsonic protocol).
// Reasons:
//  - last.fm has poor coverage for CN artists, so getArtistInfo returns
//    almost nothing for them. These endpoints let the TagEditor / artist
//    detail page pull bio + cover from NetEase / QQ directly.
//  - Each route returns JSON shaped for direct UI consumption; no XML,
//    no Subsonic attribute mapping. Subsonic clients have no use for it.
//
//   POST /edgesonic/artistScrape/search   { source, query }
//   POST /edgesonic/artistScrape/cover    { source, artistId }
//   POST /edgesonic/artistScrape/bio      { source, artistId }
import { Hono } from "hono";
import type { User } from "../../types/entities";
import { timedFetch } from "../../utils/scrapeFetch";

export const artistScrapeRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

type ArtistSource = "netease" | "qmusic";
const VALID_SOURCES: ReadonlySet<ArtistSource> = new Set(["netease", "qmusic"]);

function isSource(s: unknown): s is ArtistSource {
  return typeof s === "string" && VALID_SOURCES.has(s as ArtistSource);
}

// ---------------------------------------------------------------------------
// POST /edgesonic/artistScrape/search
// Body: { source, query } → list of { id, name, cover? }
// ---------------------------------------------------------------------------
artistScrapeRoutes.post("/artistScrape/search", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ ok: false, error: "Auth required" }, 401);

  let body: { source?: string; query?: string };
  try { body = await c.req.json(); }
  catch { return c.json({ ok: false, error: "Invalid JSON body" }, 400); }
  if (!isSource(body.source)) return c.json({ ok: false, error: "Unknown or missing source" }, 400);
  if (!body.query || typeof body.query !== "string") {
    return c.json({ ok: false, error: "Missing query" }, 400);
  }

  try {
    const data = body.source === "netease"
      ? await searchNetEaseArtist(body.query)
      : await searchQMusicArtist(body.query);
    return c.json({ ok: true, source: body.source, artists: data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ ok: false, error: msg.slice(0, 300) }, 502);
  }
});

// ---------------------------------------------------------------------------
// POST /edgesonic/artistScrape/cover
// Body: { source, artistId } → { cover }
// ---------------------------------------------------------------------------
artistScrapeRoutes.post("/artistScrape/cover", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ ok: false, error: "Auth required" }, 401);

  let body: { source?: string; artistId?: string };
  try { body = await c.req.json(); }
  catch { return c.json({ ok: false, error: "Invalid JSON body" }, 400); }
  if (!isSource(body.source)) return c.json({ ok: false, error: "Unknown or missing source" }, 400);
  if (!body.artistId) return c.json({ ok: false, error: "Missing artistId" }, 400);

  try {
    const cover = body.source === "netease"
      ? await fetchNetEaseArtistCover(body.artistId)
      : await fetchQMusicArtistCover(body.artistId);
    return c.json({ ok: true, source: body.source, cover });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ ok: false, error: msg.slice(0, 300) }, 502);
  }
});

// ---------------------------------------------------------------------------
// POST /edgesonic/artistScrape/bio
// Body: { source, artistId } → { bio }
// ---------------------------------------------------------------------------
artistScrapeRoutes.post("/artistScrape/bio", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ ok: false, error: "Auth required" }, 401);

  let body: { source?: string; artistId?: string };
  try { body = await c.req.json(); }
  catch { return c.json({ ok: false, error: "Invalid JSON body" }, 400); }
  if (!isSource(body.source)) return c.json({ ok: false, error: "Unknown or missing source" }, 400);
  if (!body.artistId) return c.json({ ok: false, error: "Missing artistId" }, 400);

  try {
    const bio = body.source === "netease"
      ? await fetchNetEaseArtistBio(body.artistId)
      : await fetchQMusicArtistBio(body.artistId);
    return c.json({ ok: true, source: body.source, bio });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ ok: false, error: msg.slice(0, 300) }, 502);
  }
});

// ===========================================================================
// NetEase Cloud Music — artist endpoints (no auth, public web API).
// ===========================================================================

export interface NetEaseArtistSearch {
  id: number;
  name: string;
  picUrl?: string;
}

export async function searchNetEaseArtist(query: string): Promise<NetEaseArtistSearch[]> {
  const url = "https://music.163.com/api/search/get/web";
  const form = new URLSearchParams({ s: query, type: "100", offset: "0", limit: "20" });
  const resp = await timedFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": "https://music.163.com/",
    },
    body: form.toString(),
  });
  if (!resp.ok) throw new Error(`netease artist search HTTP ${resp.status}`);
  const json = (await resp.json()) as { result?: { artists?: Array<{ id: number; name: string; picUrl?: string }> } };
  const arr = json.result?.artists;
  if (!Array.isArray(arr)) return [];
  return arr.map((a) => ({
    id: typeof a.id === "number" ? a.id : parseInt(String(a.id), 10) || 0,
    name: a.name || "",
    picUrl: typeof a.picUrl === "string" && a.picUrl ? a.picUrl : undefined,
  })).filter((a) => a.id && a.name);
}

export async function fetchNetEaseArtistCover(artistId: string): Promise<string> {
  if (!/^\d+$/.test(artistId)) throw new Error("netease artistId must be numeric");
  // The artist detail endpoint returns picUrl + img1v1Url.
  const url = `https://music.163.com/api/artist/${artistId}`;
  const resp = await timedFetch(url, {
    method: "GET",
    headers: { "Referer": "https://music.163.com/" },
  });
  if (!resp.ok) throw new Error(`netease artist HTTP ${resp.status}`);
  const json = (await resp.json()) as { artist?: { picUrl?: string; img1v1Url?: string } };
  const cover = json.artist?.picUrl || json.artist?.img1v1Url;
  if (typeof cover !== "string" || !cover) throw new Error("netease artist has no cover");
  return cover;
}

export async function fetchNetEaseArtistBio(artistId: string): Promise<string> {
  if (!/^\d+$/.test(artistId)) throw new Error("netease artistId must be numeric");
  // /api/artist/desc?singerId=… returns briefDescription + introduction blocks.
  const url = `https://music.163.com/api/artist/desc?singerId=${artistId}`;
  const resp = await timedFetch(url, {
    method: "GET",
    headers: { "Referer": "https://music.163.com/" },
  });
  if (!resp.ok) throw new Error(`netease artist desc HTTP ${resp.status}`);
  const json = (await resp.json()) as {
    briefDesc?: string;
    introduction?: Array<{ ti?: string; b?: string }>;
  };
  const brief = typeof json.briefDesc === "string" ? json.briefDesc.trim() : "";
  const intro = Array.isArray(json.introduction)
    ? json.introduction
        .map((i) => (i.ti ? `${i.ti}\n${i.b || ""}` : (i.b || "")))
        .filter(Boolean)
        .join("\n\n")
    : "";
  const bio = (brief || intro).trim();
  if (!bio) throw new Error("netease artist has no bio");
  return bio;
}

// ===========================================================================
// QQ Music — artist endpoints (no auth, public soso/singer API).
// ===========================================================================

export interface QMusicArtistSearch {
  id: string; // singerMid (string, not numeric)
  name: string;
  cover?: string;
}

export async function searchQMusicArtist(query: string): Promise<QMusicArtistSearch[]> {
  // client_search_cp supports t=2 (singer) filter via the `t` parameter.
  const url =
    "https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&p=1&n=20&t=2&w=" +
    encodeURIComponent(query);
  const resp = await timedFetch(url, {
    method: "GET",
    headers: { "Referer": "https://y.qq.com/" },
  });
  if (!resp.ok) throw new Error(`qmusic artist search HTTP ${resp.status}`);
  const json = (await resp.json()) as {
    data?: { singer?: { list?: Array<{ mid?: string; name?: string; pic?: string }> } };
  };
  const arr = json.data?.singer?.list;
  if (!Array.isArray(arr)) return [];
  return arr.map((s) => ({
    id: typeof s.mid === "string" ? s.mid : "",
    name: typeof s.name === "string" ? s.name : "",
    cover: typeof s.pic === "string" && s.pic ? s.pic : undefined,
  })).filter((s) => s.id && s.name);
}

export async function fetchQMusicArtistCover(artistId: string): Promise<string> {
  if (!/^[A-Za-z0-9]{6,}$/.test(artistId)) throw new Error("qmusic singerMid invalid");
  // Artist detail JSON carries the singer head pic. Use the getCSRFWebView
  // data endpoint which is what y.qq.com itself hits.
  const url = `https://u.y.qq.com/cgi-bin/musicu.fcg?data=%7B%22comm%22%3A%7B%22ct%22%3A24%2C%22cv%22%3A0%7D%2C%22singer%22%3A%7B%22method%22%3A%22get_singer_detail%22%2C%22param%22%3A%7B%22singer_mid%22%3A%22${artistId}%22%2C%22order%22%3A1%7D%7D%7D`;
  const resp = await timedFetch(url, {
    method: "GET",
    headers: { "Referer": "https://y.qq.com/" },
  });
  if (!resp.ok) throw new Error(`qmusic artist detail HTTP ${resp.status}`);
  const json = (await resp.json()) as { singer?: { data?: { singer_mid?: string; pic?: string; pic_small?: string } } };
  const cover = json.singer?.data?.pic || json.singer?.data?.pic_small;
  if (typeof cover !== "string" || !cover) throw new Error("qmusic artist has no cover");
  return cover;
}

export async function fetchQMusicArtistBio(artistId: string): Promise<string> {
  if (!/^[A-Za-z0-9]{6,}$/.test(artistId)) throw new Error("qmusic singerMid invalid");
  // /singer/desc?singerId=… historically takes the numeric ID, but the mid
  // form is what the search returns. The SSE endpoint /singer/desc/?mid=...
  // returns HTML; we use the cgi endpoint for JSON-shaped desc instead.
  const url = `https://u.y.qq.com/cgi-bin/musicu.fcg?data=%7B%22comm%22%3A%7B%22ct%22%3A24%2C%22cv%22%3A0%7D%2C%22singer%22%3A%7B%22method%22%3A%22get_singer_desc%22%2C%22param%22%3A%7B%22singer_mid%22%3A%22${artistId}%22%7D%7D%7D`;
  const resp = await timedFetch(url, {
    method: "GET",
    headers: { "Referer": "https://y.qq.com/" },
  });
  if (!resp.ok) throw new Error(`qmusic artist desc HTTP ${resp.status}`);
  const json = (await resp.json()) as { singer?: { data?: { desc?: string; info?: { desc?: string } } } };
  const bio = (json.singer?.data?.desc || json.singer?.data?.info?.desc || "").trim();
  if (!bio) throw new Error("qmusic artist has no bio");
  return bio;
}