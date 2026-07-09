// 107 — Subsonic XML/JSON 行为对齐测试
//
// Verifies the f=json conversion pipeline (middleware/format.ts) against the
// OpenSubsonic spec + reference-server behaviour observed on
// imusic.wuyilingwei.com (music-tag-web):
//   * numeric/boolean attributes emit as JSON numbers/booleans, by NAME
//   * known list children are ALWAYS arrays, even with 1 element
//   * single objects at response root (getAlbum's album) stay objects
//   * openSubsonicExtensions/versions is an array of ints
//   * envelope carries type/serverVersion/openSubsonic (XML + JSON)
//   * mapSong emits album NAME (not id), albumId/artistId/type
//
// Run: npx tsx test/format_test.ts

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { xmlToJson } from "../worker/src/middleware/format";
import { subsonicOK, SERVER_TYPE, SERVER_VERSION } from "../worker/src/utils/xml";
import { mapSong } from "../worker/src/types/subsonic";
import { normalizeQuery } from "../worker/src/endpoints/subsonic/searching";
import { parseLrc } from "../worker/src/endpoints/subsonic/lyrics";
import type { SongMaster } from "../worker/src/types/entities";

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string) {
  if (cond) { passed++; }
  else { failed++; console.error(`  ✗ FAIL: ${label}`); }
}
function section(name: string) { console.log(`\n== ${name}`); }

type J = Record<string, any>;
const conv = (xml: string): J => xmlToJson(xml)["subsonic-response"] as J;

// ---------------------------------------------------------------------------
section("1. envelope: subsonicOK carries type/serverVersion/openSubsonic in XML and JSON");
const okXml = subsonicOK({});
assert(okXml.includes(`type="${SERVER_TYPE}"`), "XML has type");
assert(okXml.includes(`serverVersion="${SERVER_VERSION}"`), "XML has serverVersion");
assert(okXml.includes(`openSubsonic="true"`), "XML has openSubsonic");
const okJson = conv(okXml);
assert(okJson.status === "ok", "JSON status ok");
assert(okJson.version === "1.16.1", "JSON version");
assert(okJson.type === SERVER_TYPE, "JSON type");
assert(okJson.serverVersion === SERVER_VERSION, "JSON serverVersion");
assert(okJson.openSubsonic === true, "JSON openSubsonic is boolean true");
assert(!("xmlns" in okJson), "JSON drops xmlns");

// ---------------------------------------------------------------------------
section("2. attribute typing: numbers by name, booleans by name, ids stay strings");
const albXml = subsonicOK({
  albumList2: {
    album: [{ _attributes: {
      id: "474", name: "46", artist: "塞壬唱片-MSR", artistId: "ar-4",
      songCount: 1, duration: 235, playCount: 1, year: 2024,
      coverArt: "al-474",
    } }],
  },
});
const alb = conv(albXml).albumList2.album;
assert(Array.isArray(alb), "albumList2.album is array");
assert(alb.length === 1, "single element preserved in array");
assert(alb[0].duration === 235, "duration is number");
assert(alb[0].songCount === 1, "songCount is number");
assert(alb[0].year === 2024, "year is number");
assert(alb[0].playCount === 1, "playCount is number");
assert(alb[0].id === "474", "numeric-looking id stays string");
assert(alb[0].name === "46", "numeric-looking name stays string");
assert(alb[0].artistId === "ar-4", "artistId stays string");

const userXml = subsonicOK({
  user: { _attributes: {
    username: "admin", scrobblingEnabled: "true", adminRole: "true",
    jukeboxRole: "false", streamRole: "true", maxBitRate: 0, folder: 0,
  } },
});
const usr = conv(userXml).user;
assert(usr.adminRole === true, "adminRole is boolean true");
assert(usr.jukeboxRole === false, "jukeboxRole is boolean false");
assert(usr.maxBitRate === 0, "maxBitRate is number");
assert(usr.username === "admin", "username string");

// ---------------------------------------------------------------------------
section("3. array semantics: parent-aware (getAlbum root album is object, its song is array)");
const getAlbumXml = subsonicOK({
  album: {
    _attributes: { id: "al-1", name: "我爱你", artist: "胧音Long", songCount: 1, duration: 313 },
    song: [{ _attributes: { id: "sm-1", parent: "al-1", isDir: "false", title: "我爱你", album: "我爱你", albumId: "al-1", duration: 313, isVideo: "false" } }],
  },
});
const ga = conv(getAlbumXml);
assert(!Array.isArray(ga.album), "root album is single object");
assert(Array.isArray(ga.album.song), "album.song is array (1 element)");
assert(ga.album.song[0].isDir === false, "song.isDir boolean");
assert(ga.album.song[0].duration === 313, "song.duration number");
assert(ga.album.song[0].album === "我爱你", "song.album is the NAME");

