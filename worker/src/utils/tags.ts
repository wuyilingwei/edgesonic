// Minimal embedded-tag readers for the scan pipeline.
// Supported: ID3v2 (mp3, and the "id3 " chunk inside WAV), FLAC VORBIS_COMMENT.
// Only needs a slice of the file (head, plus tail for WAV) — callers fetch via Range.

export interface SongTags {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  genre?: string;
  track?: number;
  disc?: number;
  year?: number;
  // LYRICS|UNSYNCEDLYRICS|SYNCEDLYRICS key. Callers (endpoints/tag/read.ts)
  // persist this to song_masters.lyrics, guarded so it never overwrites an
  // existing value (a NetEase fetch or user edit outranks an embedded tag).
  lyrics?: string;
}

export function parseTags(head: Uint8Array, tail?: Uint8Array): SongTags | null {
  if (head.length >= 4) {
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
      const t = parseID3v2(head);
      if (t) return t;
    }
    if (head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43) {
      const t = parseFLAC(head);
      if (t) return t;
    }
    if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46) {
      const t = parseWAV(head) || (tail ? parseWAV(tail, true) : null);
      if (t) return t;
    }
  }
  return null;
}

// --- ID3v2 ---

function parseID3v2(buf: Uint8Array): SongTags | null {
  if (buf.length < 10) return null;
  const major = buf[3];
  const flags = buf[5];
  let size = syncsafe(buf, 6);
  let pos = 10;
  if (flags & 0x40) {
    // extended header
    const extSize = major === 4 ? syncsafe(buf, pos) : be32(buf, pos);
    pos += extSize + (major === 4 ? 0 : 4);
  }
  const end = Math.min(10 + size, buf.length);
  const tags: SongTags = {};
  let found = false;

  while (pos + 10 <= end) {
    const id = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const frameSize = major === 4 ? syncsafe(buf, pos + 4) : be32(buf, pos + 4);
    if (frameSize <= 0 || pos + 10 + frameSize > buf.length) break;
    const body = buf.subarray(pos + 10, pos + 10 + frameSize);
    const text = () => decodeID3Text(body);
    switch (id) {
      case "TIT2": tags.title = text(); found = true; break;
      case "TPE1": tags.artist = text(); found = true; break;
      case "TPE2": tags.albumArtist = text(); found = true; break;
      case "TALB": tags.album = text(); found = true; break;
      case "TCON": tags.genre = text().replace(/^\(\d+\)/, ""); found = true; break;
      case "TRCK": { const n = parseInt(text(), 10); if (n) tags.track = n; found = true; break; }
      case "TPOS": { const n = parseInt(text(), 10); if (n) tags.disc = n; found = true; break; }
      case "TYER": case "TDRC": { const y = parseInt(text().substring(0, 4), 10); if (y) tags.year = y; found = true; break; }
      // language(3, ignored) + short content descriptor (null-terminated per
      // the same encoding) + the actual lyrics text. First USLT frame wins.
      case "USLT": { if (!tags.lyrics) { const t = decodeUslt(body); if (t) tags.lyrics = t; } found = true; break; }
    }
    pos += 10 + frameSize;
  }
  return found ? clean(tags) : null;
}

function decodeUslt(body: Uint8Array): string {
  if (body.length < 5) return "";
  const enc = body[0];
  // language occupies bytes 1-3; the descriptor + lyrics start at byte 4.
  const rest = body.subarray(4);
  const wide = enc === 1 || enc === 2; // UTF-16 variants use a 2-byte NUL terminator
  let i = 0;
  if (wide) {
    while (i + 1 < rest.length && !(rest[i] === 0 && rest[i + 1] === 0)) i += 2;
    i += 2;
  } else {
    while (i < rest.length && rest[i] !== 0) i++;
    i += 1;
  }
  if (i >= rest.length) return "";
  return decodeID3Text(concatEncByte(enc, rest.subarray(i)));
}

// decodeID3Text expects [encByte, ...data] — USLT's lyrics segment has no
// leading encoding byte of its own (it's declared once at the frame start),
// so re-prepend it to reuse the same decoder + smartDecode fallback.
function concatEncByte(enc: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 1);
  out[0] = enc;
  out.set(data, 1);
  return out;
}

function decodeID3Text(body: Uint8Array): string {
  if (body.length < 2) return "";
  const enc = body[0];
  const data = body.subarray(1);
  try {
    // enc=0 is nominally Latin1, but Chinese rips routinely stuff GBK bytes in it
    if (enc === 0) return smartDecode(data).replace(/\0+$/, "").trim();
    if (enc === 1) return new TextDecoder("utf-16").decode(data).replace(/\0+$/, "").trim();
    if (enc === 2) return new TextDecoder("utf-16be").decode(data).replace(/\0+$/, "").trim();
    return new TextDecoder("utf-8").decode(data).replace(/\0+$/, "").trim();
  } catch { return ""; }
}

