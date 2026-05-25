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

import { Hono } from "hono";
import { subsonicOK } from "../utils/xml";

export const pingRoutes = new Hono();

pingRoutes.get("/rest/ping", (c) => {
  return c.text(subsonicOK({}), {
    headers: { "Content-Type": "application/xml; charset=UTF-8" },
  });
});

pingRoutes.get("/rest/getLicense", (c) => {
  return c.text(
    subsonicOK({
      license: {
        _attributes: { valid: "true", email: "self-hosted@local", licenseExpires: "2099-12-31T00:00:00Z" },
      },
    }),
    { headers: { "Content-Type": "application/xml; charset=UTF-8" } }
  );
});
