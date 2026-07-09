//
// The Subsonic API spec says: `f=xml` (default), `f=json`, or `f=jsonp`.
// Before 106, EdgeSonic ignored `f` entirely and always returned XML.
// Clients requesting `f=json` got an XML body, failed to parse it, and
// reported a connectivity/auth error.
//
// Strategy: mounted in index.ts on /rest/* BEFORE the auth middleware, so a
// single conversion point covers handler responses AND auth-failure envelopes.
// It lets the downstream chain produce its XML response, then converts the
// XML to JSON using a recursive descent parser tuned for the Subsonic XML
// subset. Binary endpoints (stream/getCoverArt/getAvatar/download) return
// non-XML content types and are passed through untouched.
//
// Navidrome docs + the reference music-tag-web instance):
//   * Numeric/boolean attributes must be emitted as JSON numbers/booleans
//     (`"duration":235`, `"adminRole":true`), NOT strings. XML loses types,
//     so we re-type by ATTRIBUTE NAME (value-shape guessing is unsafe: an
//     artist legitimately named "46" must stay a string).
//   * Known list children are ALWAYS arrays, even with one element
//     (`"album":[{...}]`). Array-ness depends on the PARENT tag: <album> is
//     an array inside <albumList2> but a single object at the response root
//     (getAlbum). We encode (parent, child) pairs.
//   * <versions> children of openSubsonicExtensions are arrays of ints.

import type { Context } from "hono";

export async function formatMiddleware(c: Context, next: () => Promise<void>): Promise<void> {
  await next();

  const format = (c.req.query("f") || "xml").toLowerCase();
  if (format !== "json" && format !== "jsonp") return;

  const ct = c.res.headers.get("Content-Type") || "";
  if (!ct.includes("xml")) return;

  const xml = await c.res.text();
  if (!xml || !xml.startsWith("<?xml")) return;

  const json = xmlToJson(xml);
  const body = format === "jsonp"
    ? `${c.req.query("callback") || "cb"}(${JSON.stringify(json)});`
    : JSON.stringify(json);

  c.res = new Response(body, {
    status: c.res.status,
    headers: {
      "Content-Type": format === "jsonp"
        ? "application/javascript; charset=UTF-8"
        : "application/json; charset=UTF-8",
    },
  });
}

// ---------------------------------------------------------------------------
// Attribute typing tables (107). Keyed by attribute NAME — the Subsonic XSD
// gives every attribute a fixed type, so a name uniquely determines it.
// Anything not listed stays a string (ids, names, dates, paths...).
// ---------------------------------------------------------------------------

// Ambiguous keys deliberately NOT listed: `current` (song ID string in
// playQueue), `count` (mixed roles), `expires` (ISO date string here).
const INT_KEYS = new Set([
  "songCount", "albumCount", "artistCount", "duration", "track", "discNumber",
  "year", "bitRate", "bitDepth", "samplingRate", "channelCount", "size",
  "playCount", "userRating", "visitCount", "position", "currentIndex",
  "offset", "totalHits", "code", "folder", "maxBitRate", "minutes",
  "avatarLastChanged", "start",
]);

const FLOAT_KEYS = new Set(["averageRating"]);

const BOOL_KEYS = new Set([
  "isDir", "isVideo", "valid", "public", "openSubsonic", "scanning",
  "scrobblingEnabled", "adminRole", "settingsRole", "downloadRole",
  "uploadRole", "playlistRole", "coverArtRole", "commentRole", "podcastRole",
  "streamRole", "jukeboxRole", "shareRole", "videoConversionRole", "synced",
]);