// Encoding sniff for fields with unreliable declared encodings:
// strict UTF-8 → strict GB18030 (superset of GBK) → Latin1 as a lossless fallback.
function smartDecode(data: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data); } catch { /* not utf-8 */ }
  try { return new TextDecoder("gb18030", { fatal: true, ignoreBOM: false }).decode(data); } catch { /* not gbk or unsupported */ }
  return new TextDecoder("latin1").decode(data);
}

function syncsafe(buf: Uint8Array, off: number): number {
  return ((buf[off] & 0x7f) << 21) | ((buf[off + 1] & 0x7f) << 14) | ((buf[off + 2] & 0x7f) << 7) | (buf[off + 3] & 0x7f);
}
function be32(buf: Uint8Array, off: number): number {
  return (buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
}

// --- FLAC ---

function parseFLAC(buf: Uint8Array): SongTags | null {
  let pos = 4;
  while (pos + 4 <= buf.length) {
    const header = buf[pos];
    const isLast = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const size = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
    pos += 4;
    if (type === 4) {
      // VORBIS_COMMENT (little-endian lengths)
      if (pos + size > buf.length) return null; // comment block beyond fetched head
      return parseVorbisComment(buf.subarray(pos, pos + size));
    }
    pos += size;
    if (isLast) break;
  }
  return null;
}

function parseVorbisComment(buf: Uint8Array): SongTags | null {
  const dec = new TextDecoder("utf-8");
  let pos = 0;
  const le32 = () => { const v = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24); pos += 4; return v >>> 0; };
  const vendorLen = le32();
  pos += vendorLen;
  const count = le32();
  const tags: SongTags = {};
  let found = false;
  for (let i = 0; i < count && pos + 4 <= buf.length; i++) {
    const len = le32();
    if (pos + len > buf.length) break;
    const kv = dec.decode(buf.subarray(pos, pos + len));
    pos += len;
    const eq = kv.indexOf("=");
    if (eq < 0) continue;
    const key = kv.substring(0, eq).toUpperCase();
    const val = kv.substring(eq + 1).trim();
    if (!val) continue;
    switch (key) {
      case "TITLE": tags.title = val; found = true; break;
      case "ARTIST": tags.artist = val; found = true; break;
      case "ALBUM": tags.album = val; found = true; break;
      case "ALBUMARTIST": tags.albumArtist = val; found = true; break;
      case "GENRE": tags.genre = val; found = true; break;
      case "TRACKNUMBER": { const n = parseInt(val, 10); if (n) tags.track = n; found = true; break; }
      case "DISCNUMBER": { const n = parseInt(val, 10); if (n) tags.disc = n; found = true; break; }
      case "DATE": case "YEAR": { const y = parseInt(val.substring(0, 4), 10); if (y) tags.year = y; found = true; break; }
      // holds genuine LRC (with [mm:ss.xx] tags) when present, which is
      // strictly better — prefer it, then LYRICS, then UNSYNCEDLYRICS.
      case "SYNCEDLYRICS": tags.lyrics = val; found = true; break;
      case "LYRICS": if (!tags.lyrics) tags.lyrics = val; found = true; break;
      case "UNSYNCEDLYRICS": if (!tags.lyrics) tags.lyrics = val; found = true; break;
    }
  }
  return found ? clean(tags) : null;
}

// --- WAV (RIFF) ---
// Tags live in a LIST/INFO chunk or an "id3 " chunk, before or after the data chunk.
// `fromTail` parses a buffer that does not start at file offset 0 — scan for markers.

