// Guest token reaper: expired rows are deleted, live rows are preserved.
import { DatabaseSync } from "node:sqlite";
import { reapExpiredGuestTokens } from "../../worker/src/utils/guestTokenReaper";

function makeD1(sqlite: DatabaseSync) {
  function prepare(query: string) {
    const stmt = sqlite.prepare(query);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let boundArgs: any[] = [];
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bind(...args: any[]) { boundArgs = args; return this; },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async first<T = any>(): Promise<T | null> { return (stmt.get(...boundArgs) ?? null) as T | null; },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async all<T = any>(): Promise<{ results: T[]; success: true; meta: any }> { return { results: stmt.all(...boundArgs) as T[], success: true, meta: {} }; },
      async run() { const info = stmt.run(...boundArgs); return { success: true, meta: { changes: Number(info.changes ?? 0) } }; },
    };
  }
  return { prepare };
}

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

async function main() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE guest_tokens (token TEXT PRIMARY KEY, created_by TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER DEFAULT 0);
  `);
  const now = Math.floor(Date.now() / 1000);
  // Three expired, two live.
  sqlite.prepare("INSERT INTO guest_tokens (token, created_by, expires_at) VALUES ('a','admin',?),('b','admin',?),('c','admin',?),('d','admin',?),('e','admin',?)")
    .run(now - 100, now - 1, now - 86400, now + 3600, now + 86400);
  const env = { DB: makeD1(sqlite) } as unknown as Env;
  await reapExpiredGuestTokens(env);

  const remaining = sqlite.prepare("SELECT token FROM guest_tokens ORDER BY token").all() as { token: string }[];
  assert(remaining.length === 2, `2 live tokens remain (got ${remaining.length})`);
  assert(remaining.map((r) => r.token).join(",") === "d,e", "live tokens d,e preserved");

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  if (failures > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });