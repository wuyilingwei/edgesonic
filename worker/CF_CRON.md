# Cron Triggers — runtime managed via the Cloudflare API

> Task wrangler.toml's `[triggers]` block is gone. The Worker's
> cron schedules are now configured **exclusively** through the Cloudflare
> REST API at runtime (Settings → Cloudflare integration). This document
> explains why, how to operate it, and what to expect after each deploy.

Companion to [`CF_INTEGRATION.md`](./CF_INTEGRATION.md), which covers token
provisioning, secrets, and analytics. Read that first if you have not yet
configured `CF_API_TOKEN` / `CF_ACCOUNT_ID`.

---

## 1. Why dynamic-only

Before 067 we had two competing sources of truth:

| Source              | How it's set                              | When it wins                      |
| ------------------- | ----------------------------------------- | --------------------------------- |
| `wrangler.toml`     | Static `[triggers]` block, committed code | Every `wrangler deploy`           |
| CF API (`setCron`)  | Settings UI calls `/cf/setCron` at run    | Between deploys                   |

Result: a `wrangler deploy` would silently **overwrite** any cron the admin
had tweaked through the dashboard or Settings UI. The fixed `[0 */1 * * *]`
in `wrangler.toml` reverted every release. There was no way for the operator
to durably set a different cadence without committing it to source control.

067 removes the `[triggers]` block entirely. The Worker's schedules list on
Cloudflare is the single source of truth. The trade-off: `wrangler deploy`
now clears all schedules (no static fallback), and the admin must restore
them after each release. The "Ensure default cron" button automates that
restore in one click.

The scheduled handler in [`src/index.ts`](./src/index.ts) is unchanged —
066 podcast RSS refresh + 051 WebDAV auto-scan + 052 stale work reclaim all
fire on whatever schedules CF currently has for the script.

---

## 2. Default cron expression

`0 */1 * * *` — top of every hour. Covers:

- **046** `refreshAllChannels(env.DB)` — re-fetch every `podcast_channels`
  RSS feed, persist per-channel errors instead of failing the run.
- **051** `maybeRunScheduledScan(env, ctx)` — read each enabled source's
  `scan_interval_hours` and dispatch incremental WebDAV scans when the KV
  `cron:last_scan_ts` is overdue.
- **052** `reclaimStaleWork(env)` — sweep work-queue claims older than the
  reclaim window so an offline browser worker doesn't lock a row forever.

Hourly is the lowest common cadence across these three. If you need denser
ticks (for podcast freshness, say), set a custom cron in the Settings
textarea — see §4.

---

## 3. Standard deploy flow

1. **Deploy the Worker code.**
   ```sh
   cd worker
   wrangler deploy
   ```
   `wrangler` reads `wrangler.toml`, which no longer declares `[triggers]`,
   so the deployed Worker has **zero** scheduled events until step 3.

2. **Sign in as a super admin** (level 3) at
   `https://edgesonic.wuyilingwei.com/` and open **Settings → Cloudflare
   integration**. Confirm the badge shows `CONFIGURED` — the
   `CF_API_TOKEN` Worker Secret survives a deploy because secrets live
   outside the script payload (see CF_INTEGRATION.md §4).

3. **Click "Ensure default cron".** This calls
   `GET /edgesonic/cf/ensureDefaultCron`, which:
   - reads the live schedules via CF API,
   - if the list is **empty**, PUTs `[{ cron: "0 */1 * * *" }]` and toasts
     "Default cron restored",
   - if the list is **non-empty** (e.g. you already wrote a custom cadence
     before the deploy and somehow it survived), no-ops and toasts
     "Schedules already configured — no change".

The cron field in the Settings textarea repopulates with the active
schedules so you can verify visually.

---

## 4. Customising the cadence

For anything other than the hourly default, use the existing **Cron
schedules** textarea (already part of 054):

1. Enter one expression per line. Standard 5-field cron syntax.
   Example: `*/15 * * * *` for every 15 minutes; `0 2 * * *` for 02:00 UTC.
2. Click **Save cron**. The Worker calls `POST /edgesonic/cf/setCron`,
   which PUTs `[{cron: <expr>}, ...]` to
   `/accounts/{id}/workers/scripts/edgesonic/schedules`.
3. CF responds with the canonical schedules including `created_on` and
   `modified_on` timestamps. The toast confirms success.

Notes:

- **Leaving the textarea empty + Save cron** clears all schedules. The
  Worker's `scheduled()` handler will no longer fire at all. Use this if
  you want to temporarily pause podcast/scan ticks for maintenance.
- **Light syntax check**: the endpoint only verifies each line has exactly
  5 whitespace-separated fields before forwarding to CF. Invalid grammar
  is rejected by Cloudflare with a descriptive error message that surfaces
  in the toast.

---

## 5. The wrangler deploy side effect (and why ensureDefaultCron exists)

Cloudflare treats the schedules list as part of the script's configuration.
`wrangler deploy` uploads the script bundle along with a metadata blob
derived from `wrangler.toml`; if that blob omits `[triggers]`, CF
interprets it as "no schedules" and clears the list.

There is no `wrangler` flag we can pass to "leave schedules alone". So the
post-deploy ritual is non-negotiable: **deploy → ensureDefaultCron**.

The reverse is also true. If you want to keep a non-default cadence across
deploys, you must either:

- re-enter it via the **Cron schedules** textarea after each deploy, or
- temporarily put `[triggers]` back in `wrangler.toml` for that release
  (not recommended — defeats the whole point of dynamic management).

The "Ensure default cron" button intentionally only restores the
hourly default. A custom cadence after deploy is treated as an explicit
operator decision and must be re-applied through the regular Save cron
flow.

---

## 6. Verifying state

Three places to check what's actually running:

| Where                          | What it shows                                                  |
| ------------------------------ | -------------------------------------------------------------- |
| Settings → Cron textarea       | Loaded by "Reload cron" — what CF currently has on file        |
| `cf_dashboard` → Workers → cron triggers | The same data, from the dashboard                  |
| `GET /edgesonic/cf/getCron`    | Raw `{ ok, schedules: [{cron, created_on, modified_on}] }`    |

All three should agree. If they don't, the most likely cause is a
mid-deploy race — repeat the deploy + ensureDefaultCron flow.

---

## 7. Failure modes

| Symptom                                    | Likely cause                                          | Fix                                                |
| ------------------------------------------ | ----------------------------------------------------- | -------------------------------------------------- |
| "CF_API_TOKEN / CF_ACCOUNT_ID not configured" | Worker Secrets were also cleared (very rare)       | Re-run Settings → Save token (CF_INTEGRATION.md)   |
| 502 with CF error message in toast         | Token lacks `Workers Scripts:Edit`                    | Rotate token with the missing scope                |
| Cron saved but `scheduled()` never runs    | Script returned 4xx during last invocation (rare)     | Check `wrangler tail`; CF auto-retries next tick   |
| "Schedules already configured" right after a deploy | A previous tab's saveCron ran before you got here | Verify in textarea; restore default manually if needed |
