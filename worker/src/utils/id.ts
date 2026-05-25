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

const ENTITY_TYPES: Record<string, string> = {
  song_instance: "00",
  song_master: "01",
  album: "02",
  artist: "03",
  playlist: "04",
  user: "05",
  storage_source: "06",
} as const;

const ENTITY_SUBTYPES: Record<string, Record<string, string>> = {
  song_instance: { original: "00", cache_ttl: "01", cache_perm: "02", uploaded: "03" },
  song_master: { standard: "00", merged: "01" },
  album: { standard: "00", compilation: "01" },
  artist: { standard: "00", various: "01" },
  playlist: { standard: "00" },
  user: {},
  storage_source: {},
} as const;

function sourceCode(sourceIndex: number): string {
  return sourceIndex.toString(16).padStart(4, "0").toLowerCase();
}

async function sha256Hex(input: string, len = 12): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = Array.from(new Uint8Array(hash));
  return bytes.slice(0, len).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function generateId(
  entityType: keyof typeof ENTITY_TYPES,
  subtypeKey: string,
  sourceIndex: number,
  contentKey: string
): Promise<string> {
  const xx = ENTITY_TYPES[entityType];
  const yy = ENTITY_SUBTYPES[entityType][subtypeKey] ?? "00";
  const zzzz = sourceCode(sourceIndex);
  const body = await sha256Hex(contentKey);
  return `${xx}${yy}${zzzz}${body}`;
}

export function parseId(
  id: string
): { entityType: string; subType: string; sourceId: number; body: string } {
  const xx = id.substring(0, 2);
  const yy = id.substring(2, 4);
  const zzzz = id.substring(4, 8);
  const body = id.substring(8);
  return {
    entityType: xx,
    subType: yy,
    sourceId: parseInt(zzzz, 16),
    body,
  };
}
