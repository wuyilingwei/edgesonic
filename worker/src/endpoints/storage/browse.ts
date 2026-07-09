// endpoints/filebrowse.ts; the scanTags sibling moved to tag/read.ts.
import { Hono } from "hono";
import { permissionMiddleware } from "../../auth";
import { parseMultistatus, stripTrailingSlash, encodePath } from "./scan";
import { srcBaseUrl, type SourceRow } from "../../utils/slices";

export const browseRoutes = new Hono();

// GET /storage/files/list?source=r2|<sourceId>&path=<dir>
browseRoutes.get("/files/list", permissionMiddleware("download"), async (c) => {
  const env = c.env as Env;
  const source = c.req.query("source") || "r2";
  const path = (c.req.query("path") || "").replace(/^\/+|\/+$/g, "");

  if (source === "r2") {
    const prefix = path ? `${path}/` : "";
    const listing = await env.MUSIC_BUCKET.list({ prefix, delimiter: "/" });
    return c.json({
      ok: true,
      source: "r2",
      path,
      dirs: listing.delimitedPrefixes.map((p) => ({
        name: p.substring(prefix.length).replace(/\/$/, ""),
      })),
      files: listing.objects.map((o) => ({
        name: o.key.substring(prefix.length),
        size: o.size,
        contentType: o.httpMetadata?.contentType || null,
        uri: `r2://${o.key}`,
      })),
    });
  }

  const src = await env.DB.prepare(
    "SELECT id, base_url, username, password, root_path FROM storage_sources WHERE id = ? AND enabled = 1"
  ).bind(source).first<SourceRow>();
  if (!src) return c.json({ ok: false, error: "Source not found" }, 404);

  const baseUrl = srcBaseUrl(src);
  const basePath = stripTrailingSlash(new URL(baseUrl).pathname);
  const url = baseUrl + "/" + (path ? encodePath(path) + "/" : "");
  const resp = await fetch(url, {
    method: "PROPFIND",
    headers: {
      Authorization: `Basic ${btoa(`${src.username || ""}:${src.password || ""}`)}`,
      Depth: "1",
      "Content-Type": "application/xml",
    },
    body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getcontenttype/></d:prop></d:propfind>`,
  });
  if (!resp.ok && resp.status !== 207) {
    return c.json({ ok: false, error: `PROPFIND failed: HTTP ${resp.status}` }, 502);
  }

  const entries = parseMultistatus(await resp.text(), basePath)
    .filter((e) => e.path !== path && e.path !== "");
  return c.json({
    ok: true,
    source: src.id,
    path,
    dirs: entries.filter((e) => e.isDir).map((e) => ({ name: e.path.split("/").pop() || e.path })),
    files: entries.filter((e) => !e.isDir).map((e) => ({
      name: e.path.split("/").pop() || e.path,
      size: e.size,
      contentType: e.contentType,
      uri: `webdav://${src.id}/${e.path}`,
    })),
  });
});
