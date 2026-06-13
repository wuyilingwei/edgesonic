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

// 049 — Sandbox container entrypoint.
//
// Minimal http server that the Worker reaches through Sandbox SDK
// exposePort(). One request → one ffmpeg child → streamed response.
//
// Routes:
//   GET  /health                 → "ok"
//   POST /transcode?args=<json>  → audio in (body), audio out (chunked)
//                                  args = ["-i","pipe:0", ... , "pipe:1"]
//
// Why args-as-query: the worker side already knows the full ffmpeg argv
// (built by buildFfmpegArgs), so we keep the container dumb. This avoids
// the container ever needing the profile catalogue.

import http from "node:http";
import { spawn } from "node:child_process";

const PORT = parseInt(process.env.PORT || "8080", 10);

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  if (req.method !== "POST" || !req.url || !req.url.startsWith("/transcode")) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }

  // Parse args from the query string.
  let argv;
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const raw = url.searchParams.get("args");
    if (!raw) throw new Error("missing args");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) {
      throw new Error("args must be string[]");
    }
    argv = parsed;
  } catch (e) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end(`bad args: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  // Spawn ffmpeg. stderr is buffered for the failure path; stdin/stdout are
  // piped directly (no per-chunk overhead, no buffering knobs needed).
  const ff = spawn("ffmpeg", argv, { stdio: ["pipe", "pipe", "pipe"] });

  let stderrBuf = "";
  ff.stderr.on("data", (chunk) => {
    // Keep at most 8 KB of stderr so a stuck ffmpeg can't OOM the container.
    stderrBuf = (stderrBuf + chunk.toString("utf8")).slice(-8192);
  });

  // Headers go out before the first byte. We don't know the final length, so
  // chunked transfer is implicit (no Content-Length).
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Cache-Control": "no-store",
    "Transfer-Encoding": "chunked",
  });

  // Pipe both directions.
  req.pipe(ff.stdin);
  ff.stdout.pipe(res);

  // ffmpeg exited non-zero → end the response abruptly with a trailer note.
  // The client side (worker) will see a truncated body + check engine status.
  ff.on("exit", (code) => {
    if (code === 0) return;
    // res may already be flushed; only attempt to end if not yet finished.
    if (!res.writableEnded) {
      try { res.end(); } catch { /* ignore */ }
    }
    console.error(`ffmpeg exited ${code}: ${stderrBuf.slice(-512)}`);
  });

  // Client aborts → kill ffmpeg so the container doesn't run forever.
  req.on("close", () => {
    if (!ff.killed) ff.kill("SIGKILL");
  });
});

server.listen(PORT, () => {
  console.log(`edgesonic-transcoder-image listening on :${PORT}`);
});
