// Strip decorations that differ between a filename/upstream title and the
// canonical library title but don't change what song it is: leading track
// numbers ("01.", "01 - ", "#1 "), collapsed whitespace, case. Applied
// symmetrically to both sides before comparing so fuzzy title matching
// (search3 lookups, upstream push matching) isn't defeated by formatting.
const METADATA_SEPARATOR_RE = /[,，;；\/]+/g;

export function normalizeForMatch(raw: string | undefined): string {
  let s = (raw || "").toLowerCase();
  s = s.replace(METADATA_SEPARATOR_RE, " ");
  s = s.replace(/[#＃]\s*\d+\s*/g, " ");
  s = s.replace(/^\s*\d{1,3}\s*[-–—_.、．:：)）]\s*/, "");
  s = s.replace(/^\s*\d{1,3}\s+/, "");
  return s.replace(/\s+/g, " ").trim();
}