const idxXml = subsonicOK({
  artists: { index: [{ _attributes: { name: "A" }, artist: [{ _attributes: { id: "ar-1", name: "Aimer" } }] }] },
});
const idx = conv(idxXml).artists;
assert(Array.isArray(idx.index), "artists.index array");
assert(Array.isArray(idx.index[0].artist), "index.artist array (1 element)");

// ---------------------------------------------------------------------------
section("4. openSubsonicExtensions: array + versions int array");
const extXml = subsonicOK({
  openSubsonicExtensions: [
    { _attributes: { name: "apiKeyAuthentication" }, versions: [1] },
    { _attributes: { name: "formPost" }, versions: [1, 2] },
  ],
});
const ext = conv(extXml).openSubsonicExtensions;
assert(Array.isArray(ext), "openSubsonicExtensions is array");
assert(ext[0].name === "apiKeyAuthentication", "ext name");
assert(Array.isArray(ext[0].versions), "versions is array even with 1 item");
assert(ext[0].versions[0] === 1, "versions items are numbers");
assert(JSON.stringify(ext[1].versions) === "[1,2]", "multi versions [1,2]");
assert(extXml.includes("<versions>1</versions>"), "XML versions are child elements");

// ---------------------------------------------------------------------------
section("5. error envelope: code typed, message string");
const errXml = `<?xml version="1.0" encoding="UTF-8"?>
<subsonic-response xmlns="http://subsonic.org/restapi" status="failed" version="1.16.1" type="edgeSonic" serverVersion="1.0.0" openSubsonic="true">
  <error code="40" message="Wrong username &amp; password"/>
</subsonic-response>`;
const err = conv(errXml);
assert(err.status === "failed", "error status failed");
assert(err.error.code === 40, "error.code is number");
assert(err.error.message === "Wrong username & password", "entities decoded");
assert(err.openSubsonic === true, "error envelope openSubsonic boolean");

// ---------------------------------------------------------------------------
section("6. empty containers and text leaves");
const emptyXml = subsonicOK({ playlists: {} });
assert(JSON.stringify(conv(emptyXml).playlists) === "{}", "empty container is {}");
const lyricsXml = subsonicOK({ lyrics: { _attributes: { artist: "A", title: "T" }, _text: "la la" } });
const lyr = conv(lyricsXml).lyrics;
assert(lyr.value === "la la", "text content becomes value");
assert(lyr.artist === "A", "lyrics attrs kept");

// ---------------------------------------------------------------------------
section("7. mapSong: album NAME not id, albumId/artistId/type/created present");
const songRow: SongMaster & { artist_name?: string | null; album_name?: string | null } = {
  id: "sm-1", album_id: "al-9", artist_id: "ar-7", album_artist_id: null,
  title: "Song", sort_title: null, track: 3, disc: 1, duration: 200,
  genre: "Rock", compilation: 0, participants: null, lyrics: null,
  created_at: 1750000000, updated_at: 1750000000,
  artist_name: "The Band", album_name: "The Album",
};
const child = mapSong(songRow, "al-9");
assert(child.album === "The Album", "mapSong album is name");
assert(child.artist === "The Band", "mapSong artist is name");
assert(child.albumId === "al-9", "mapSong albumId");
assert(child.artistId === "ar-7", "mapSong artistId");
assert(child.discNumber === 1, "mapSong discNumber");
assert(child.type === "music", "mapSong type music");
assert(typeof child.created === "string" && child.created.startsWith("2025"), "mapSong created ISO");
const bare = mapSong({ ...songRow, artist_name: undefined, album_name: undefined }, "al-9");
assert(bare.album === undefined, "no name join → album omitted (never the raw id)");

// ---------------------------------------------------------------------------
section("8. source checks: auth error envelope + middleware mount order");
const here = dirname(fileURLToPath(import.meta.url));
const authSrc = readFileSync(join(here, "../worker/src/auth.ts"), "utf-8");
assert(authSrc.includes('serverVersion="${SERVER_VERSION}"'), "auth subsonicError carries serverVersion");
assert(authSrc.includes('openSubsonic="true"'), "auth subsonicError carries openSubsonic");
const indexSrc = readFileSync(join(here, "../worker/src/index.ts"), "utf-8");
const fmtPos = indexSrc.indexOf('app.use("/rest/*", formatMiddleware)');
const authPos = indexSrc.indexOf('app.use("/rest/*", authMiddleware)');
assert(fmtPos !== -1 && authPos !== -1 && fmtPos < authPos, "formatMiddleware mounted before authMiddleware");

