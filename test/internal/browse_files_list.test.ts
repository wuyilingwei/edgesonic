// 147 — GET /storage/files/list, r2 branch: verifies an empty folder created by
// files/mkdir (a "<path>/.keep" marker object) shows up as a directory in its
// parent listing, and that ".keep" itself never leaks out as a visible file
// when browsing into that folder.
//
// Run: npx tsx test/internal/browse_files_list.test.ts

import { Hono } from "hono";
import { browseRoutes } from "../../worker/src/endpoints/storage/browse";

declare global { type D1Database = unknown; type Env = unknown; }

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

// ---------------------------------------------------------------------------
// In-memory R2 bucket shim with delimiter-aware list() (mirrors R2's actual
// commonPrefix-grouping semantics closely enough for this test).
// ---------------------------------------------------------------------------
interface R2Item { key: string; size: number; contentType: string }

function makeR2Bucket() {
  const store = new Map<string, R2Item>();
  return {
    async put(key: string, _body: unknown, opts?: { httpMetadata?: { contentType?: string } }) {
      store.set(key, { key, size: 0, contentType: opts?.httpMetadata?.contentType || "application/octet-stream" });
    },
    async list({ prefix, delimiter }: { prefix: string; delimiter: string }) {
      const objects: (R2Item & { httpMetadata: { contentType: string } })[] = [];
      const prefixSet = new Set<string>();
      for (const item of store.values()) {
        if (!item.key.startsWith(prefix)) continue;
        const rest = item.key.substring(prefix.length);
        const idx = rest.indexOf(delimiter);
        if (idx >= 0) {
          prefixSet.add(prefix + rest.substring(0, idx + delimiter.length));
        } else {
          objects.push({ ...item, httpMetadata: { contentType: item.contentType } });
        }
      }
      return { objects, delimitedPrefixes: Array.from(prefixSet) };
    },
  };
}

function makeApp(bucket: ReturnType<typeof makeR2Bucket>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use("*", async (c, next) => {
    c.set("user", { username: "root", level: 3, enabled: 1, password: "x" });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/storage", browseRoutes);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env: Record<string, any> = {
    DB: { prepare() { return { bind() { return this; }, async first() { return { enabled: 1, max_rph: 0 }; } }; } },
    MUSIC_BUCKET: bucket,
  };

  return {
    async get(url: string) { return app.fetch(new Request(`http://test${url}`), env); },
  };
}

async function main() {
  const bucket = makeR2Bucket();
  await bucket.put("music/newfolder/.keep", null, { httpMetadata: { contentType: "application/x-directory" } });
  await bucket.put("music/newfolder/track.mp3", null, { httpMetadata: { contentType: "audio/mpeg" } });
  const app = makeApp(bucket);

  console.log("\nfiles/list r2 parent → shows the marker-only folder as a dir:");
  {
    const r = await app.get("/storage/files/list?source=r2&path=music");
    const j = await r.json<{ ok: boolean; dirs: { name: string }[]; files: { name: string }[] }>();
    assert(j.ok, "ok=true");
    assert(j.dirs.some((d) => d.name === "newfolder"), `dirs includes 'newfolder' (got ${JSON.stringify(j.dirs)})`);
    assert(!j.files.some((f) => f.name === ".keep"), "no '.keep' leaked into the parent's file list");
  }

  console.log("\nfiles/list r2 inside folder → .keep hidden, real file kept:");
  {
    const r = await app.get("/storage/files/list?source=r2&path=music/newfolder");
    const j = await r.json<{ ok: boolean; files: { name: string }[] }>();
    assert(j.ok, "ok=true");
    assert(!j.files.some((f) => f.name === ".keep"), "'.keep' not present in its own folder's listing");
    assert(j.files.some((f) => f.name === "track.mp3"), "real file 'track.mp3' still listed");
  }

  console.log(`\n${failures === 0 ? "All tests passed." : `${failures} test(s) FAILED.`}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
