// Contract checks for the Library liked tab and automatic artist lookup.
// Run: npx tsx test/frontend/library_starred_artist_info.test.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

const root = join(__dirname, "..", "..");
const source = readFileSync(join(root, "web", "src", "views", "Library.vue"), "utf8");
const zh = JSON.parse(readFileSync(join(root, "web", "src", "locales", "zh-CN.json"), "utf8")) as any;
const en = JSON.parse(readFileSync(join(root, "web", "src", "locales", "en.json"), "utf8")) as any;

console.log("Library liked tab and artist lookup:");
assert(/type Tab = "artists" \| "albums" \| "songs"/.test(source), "liked shares the three library tabs");
assert(/authFetch\("getStarred2"\)/.test(source), "liked data uses getStarred2");
assert(/parseXmlAttrs\(xml, "artist"\)/.test(source), "liked artists are parsed");
assert(/parseXmlAttrs\(xml, "album"\)/.test(source), "liked albums are parsed");
assert(/parseXmlAttrs\(xml, "song"\)\.map\(mapSongRow\)/.test(source), "liked songs are parsed");
assert(/function playFromStarred\(i: number\)[\s\S]*?player\.setQueue\(displaySongs\.value, i\)/.test(source), "liked songs can be played as a queue");
assert(/sortMode = ref<SortMode>\("newest"\)/.test(source), "library and liked share a default sort mode");
assert(/<StarButton/.test(source) && /kind="artist"/.test(source) && /kind="album"/.test(source) && /kind="song"/.test(source), "all liked entity types expose a star button");
assert(/authFetch\("getArtistInfo"/.test(source), "artist details trigger automatic lookup");
assert(/artistInfoLoading/.test(source) && /artistInfoUnavailable/.test(source), "artist lookup has loading and failure states");

for (const [name, locale] of [["zh-CN", zh], ["en", en]] as const) {
  for (const key of ["tabStarred", "noStarred", "starredLoadFailed", "sortLabel", "sortNewest", "sortNameAsc", "sortNameDesc", "like", "unlike", "starUpdateFailed", "artistInfoTitle", "artistInfoLoading", "artistInfoUnavailable", "artistInfoOpen"]) {
    assert(typeof locale.library?.[key] === "string", `${name} library.${key} exists`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
