import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workerBase = "https://edgesonic.wuyilingwei.com";
const concurrency = Number(process.env.R2_RESCUE_CONCURRENCY || "4");
const mapTable = process.env.R2_RESCUE_MAP_TABLE || "ops_r2_album_only_rescue_map_20260713";
const label = process.env.R2_RESCUE_LABEL || "album-only";
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workerDir = join(repoRoot, "worker");

function stripAnsi(s) {
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function wrangler(args) {
  if (process.platform === "win32") {
    const command = `& npx wrangler ${args.map(psQuote).join(" ")}`;
    return execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      cwd: workerDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  return execFileSync("npx", ["wrangler", ...args], {
    cwd: workerDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function d1Json(sql) {
  const raw = stripAnsi(wrangler(["d1", "execute", "edgesonic-db", "--remote", "--json", "--command", sql]));
  const start = raw.indexOf("[");
  if (start < 0) throw new Error(`Wrangler did not return JSON: ${raw.slice(0, 300)}`);
  return JSON.parse(raw.slice(start));
}

function d1Exec(sql) {
  wrangler(["d1", "execute", "edgesonic-db", "--remote", "--command", sql]);
}

async function mapConcurrent(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await fn(items[index], index);
    }
  });
  await Promise.all(workers);
}

const token = `ops-r2-rescue-${randomBytes(24).toString("hex")}`;
const sessionId = `ops-r2-rescue-${randomBytes(8).toString("hex")}`;
const now = Math.floor(Date.now() / 1000);

try {
  d1Exec(`INSERT INTO sessions (id, username, token, user_agent, expires_at, created_at) VALUES ('${sessionId}', 'admin', '${token}', 'ops-r2-rescue-${label}', ${now + 3600}, ${now})`);

  const rows = d1Json(`SELECT source_key, target_key FROM ${mapTable} WHERE action = 'move' AND moved = 0 ORDER BY source_key`)[0]?.results || [];
  console.log(`R2 ${label} rescue: ${rows.length} object(s) to move with concurrency=${concurrency}`);

  let ok = 0;
  const failures = [];
  await mapConcurrent(rows, concurrency, async (row, index) => {
    const resp = await fetch(`${workerBase}/storage/files/move`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `edgesonic_session=${token}`,
      },
      body: JSON.stringify({ key: row.source_key, dest: row.target_key }),
    });
    const text = await resp.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = { ok: false, error: text }; }
    if (resp.ok && body.ok) {
      ok++;
      if (ok % 100 === 0 || ok === rows.length) console.log(`moved ${ok}/${rows.length}`);
      return;
    }
    failures.push({ source_key: row.source_key, target_key: row.target_key, status: resp.status, error: body?.error || text });
    console.error(`failed ${index + 1}/${rows.length}: ${row.source_key} -> ${row.target_key}: HTTP ${resp.status} ${body?.error || text}`);
  });

  d1Exec(`UPDATE ${mapTable} SET moved = 1, moved_at = unixepoch(), error = NULL WHERE action = 'move' AND EXISTS (SELECT 1 FROM song_instances si WHERE si.storage_uri = 'r2://' || ${mapTable}.target_key) AND NOT EXISTS (SELECT 1 FROM song_instances si WHERE si.storage_uri = 'r2://' || ${mapTable}.source_key)`);

  if (failures.length) {
    console.error(`R2 ${label} rescue completed with ${failures.length} failure(s).`);
    process.exitCode = 1;
  } else {
    console.log(`R2 ${label} rescue completed: moved ${ok}/${rows.length}.`);
  }
} finally {
  try {
    d1Exec(`DELETE FROM sessions WHERE id = '${sessionId}'`);
  } catch (e) {
    console.error(`failed to remove temporary session: ${e instanceof Error ? e.message : String(e)}`);
  }
}