function parseWAV(buf: Uint8Array, fromTail = false): SongTags | null {
  if (!fromTail) {
    // walk chunks from the RIFF header; stop at the (huge) data chunk
    let pos = 12;
    while (pos + 8 <= buf.length) {
      const id = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
      const size = buf[pos + 4] | (buf[pos + 5] << 8) | (buf[pos + 6] << 16) | (buf[pos + 7] << 24);
      if (id === "id3 " || id === "ID3 ") {
        const t = parseID3v2(buf.subarray(pos + 8, Math.min(pos + 8 + size, buf.length)));
        if (t) return t;
      }
      if (id === "LIST" && pos + 12 <= buf.length) {
        const listType = String.fromCharCode(buf[pos + 8], buf[pos + 9], buf[pos + 10], buf[pos + 11]);
        if (listType === "INFO") {
          const t = parseRiffInfo(buf.subarray(pos + 12, Math.min(pos + 8 + size, buf.length)));
          if (t) return t;
        }
      }
      if (id === "data") break; // audio payload — tags after it are in the tail fetch
      pos += 8 + size + (size % 2);
    }
    return null;
  }
  // tail: search for 'id3 ' chunk header or embedded ID3/LIST INFO markers.
  // RIFF chunk header 'id3 ' (4 bytes) + size (4 bytes) to find the start
  // of the ID3v2 data, not just the raw ID3 signature which may be at an
  // offset inside the chunk.
  for (let i = 0; i + 12 < buf.length; i++) {
    // RIFF 'id3 ' chunk: 4-byte id + 4-byte size + ID3v2 data
    if (buf[i] === 0x69 && buf[i + 1] === 0x64 && buf[i + 2] === 0x33 && buf[i + 3] === 0x20) {
      const chunkSize = buf[i + 4] | (buf[i + 5] << 8) | (buf[i + 6] << 16) | (buf[i + 7] << 24);
      const id3Start = i + 8;
      const id3End = Math.min(id3Start + chunkSize, buf.length);
      if (id3Start + 10 <= buf.length && buf[id3Start] === 0x49 && buf[id3Start + 1] === 0x44 && buf[id3Start + 2] === 0x33) {
        const t = parseID3v2(buf.subarray(id3Start, id3End));
        if (t) return t;
      }
    }
    // Raw ID3v2 signature (without RIFF wrapper)
    if (buf[i] === 0x49 && buf[i + 1] === 0x44 && buf[i + 2] === 0x33 && buf[i + 3] <= 4 && buf[i + 4] === 0) {
      const t = parseID3v2(buf.subarray(i));
      if (t) return t;
    }
    // LIST INFO
    if (buf[i] === 0x4c && buf[i + 1] === 0x49 && buf[i + 2] === 0x53 && buf[i + 3] === 0x54 &&
        buf[i + 8] === 0x49 && buf[i + 9] === 0x4e && buf[i + 10] === 0x46 && buf[i + 11] === 0x4f) {
      const size = buf[i + 4] | (buf[i + 5] << 8) | (buf[i + 6] << 16) | (buf[i + 7] << 24);
      const t = parseRiffInfo(buf.subarray(i + 12, Math.min(i + 8 + size, buf.length)));
      if (t) return t;
    }
  }
  return null;
}

function parseRiffInfo(buf: Uint8Array): SongTags | null {
  const tags: SongTags = {};
  let found = false;
  let pos = 0;
  while (pos + 8 <= buf.length) {
    const id = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
    const size = buf[pos + 4] | (buf[pos + 5] << 8) | (buf[pos + 6] << 16) | (buf[pos + 7] << 24);
    if (size < 0 || pos + 8 + size > buf.length) break;
    // RIFF INFO has no declared encoding — sniff (GBK is the norm for Chinese WAVs)
    const val = smartDecode(buf.subarray(pos + 8, pos + 8 + size)).replace(/\0+$/, "").trim();
    if (val) {
      switch (id) {
        case "INAM": tags.title = val; found = true; break;
        case "IART": tags.artist = val; found = true; break;
        case "IPRD": tags.album = val; found = true; break;
        case "IGNR": tags.genre = val; found = true; break;
        case "ITRK": case "IPRT": { const n = parseInt(val, 10); if (n) tags.track = n; found = true; break; }
        case "ICRD": { const y = parseInt(val.substring(0, 4), 10); if (y) tags.year = y; found = true; break; }
      }
    }
    pos += 8 + size + (size % 2);
  }
  return found ? clean(tags) : null;
}

function clean(t: SongTags): SongTags {
  for (const k of Object.keys(t) as Array<keyof SongTags>) {
    if (typeof t[k] === "string" && !(t[k] as string).trim()) delete t[k];
  }
  return t;
}

// --- Embedded cover art ---
// Returns the absolute file offset/length of the picture data, so callers can
// slice it from the fetched head or issue an exact Range request.

export interface PictureLocation {
  offset: number;
  length: number;
  mime: string;
  // pre-111 caller (offsets were always head-relative); "tail" only when the
  // picture was found via the WAV tail-scan fallback, so callers know they
  // must index into the TAIL slice they fetched, not the head.
  source?: "head" | "tail";
}

// "RIFF", which matched neither of the two branches below, so any embedded
// APIC art in a WAV's "id3 "/"ID3 " sub-chunk was silently never located.
// `tail` mirrors parseTags' dual head/tail design (many WAV rippers append
// the id3 chunk AFTER the audio "data" payload); when the picture is found
// in `tail`, the returned offset is relative to the START OF `tail` (not the
// whole file) — callers that fetched `tail` as its own slice can index into
// it directly, exactly like the head case.
export function locateEmbeddedPicture(head: Uint8Array, tail?: Uint8Array): PictureLocation | null {
  if (head.length >= 4) {
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return locateID3Picture(head, 0);
    if (head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43) return locateFLACPicture(head);
    if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46) {
      const pic = locateWAVPictureHead(head);
      if (pic) return pic;
    }
  }
  const tailPic = tail ? locateWAVPictureTail(tail) : null;
  return tailPic ? { ...tailPic, source: "tail" } : null;
}

