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

//
// Profiles are the only thing engines, the Settings UI, and the
// transcode_jobs table agree on. New profiles must be added here and
// nowhere else.

import type { TranscodeProfile } from "./engine";

// Default catalogue. The Settings UI multi-select source-of-truth.
// Bitrates are kbps. priority is used only by 036 when picking the best
// available pre-baked instance for a stream request.
export const DEFAULT_PROFILES: TranscodeProfile[] = [
  { id: "mp3-128k", codec: "libmp3lame", bitrate: 128, container: "mp3",  contentType: "audio/mpeg",        priority: 1 },
  { id: "mp3-192k", codec: "libmp3lame", bitrate: 192, container: "mp3",  contentType: "audio/mpeg",        priority: 2 },
  { id: "aac-96k",  codec: "aac",        bitrate: 96,  container: "m4a",  contentType: "audio/mp4",         priority: 3 },
  { id: "aac-128k", codec: "aac",        bitrate: 128, container: "m4a",  contentType: "audio/mp4",         priority: 4 },
  { id: "opus-64k", codec: "libopus",    bitrate: 64,  container: "opus", contentType: "audio/opus",        priority: 5 },
  { id: "opus-96k", codec: "libopus",    bitrate: 96,  container: "opus", contentType: "audio/opus",        priority: 6 },
  { id: "vorbis-96k", codec: "libvorbis", bitrate: 96, container: "ogg",  contentType: "audio/ogg",         priority: 7 },
  { id: "flac-lossless", codec: "flac",  bitrate: 0,   container: "flac", contentType: "audio/flac",        priority: 8 },
];

const PROFILE_INDEX: Map<string, TranscodeProfile> = new Map(
  DEFAULT_PROFILES.map((p) => [p.id, p])
);

export function getProfile(id: string): TranscodeProfile | null {
  return PROFILE_INDEX.get(id) ?? null;
}

export function listProfiles(): TranscodeProfile[] {
  return DEFAULT_PROFILES.slice();
}

// ffmpeg argv builder. Returns the arg list without the leading "ffmpeg"
// binary so callers can choose to spawn directly or send to a remote API.
//
// Layout:
//  -hide_banner -loglevel error -i pipe:0
//   -vn -sn -dn         (drop video/subtitle/data tracks)
//  -c:a <codec>
//   [-b:a <bitrate>k]   (omitted for lossless flac)
//  -f <format> pipe:1
export function buildFfmpegArgs(profile: TranscodeProfile): string[] {
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-i", "pipe:0",
    "-vn", "-sn", "-dn",
    "-c:a", profile.codec,
  ];

  if (profile.bitrate > 0) {
    args.push("-b:a", `${profile.bitrate}k`);
  }

  // Container → ffmpeg -f format string. m4a uses ipod for streamable AAC.
  const fmt = formatForContainer(profile.container);
  args.push("-f", fmt, "pipe:1");

  return args;
}

function formatForContainer(c: TranscodeProfile["container"]): string {
  switch (c) {
    case "mp3":  return "mp3";
    case "m4a":  return "ipod";    // streamable MP4 audio
    case "opus": return "opus";
    case "ogg":  return "ogg";
    case "flac": return "flac";
  }
}

// Parse / validate a JSON array of profile ids (the default_transcode_profiles
// feature). Unknown ids are dropped — never throws — so Settings UI typos
// degrade gracefully instead of breaking pre-bake jobs.
export function parseProfileIdList(raw: string | null | undefined): TranscodeProfile[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: TranscodeProfile[] = [];
  for (const v of parsed) {
    if (typeof v !== "string") continue;
    const p = getProfile(v);
    if (p) out.push(p);
  }
  return out;
}