// ---------------------------------------------------------------------------
section("9. 108 — search empty-array defaults + query normalization");
assert(normalizeQuery('""') === "", `literal "" → empty`);
assert(normalizeQuery("''") === "", "literal '' → empty");
assert(normalizeQuery("*") === "", "* → empty");
assert(normalizeQuery('"beatles"') === "beatles", "wrapping quotes stripped");
assert(normalizeQuery("beatles") === "beatles", "plain query untouched");
const srXml = subsonicOK({
  searchResult3: { song: [{ _attributes: { id: "sm-1", isDir: "false", title: "T" } }] },
});
const sr = conv(srXml).searchResult3;
assert(Array.isArray(sr.song) && sr.song.length === 1, "searchResult3.song array");
assert(Array.isArray(sr.artist) && sr.artist.length === 0, "missing artist defaults to []");
assert(Array.isArray(sr.album) && sr.album.length === 0, "missing album defaults to []");
const srEmptyXml = subsonicOK({ searchResult3: {} });
const srE = conv(srEmptyXml).searchResult3;
assert(Array.isArray(srE.artist) && Array.isArray(srE.album) && Array.isArray(srE.song),
  "fully-empty searchResult3 still has three [] keys");

// ---------------------------------------------------------------------------
section("10. 108 — songLyrics: structured lines, synced/start typing");
const lrc = "[ti:九光年宇宙]\n[ar:星尘]\n[by:someone]\n[00:00.00]第一句\n[00:08.12]✡\n[01:02.5]第三句";
const pl = parseLrc(lrc);
assert(pl.synced === true, "LRC detected as synced");
assert(pl.lines.length === 3, "metadata tags dropped, 3 lyric lines kept");
assert(pl.lines[0].start === 0 && pl.lines[0].value === "第一句", "line 1 start/value");
assert(pl.lines[1].start === 8120, "mm:ss.xx → ms (8120)");
assert(pl.lines[2].start === 62500, "[01:02.5] → 62500ms (padded fraction)");
const plain = parseLrc("just a line\nanother line");
assert(plain.synced === false && plain.lines.length === 2 && plain.lines[0].start === undefined,
  "plain text stays unsynced without start");
const lyrXml = subsonicOK({
  lyricsList: {
    structuredLyrics: {
      _attributes: { displayArtist: "A", displayTitle: "T", lang: "xxx", synced: "true" },
      line: [
        { _attributes: { start: 0 }, _text: "第一句" },
        { _attributes: { start: 8120 }, _text: "✡" },
      ],
    },
  },
});
const ll = conv(lyrXml).lyricsList;
assert(Array.isArray(ll.structuredLyrics), "structuredLyrics is array");
assert(ll.structuredLyrics[0].synced === true, "synced is boolean");
assert(Array.isArray(ll.structuredLyrics[0].line), "line is array");
assert(ll.structuredLyrics[0].line[0].start === 0 && ll.structuredLyrics[0].line[0].value === "第一句",
  "line objects carry {start:number, value}");
const unsyncedXml = subsonicOK({
  lyricsList: {
    structuredLyrics: {
      _attributes: { displayArtist: "A", displayTitle: "T", lang: "xxx", synced: "false" },
      line: [{ _attributes: {}, _text: "plain line" }],
    },
  },
});
const ul = conv(unsyncedXml).lyricsList.structuredLyrics[0].line;
assert(typeof ul[0] === "object" && ul[0].value === "plain line",
  "unsynced line is still a {value} object, not a bare string");

// ---------------------------------------------------------------------------
section("11. 108 — mapSong physical fields + webdav presign default off");
const physRow = { ...songRow, inst_suffix: "flac", inst_content_type: "audio/flac",
  inst_bit_rate: 971, inst_size: 32406488, inst_duration: 207,
  inst_storage_uri: "webdav://src-1/music/像素荒原/6 谜.flac" };
const physChild = mapSong(physRow, "al-9");
assert(physChild.suffix === "flac", "mapSong suffix");
assert(physChild.contentType === "audio/flac", "mapSong contentType");
assert(physChild.bitRate === 971, "mapSong bitRate");
assert(physChild.size === 32406488, "mapSong size");
assert(physChild.path === "music/像素荒原/6 谜.flac", "path strips scheme + source id");
assert(mapSong({ ...physRow, duration: null }, "al-9").duration === 207,
  "master duration null → instance duration fallback");
const mediaSrc = readFileSync(join(here, "../worker/src/endpoints/subsonic/media.ts"), "utf-8");
assert(mediaSrc.includes('getFeatureString(env, "enable_webdav_presign", "0")'),
  "webdav presign code default is 0");
const migration35 = readFileSync(join(here, "../worker/migrations/0035_webdav_presign_default_off.sql"), "utf-8");
assert(migration35.includes("SET value = '0'"), "migration 0035 flips existing rows to 0");

// ---------------------------------------------------------------------------
console.log(`\n${passed + failed} checks, ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error("FAILED"); process.exit(1); }
console.log("ALL PASS");
