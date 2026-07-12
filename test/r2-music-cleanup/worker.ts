interface Env {
  MUSIC_BUCKET: R2Bucket;
  CLEANUP_TOKEN: string;
}

const PREFIX = "music/";
const KEEP_KEY = "music/";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get("x-cleanup-token") !== env.CLEANUP_TOKEN) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const deleteMode = url.searchParams.get("delete") === "1";
    const keys: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const listing = await env.MUSIC_BUCKET.list({ prefix: PREFIX, cursor, limit: 1000 });
      for (const object of listing.objects) {
        if (object.key !== KEEP_KEY) keys.push(object.key);
      }
      cursor = listing.truncated ? listing.cursor : undefined;
      pages++;
    } while (cursor);

    if (deleteMode) {
      for (let i = 0; i < keys.length; i += 100) {
        await env.MUSIC_BUCKET.delete(keys.slice(i, i + 100));
      }
    }

    return Response.json({
      ok: true,
      mode: deleteMode ? "delete" : "dry-run",
      prefix: PREFIX,
      kept: KEEP_KEY,
      count: keys.length,
      pages,
      keys,
    });
  },
};
