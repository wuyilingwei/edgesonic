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

// 045 — Internet Radio (Subsonic standard).
//
// Endpoints:
//   GET    /rest/getInternetRadioStations
//   GET|POST /rest/createInternetRadioStation
//   GET|POST /rest/updateInternetRadioStation
//   GET|POST /rest/deleteInternetRadioStation
//
// Policy:
//   * Read endpoint: any authenticated user (browse-gated upstream).
//   * CUD endpoints: `manage_radio` permission (admin-only by default).
//   * auth.ts SESSION_ONLY_PATHS pins CUD to web-session credentials so a
//     leaked subsonic_credential / apiKey cannot mutate the station list.
//   * EdgeSonic is a directory only — clients connect to stream_url directly,
//     no proxy here (esChain does not apply to external radio streams).
import { Hono } from "hono";
import { createQueries } from "../db/queries";
import { permissionMiddleware, subsonicError } from "../auth";
import { subsonicOK } from "../utils/xml";
import { mapInternetRadioStation } from "../types/subsonic";
import type { User } from "../types/entities";

export const radioRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const XML = { "Content-Type": "application/xml; charset=UTF-8" } as const;
const attrs = (o: object) => ({
  _attributes: o as Record<string, string | number | boolean | undefined>,
});

// ============================================================================
// Param reader — Subsonic supports both query string and form POST body.
// ============================================================================
async function readField(
  c: import("hono").Context,
  name: string,
): Promise<string | undefined> {
  const fromQuery = c.req.query(name);
  if (fromQuery !== undefined) return fromQuery;
  if (c.req.method === "POST") {
    try {
      const body = await c.req.parseBody();
      const raw = body[name];
      if (raw === undefined) return undefined;
      return Array.isArray(raw) ? String(raw[0]) : String(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// ============================================================================
// getInternetRadioStations — list all stations
// ============================================================================
const getStationsHandler = async (
  c: import("hono").Context<{ Bindings: Env; Variables: { user: User } }>,
) => {
  const queries = createQueries(c.env.DB);
  const rows = await queries.listRadioStations();
  return c.text(
    subsonicOK({
      internetRadioStations: {
        internetRadioStation: rows.map((r) => attrs(mapInternetRadioStation(r))),
      },
    }),
    200, XML,
  );
};

// ============================================================================
// createInternetRadioStation — required: streamUrl, name; optional: homepageUrl
// ============================================================================
const createStationHandler = async (
  c: import("hono").Context<{ Bindings: Env; Variables: { user: User } }>,
) => {
  const user = c.get("user");
  const streamUrl = await readField(c, "streamUrl");
  const name = await readField(c, "name");
  const homepageUrl = await readField(c, "homepageUrl");
  if (!streamUrl || !name) {
    return c.text(
      subsonicError(10, "Required parameter 'streamUrl' or 'name' missing"),
      400, XML,
    );
  }

  const queries = createQueries(c.env.DB);
  const id = crypto.randomUUID().substring(0, 8);
  await queries.createRadioStation({
    id,
    name,
    streamUrl,
    homepageUrl: homepageUrl && homepageUrl !== "" ? homepageUrl : null,
    createdBy: user.username,
  });
  return c.text(subsonicOK({}), 200, XML);
};

// ============================================================================
// updateInternetRadioStation — partial update keyed by id.
// Empty homepageUrl clears the column; omitting it leaves the column untouched.
// ============================================================================
const updateStationHandler = async (
  c: import("hono").Context<{ Bindings: Env; Variables: { user: User } }>,
) => {
  const id = await readField(c, "id");
  if (!id) {
    return c.text(subsonicError(10, "Required parameter 'id' missing"), 400, XML);
  }

  const queries = createQueries(c.env.DB);
  const existing = await queries.getRadioStation(id);
  if (!existing) {
    return c.text(subsonicError(70, "Radio station not found"), 404, XML);
  }

  const name = await readField(c, "name");
  const streamUrl = await readField(c, "streamUrl");
  const homepageUrlRaw = await readField(c, "homepageUrl");

  const patch: { name?: string; streamUrl?: string; homepageUrl?: string | null } = {};
  if (name !== undefined) {
    if (name === "") {
      return c.text(subsonicError(10, "Parameter 'name' must not be empty"), 400, XML);
    }
    patch.name = name;
  }
  if (streamUrl !== undefined) {
    if (streamUrl === "") {
      return c.text(subsonicError(10, "Parameter 'streamUrl' must not be empty"), 400, XML);
    }
    patch.streamUrl = streamUrl;
  }
  if (homepageUrlRaw !== undefined) {
    patch.homepageUrl = homepageUrlRaw === "" ? null : homepageUrlRaw;
  }

  if (Object.keys(patch).length === 0) {
    return c.text(subsonicError(10, "Nothing to update"), 400, XML);
  }

  await queries.updateRadioStation(id, patch);
  return c.text(subsonicOK({}), 200, XML);
};

// ============================================================================
// deleteInternetRadioStation
// ============================================================================
const deleteStationHandler = async (
  c: import("hono").Context<{ Bindings: Env; Variables: { user: User } }>,
) => {
  const id = await readField(c, "id");
  if (!id) {
    return c.text(subsonicError(10, "Required parameter 'id' missing"), 400, XML);
  }
  const queries = createQueries(c.env.DB);
  const changes = await queries.deleteRadioStation(id);
  if (changes === 0) {
    return c.text(subsonicError(70, "Radio station not found"), 404, XML);
  }
  return c.text(subsonicOK({}), 200, XML);
};

// ============================================================================
// Route registration — `/rest/<name>` + `.view` × {GET, POST}.
// ============================================================================
function register(
  path: string,
  middleware: ReturnType<typeof permissionMiddleware> | null,
  handler: (
    c: import("hono").Context<{ Bindings: Env; Variables: { user: User } }>,
  ) => Promise<Response>,
) {
  const paths = [`/rest/${path}`, `/rest/${path}.view`];
  for (const p of paths) {
    if (middleware) {
      radioRoutes.get(p, middleware, handler);
      radioRoutes.post(p, middleware, handler);
    } else {
      radioRoutes.get(p, handler);
      radioRoutes.post(p, handler);
    }
  }
}

// Read endpoint: open to any authenticated user (browse already gated by authMiddleware).
register("getInternetRadioStations", null, getStationsHandler);
// CUD endpoints: manage_radio permission required.
register("createInternetRadioStation", permissionMiddleware("manage_radio"), createStationHandler);
register("updateInternetRadioStation", permissionMiddleware("manage_radio"), updateStationHandler);
register("deleteInternetRadioStation", permissionMiddleware("manage_radio"), deleteStationHandler);