function typeValue(key: string, v: string): unknown {
  if (BOOL_KEYS.has(key)) {
    if (v === "true") return true;
    if (v === "false") return false;
    return v;
  }
  if (INT_KEYS.has(key)) {
    return /^-?\d+$/.test(v) ? Number(v) : v;
  }
  if (FLOAT_KEYS.has(key)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  return v;
}

// ---------------------------------------------------------------------------
// (parent, child) pairs whose child elements are ALWAYS JSON arrays, even
// when a single element (or zero) is present. Derived from the Subsonic
// 1.16.1 XSD list-typed elements + OpenSubsonic additions.
// ---------------------------------------------------------------------------

const ARRAY_PAIRS = new Set([
  "artists/index", "indexes/index", "indexes/shortcut", "indexes/child",
  "index/artist",
  "albumList/album", "albumList2/album", "artist/album",
  "searchResult2/album", "searchResult3/album", "starred/album", "starred2/album",
  "album/song", "searchResult2/song", "searchResult3/song",
  "starred/song", "starred2/song", "randomSongs/song", "songsByGenre/song",
  "topSongs/song", "similarSongs/song", "similarSongs2/song",
  "searchResult2/artist", "searchResult3/artist", "starred/artist", "starred2/artist",
  "artistInfo/similarArtist", "artistInfo2/similarArtist",
  "searchResult/match",
  "directory/child",
  "genres/genre",
  "musicFolders/musicFolder",
  "users/user",
  "playlists/playlist", "playlist/entry", "playQueue/entry",
  "share/entry", "nowPlaying/entry",
  "shares/share",
  "podcasts/channel", "channel/episode", "newestPodcasts/episode",
  "internetRadioStations/internetRadioStation",
  "bookmarks/bookmark",
  "subsonic-response/openSubsonicExtensions",
  "openSubsonicExtensions/versions",
  "lyricsList/structuredLyrics", "structuredLyrics/line",
  "tokenInfo/permission",
  "scanResult/source",
]);

// Leaf text children whose values are numeric per spec.
const INT_TEXT_TAGS = new Set(["versions"]);

// the XML has no such elements. Verified against the reference server:
// search results always carry artist/album/song arrays, empty or not, and
// clients index into them without guarding.
const EMPTY_ARRAY_DEFAULTS: Record<string, string[]> = {
  searchResult: ["match"],
  searchResult2: ["artist", "album", "song"],
  searchResult3: ["artist", "album", "song"],
};

// when they carry nothing but text. OpenSubsonic songLyrics `line` is
// `{"start":..,"value":".."}`; an unsynced line without attrs must still be
// `{"value":".."}`, not a bare string.
const OBJECT_TEXT_TAGS = new Set(["line"]);

// ---------------------------------------------------------------------------
// Lightweight Subsonic XML → JSON converter.
// ---------------------------------------------------------------------------

interface Node {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
  text: string;
}

export function xmlToJson(xml: string): Record<string, unknown> {
  const stripped = xml.replace(/^<\?xml[^>]*\?>\s*/, "");
  const tokens = tokenize(stripped.trim());
  const { node } = parseTree(tokens, 0);
  if (!node) return {};
  // Wrap in the root tag name (e.g. "subsonic-response") and strip xmlns
  // from the JSON output — Subsonic JSON clients don't expect xmlns.
  const inner = nodeToObject(node);
  delete inner["xmlns"];
  return { [node.tag]: inner };
}

function nodeToObject(n: Node): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n.attrs)) obj[k] = typeValue(k, v);
  const grouped: Record<string, Node[]> = {};
  for (const ch of n.children) {
    (grouped[ch.tag] ??= []).push(ch);
  }
  for (const [tag, items] of Object.entries(grouped)) {
    const forceArray = ARRAY_PAIRS.has(`${n.tag}/${tag}`);
    obj[tag] = forceArray || items.length > 1
      ? items.map(leafOrObject)
      : leafOrObject(items[0]);
  }
  for (const key of EMPTY_ARRAY_DEFAULTS[n.tag] ?? []) {
    if (!(key in obj)) obj[key] = [];
  }
  if (n.text.trim()) obj.value = n.text.trim();
  return obj;
}