// WAV "id3 "/"ID3 " chunk positioned BEFORE the "data" payload — walk chunks
// from the RIFF header exactly like parseWAV's primary branch.
function locateWAVPictureHead(buf: Uint8Array): PictureLocation | null {
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
    const size = buf[pos + 4] | (buf[pos + 5] << 8) | (buf[pos + 6] << 16) | (buf[pos + 7] << 24);
    if (id === "id3 " || id === "ID3 ") {
      const chunkStart = pos + 8;
      const pic = locateID3Picture(buf.subarray(chunkStart, Math.min(chunkStart + size, buf.length)), chunkStart);
      if (pic) return pic;
    }
    if (id === "data") break; // audio payload — a trailing id3 chunk needs the tail slice
    pos += 8 + size + (size % 2);
  }
  return null;
}

// WAV "id3 "/"ID3 " chunk positioned AFTER "data" — same byte-scan technique
// parseWAV(buf, fromTail=true) already uses for text tags.
function locateWAVPictureTail(buf: Uint8Array): PictureLocation | null {
  for (let i = 0; i + 10 < buf.length; i++) {
    if (buf[i] === 0x49 && buf[i + 1] === 0x44 && buf[i + 2] === 0x33 && buf[i + 3] <= 4 && buf[i + 4] === 0) {
      const pic = locateID3Picture(buf.subarray(i), i);
      if (pic) return pic;
    }
  }
  return null;
}

function locateID3Picture(buf: Uint8Array, base: number): PictureLocation | null {
  if (buf.length < 10) return null;
  const major = buf[3];
  const flags = buf[5];
  const size = syncsafe(buf, 6);
  let pos = 10;
  if (flags & 0x40) {
    const extSize = major === 4 ? syncsafe(buf, pos) : be32(buf, pos);
    pos += extSize + (major === 4 ? 0 : 4);
  }
  const end = Math.min(10 + size, buf.length);

  while (pos + 10 <= end) {
    const id = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const frameSize = major === 4 ? syncsafe(buf, pos + 4) : be32(buf, pos + 4);
    if (frameSize <= 0) break;
    if (id === "APIC") {
      const bodyStart = pos + 10;
      const avail = buf.subarray(bodyStart, Math.min(bodyStart + frameSize, buf.length));
      if (avail.length < 4) return null;
      const enc = avail[0];
      let p = 1;
      while (p < avail.length && avail[p] !== 0) p++; // mime (latin1, NUL-terminated)
      const mime = new TextDecoder("latin1").decode(avail.subarray(1, p)) || "image/jpeg";
      p += 1; // NUL
      p += 1; // picture type
      if (enc === 1 || enc === 2) {
        // UTF-16 description: terminated by 0x00 0x00
        while (p + 1 < avail.length && !(avail[p] === 0 && avail[p + 1] === 0)) p += 2;
        p += 2;
      } else {
        while (p < avail.length && avail[p] !== 0) p++;
        p += 1;
      }
      const dataLen = frameSize - p;
      if (dataLen <= 0) return null;
      return { offset: base + bodyStart + p, length: dataLen, mime };
    }
    pos += 10 + frameSize;
  }
  return null;
}

function locateFLACPicture(buf: Uint8Array): PictureLocation | null {
  let pos = 4;
  while (pos + 4 <= buf.length) {
    const header = buf[pos];
    const isLast = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const size = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
    pos += 4;
    if (type === 6) {
      // PICTURE block (all big-endian); fields may extend past the fetched head
      // we only need the lengths, which sit near the block start
      let p = pos;
      if (p + 8 > buf.length) return null;
      p += 4; // picture type
      const mimeLen = be32(buf, p); p += 4;
      if (p + mimeLen + 4 > buf.length) return null;
      const mime = new TextDecoder("latin1").decode(buf.subarray(p, p + mimeLen)) || "image/jpeg";
      p += mimeLen;
      const descLen = be32(buf, p); p += 4 + descLen;
      if (p + 20 > buf.length) return null;
      p += 16; // width/height/depth/colors
      const dataLen = be32(buf, p); p += 4;
      if (dataLen <= 0) return null;
      return { offset: p, length: dataLen, mime };
    }
    pos += size;
    if (isLast) break;
  }
  return null;
}
