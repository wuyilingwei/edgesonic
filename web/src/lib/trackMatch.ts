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

// Strip decorations that differ between a filename/upstream title and the
// canonical library title but don't change what song it is: leading track
// numbers ("01.", "01 - ", "#1 "), collapsed whitespace, case. Applied
// symmetrically to both sides before comparing so fuzzy title matching
// (search3 lookups, upstream push matching) isn't defeated by formatting.
export function normalizeForMatch(raw: string | undefined): string {
  let s = (raw || "").toLowerCase();
  s = s.replace(/[#＃]\s*\d+\s*/g, " ");
  s = s.replace(/^\s*\d{1,3}\s*[-–—_.、．:：)）]\s*/, "");
  s = s.replace(/^\s*\d{1,3}\s+/, "");
  return s.replace(/\s+/g, " ").trim();
}