function leafOrObject(n: Node): unknown {
  // through nodeToObject, even when they parsed as bare/empty leaves.
  if (n.tag in EMPTY_ARRAY_DEFAULTS || OBJECT_TEXT_TAGS.has(n.tag)) {
    const obj = nodeToObject(n);
    if (OBJECT_TEXT_TAGS.has(n.tag) && !("value" in obj)) obj.value = "";
    return obj;
  }
  if (n.children.length === 0 && Object.keys(n.attrs).length === 0) {
    // Pure text leaf (e.g. <genre>Rock</genre> → "Rock") OR empty element
    // (e.g. <playlists></playlists> → {}). An empty element with no text
    // and no attrs must be {} not "" so JSON clients can do .playlist on it.
    const text = n.text.trim();
    if (!text) return {};
    if (INT_TEXT_TAGS.has(n.tag) && /^-?\d+$/.test(text)) return Number(text);
    return text;
  }
  return nodeToObject(n);
}

// Tokenizer: produces a flat list of {type, ...} tokens.
type Token = { type: "open"; tag: string; attrs: Record<string, string>; selfClose: boolean } | { type: "close"; tag: string } | { type: "text"; value: string };

function tokenize(s: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "<") {
      // Comment?
      if (s.slice(i, i + 4) === "<!--") {
        const end = s.indexOf("-->", i);
        i = end === -1 ? s.length : end + 3;
        continue;
      }
      // Close tag?
      if (s[i + 1] === "/") {
        const end = s.indexOf(">", i);
        const tag = s.slice(i + 2, end).trim();
        tokens.push({ type: "close", tag });
        i = end + 1;
        continue;
      }
      // Open tag
      const end = findTagEnd(s, i);
      const content = s.slice(i + 1, end);
      const selfClose = s[end - 1] === "/";
      const tagContent = selfClose ? content.slice(0, -1).trim() : content.trim();
      const spaceIdx = tagContent.indexOf(" ");
      const tag = spaceIdx === -1 ? tagContent : tagContent.slice(0, spaceIdx);
      const attrStr = spaceIdx === -1 ? "" : tagContent.slice(spaceIdx + 1);
      const attrs = parseAttrs(attrStr);
      tokens.push({ type: "open", tag, attrs, selfClose });
      i = end + 1;
    } else {
      // Text
      const next = s.indexOf("<", i);
      const text = next === -1 ? s.slice(i) : s.slice(i, next);
      if (text.trim()) tokens.push({ type: "text", value: decodeEntities(text) });
      i = next === -1 ? s.length : next;
    }
  }
  return tokens;
}

function findTagEnd(s: string, start: number): number {
  let i = start + 1;
  let inQuote: string | null = null;
  while (i < s.length) {
    const ch = s[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ">") {
      return i;
    }
    i++;
  }
  return s.length - 1;
}

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z0-9_.:-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    attrs[m[1]] = decodeEntities(m[2]);
  }
  const re2 = /([a-zA-Z0-9_.:-]+)\s*=\s*'([^']*)'/g;
  while ((m = re2.exec(s)) !== null) {
    if (!(m[1] in attrs)) attrs[m[1]] = decodeEntities(m[2]);
  }
  return attrs;
}

// Recursive descent parser: builds a tree from tokens.
function parseTree(tokens: Token[], pos: number): { node: Node | null; next: number } {
  while (pos < tokens.length) {
    const tok = tokens[pos];
    if (tok.type === "text") { pos++; continue; }
    if (tok.type !== "open") return { node: null, next: pos };
    const node: Node = { tag: tok.tag, attrs: tok.attrs, children: [], text: "" };
    if (tok.selfClose) return { node, next: pos + 1 };
    pos++;
    while (pos < tokens.length) {
      const next = tokens[pos];
      if (next.type === "close") {
        if (next.tag === node.tag) return { node, next: pos + 1 };
        // Mismatched close — skip (lenient)
        pos++;
        continue;
      }
      if (next.type === "text") {
        node.text += next.value;
        pos++;
        continue;
      }
      // open
      const { node: child, next: childEnd } = parseTree(tokens, pos);
      if (child) node.children.push(child);
      pos = childEnd;
    }
    return { node, next: pos };
  }
  return { node: null, next: pos };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
