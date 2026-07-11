// ============================================================================
// ----------------------------------------------------------------------------
// Self-contained regex parser (no fast-xml-parser dep) — covers the fields
// Subsonic needs for getPodcasts / getPodcastEpisode:
//
// channel.title / description / image (RSS or itunes:image) / language
//  item.guid / title / description / pubDate / enclosure[url|length|type]
//      / itunes:duration
//
// Strategy:
//  1. Split the document into <channel>...</channel> and per-<item> blocks
//    with bounded greedy regex.
//  2. For each tag, allow:
//      <tag>plain text</tag>
//      <tag><![CDATA[ raw html ]]></tag>
//        <tag attr="x" />        (enclosure / itunes:image)
//        <ns:tag>value</ns:tag>  (itunes:* / atom:* prefixes)
//  3. Unknown / malformed input falls back to null fields — never throws
//    because partial feeds still produce useful channel rows.
// ============================================================================

export interface RssChannel {
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  language: string | null;
  items: RssItem[];
}

export interface RssItem {
  guid: string;                       // falls back to enclosure URL when guid absent
  title: string | null;
  description: string | null;
  audioUrl: string | null;            // enclosure url
  publishedAt: number | null;         // unix seconds (RFC 822 / ISO 8601)
  duration: number | null;            // seconds
  size: number | null;                // enclosure length (bytes)
  contentType: string | null;         // enclosure type
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseRss(xml: string): RssChannel {
  const channelBlock = extractBlock(xml, "channel") ?? "";

  // Channel-level <item> blocks are siblings, not nested inside a wrapping tag
  // (unlike Atom <feed><entry/>). Use a global scan.
  const itemBlocks = extractAllBlocks(channelBlock, "item");

  return {
    title: tagText(channelBlock, "title"),
    description: tagText(channelBlock, "description")
      ?? tagText(channelBlock, "itunes:summary"),
    imageUrl:
      // <image><url>...</url></image>
      tagText(extractBlock(channelBlock, "image") ?? "", "url")
      ?? attrOfSelfClosing(channelBlock, "itunes:image", "href"),
    language: tagText(channelBlock, "language"),
    items: itemBlocks.map(parseItem),
  };
}

// ---------------------------------------------------------------------------
// Item parsing
// ---------------------------------------------------------------------------

function parseItem(block: string): RssItem {
  const enclosureAttrs = attrsOfSelfClosing(block, "enclosure");
  const audioUrl = enclosureAttrs.url ?? null;
  const sizeRaw = enclosureAttrs.length ?? null;
  const contentType = enclosureAttrs.type ?? null;

  const guidRaw = tagText(block, "guid");
  const guid = guidRaw ?? audioUrl ?? "";

  return {
    guid,
    title: tagText(block, "title"),
    description: tagText(block, "description") ?? tagText(block, "itunes:summary"),
    audioUrl,
    publishedAt: parseDate(tagText(block, "pubDate") ?? tagText(block, "dc:date")),
    duration: parseDuration(tagText(block, "itunes:duration")),
    size: parseIntOrNull(sizeRaw),
    contentType,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Match <tag ...>...</tag> respecting case but allowing namespace prefixes.
// Greedy match is fine for podcast feeds (small, well-formed).
function extractBlock(xml: string, name: string): string | null {
  const re = new RegExp(`<${escapeRe(name)}\\b[^>]*>([\\s\\S]*?)</${escapeRe(name)}>`, "i");
  const m = re.exec(xml);
  return m ? m[1] : null;
}

function extractAllBlocks(xml: string, name: string): string[] {
  const re = new RegExp(`<${escapeRe(name)}\\b[^>]*>([\\s\\S]*?)</${escapeRe(name)}>`, "ig");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1]);
  }
  return out;
}

// Text content of the first <tag>...</tag> match. Strips CDATA + entities.
export function tagText(xml: string, name: string): string | null {
  const inner = extractBlock(xml, name);
  if (inner === null) return null;
  return cleanText(inner);
}

// Read an attribute from a self-closing tag like <enclosure url="..." />.
function attrOfSelfClosing(xml: string, name: string, attr: string): string | null {
  const attrs = attrsOfSelfClosing(xml, name);
  return attrs[attr] ?? null;
}

// All attributes of the first occurrence (handles both <tag .../> and <tag ...></tag>).
function attrsOfSelfClosing(xml: string, name: string): Record<string, string> {
  const re = new RegExp(`<${escapeRe(name)}\\b([^>]*?)/?>`, "i");
  const m = re.exec(xml);
  if (!m) return {};
  const attrRe = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
  const out: Record<string, string> = {};
  let a: RegExpExecArray | null;
  while ((a = attrRe.exec(m[1])) !== null) {
    out[a[1]] = a[2];
  }
  return out;
}

function cleanText(raw: string): string {
  // Strip outer CDATA, then decode the small set of XML entities that show
  // up in real feeds. Trim outer whitespace.
  let s = raw.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/i.exec(s);
  if (cdata) s = cdata[1];
  s = s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&");      // decode &amp; last to avoid double-decoding
  return s.trim();
}

// pubDate is most commonly RFC 822 ("Mon, 02 Jan 2006 15:04:05 GMT").
// Date.parse handles RFC 822 and ISO 8601 on V8.
function parseDate(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

// itunes:duration can be a bare number of seconds ("3600"), HH:MM:SS,
// or MM:SS. Everything else → null.
export function parseDuration(s: string | null): number | null {
  if (!s) return null;
  const trim = s.trim();
  if (/^\d+$/.test(trim)) return parseInt(trim, 10);
  const parts = trim.split(":").map((p) => parseInt(p, 10));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function parseIntOrNull(s: string | null): number | null {
  if (s === null || s === "") return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
