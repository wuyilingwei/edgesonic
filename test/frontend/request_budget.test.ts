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

// Scheduling checks for the shared low-priority request budget.
// Run: npx tsx test/frontend/request_budget.test.ts

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function run() {
  // navigator is read for the effective-connection tier; keep it absent so the
  // idle limit applies.
  (globalThis as { navigator?: unknown }).navigator = {};
  const { runLowPriority, setPlaybackActive } = await import("../../web/src/lib/requestBudget");

  // -- Playback pins concurrency to one, and prefetch outranks background. ---
  setPlaybackActive(true);
  const order: string[] = [];
  let releaseFirst: () => void = () => {};
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });

  // Occupy the single playback slot, then queue background before prefetch.
  void runLowPriority(() => { order.push("occupier"); return first; }, "background");
  await tick();
  void runLowPriority(async () => { order.push("cover-a"); }, "background");
  void runLowPriority(async () => { order.push("cover-b"); }, "background");
  void runLowPriority(async () => { order.push("prefetch"); }, "prefetch");
  await tick();

  assert(order.length === 1 && order[0] === "occupier",
    "playback holds the queue at one concurrent request");

  releaseFirst();
  await tick();
  await tick();

  assert(order[1] === "prefetch",
    "prefetch drains ahead of background covers queued before it");

  // -- A task that never settles must not hold its slot forever. ------------
  setPlaybackActive(true);
  const stalled = new Promise<void>(() => {});
  void runLowPriority(() => stalled, "background");
  await tick();

  let ranAfterStall = false;
  void runLowPriority(async () => { ranAfterStall = true; }, "prefetch");
  await tick();
  assert(!ranAfterStall, "a running task holds its slot while in flight");

  // SLOT_TIMEOUT_MS is 20s; wait past it in real time would be slow, so assert
  // the timer exists by checking the queue recovers once the slot is freed.
  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 20_500));
  assert(ranAfterStall,
    `stalled task released its slot after the timeout (${Date.now() - started}ms)`);

  setPlaybackActive(false);
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

run().catch((error) => { console.error(error); process.exit(1); });
