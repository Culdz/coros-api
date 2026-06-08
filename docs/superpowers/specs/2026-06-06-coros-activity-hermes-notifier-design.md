# COROS → Hermes Activity Notifier — Design

**Date:** 2026-06-06
**Status:** Approved (pending spec review)

## Summary

Add a new single-shot CLI command, `notify-activities`, to this NestJS
(`nest-commander`) project. Run by the system crontab every minute *inside the
Hermes agent container*, it polls the unofficial COROS API for newly recorded
activities, enriches each with full metrics parsed from the activity's FIT file,
and notifies a Hermes agent via its generic webhook so Hermes can compare the
activity to recent ones and give feedback/motivation. When more than a
configurable threshold (default 48h) has elapsed since the last activity, it
sends an "inactive" nudge on every run (Hermes throttles).

This is additive. It reuses the existing `CorosAPI` service and does not modify
the existing `export-activities` / `export-training-schedule` commands.

## Goals

- Detect newly recorded COROS activities and notify Hermes about each, exactly once.
- Enrich notifications with real metrics (distance, duration, pace, HR, elevation, calories).
- Include recent activity history in the payload for comparison; Hermes also stores its own.
- Send an inactivity nudge when the idle threshold is exceeded.
- Be gentle on the unofficial COROS API (token caching, bounded query window).
- Not spam the whole activity history on first run.

## Non-Goals

- Long-running/daemon process or in-app scheduler (`@nestjs/schedule`) — crontab owns scheduling.
- Changing existing export commands.
- Persisting activities to a database (a local JSON state file is sufficient).
- Implementing the Hermes side (route config, prompt template) — documented, not coded here.

## Decisions (from brainstorming)

| Topic | Decision |
|-------|----------|
| Hermes transport | HTTP webhook (Hermes generic webhook) |
| Enrichment depth | Parse the FIT file for full metrics |
| Runtime | System crontab runs the command every minute |
| State | Local JSON state file |
| Idle reminder cadence | Send on every run past the threshold (Hermes throttles) |
| History | Send recent N in payload **and** Hermes also stores |
| Webhook auth | Optional HMAC-SHA256 shared secret (generic webhook scheme) |

## Context discovered in the codebase

- `queryActivities` returns minimal per-activity fields only: `date` (number,
  `YYYYMMDD`), `labelId` (string), `name` (nullable), `sportType` (number).
- The COROS detail endpoint (`/activity/detail/download`) returns **only**
  `{ fileUrl }` — no summary stats. Therefore parsing the FIT file is the only
  way to obtain metrics.
- `CorosAuthenticationService.accessToken` is **in-memory only**, set after
  `login()`. A per-minute cron would otherwise log in ~1,440×/day → token
  caching in the state file is required.
- `sportType` is a number; `src/coros/sport-type.ts` currently maps **key→value
  only** (`getSportTypeValueFromKey`, e.g. `run`→`'100'`). The payload needs the
  reverse — the activity's numeric `sportType` (e.g. `100`) → a human label
  (`"run"`). A new reverse-lookup helper (e.g. `getSportTypeKeyFromValue`) must be
  added there; it does not exist yet. (`all`→`'0'`, `run`→`'100'`, etc.)
- Tests use **vitest + msw + fast-check**, with COROS endpoints mocked against
  `COROS_API_BASE_URL` and fixtures built via `buildLoginResponse`,
  `buildQueryActivitiesResponse`, `buildActivity`,
  `buildDownloadActivityDetailResponse` (`src/testing/`).

## The Hermes webhook contract

- `POST {HERMES_WEBHOOK_URL}` — e.g. `http://127.0.0.1:8644/webhooks/coros`
  (port `8644`, route name chosen by the user when configuring Hermes).
- Body: arbitrary JSON. Hermes extracts fields via dot-notation templates in the
  route's `prompt` (e.g. `{activity.distanceKm}`), configured on the Hermes side.
- Auth (generic scheme): if a secret is configured, send
  `X-Webhook-Signature: <raw HMAC-SHA256 hex of the exact request body>`.
  The same secret must be set in Hermes's
  `platforms.webhook.extra.routes.<route>.secret`.
- `Content-Type: application/json`.
- Rate limit: 30 req/min default (our worst case is ~1 req/min — safe).

## Architecture

A new command plus four focused, independently testable units. New code lives
under `src/notify/` (command-runner stays in `src/command-runner/` to match the
existing convention).

```
crontab (every 1 min)
  └─ node dist/main notify-activities        NotifyActivitiesCommandRunner
        └─ ActivityWatcher  (orchestrator)
              ├─ CorosAPI                     (existing) login / query / detail
              ├─ FitMetricsParser             FIT bytes → ActivityMetrics
              ├─ HermesNotifier               build + sign + POST payload
              └─ ActivityStateStore           load/save local JSON state
```

### Units

**`NotifyActivitiesCommandRunner`** (`src/command-runner/notify-activities.command-runner.ts`)
- `@Command({ name: 'notify-activities' })`, registered in `AppModule`.
- Reads config (see below), delegates one poll cycle to `ActivityWatcher`, exits.
- Minimal/zero CLI flags — configuration comes from env so crontab stays simple.
  (Optional `--dry-run` flag to log the payload without POSTing — nice for setup.)

**`ActivityWatcher`** (`src/notify/activity-watcher.ts`)
- Orchestrates one cycle (see Flow). Pure-ish: depends on the four collaborators
  and an injectable `Clock` (`now()`) so the 48h logic is deterministic in tests.

**`FitMetricsParser`** (`src/notify/fit-metrics-parser.ts`)
- Input: FIT file bytes (`Buffer`/`Uint8Array`). Output: `ActivityMetrics`.
- Uses **`fit-file-parser`** (pure JS, no install/build script → satisfies the
  repo's `pnpm-workspace` `trustPolicy`/`allowBuilds`). Reads the FIT `session`
  message for totals. Maps fields, with all metrics optional (a given sport may
  lack HR, distance, etc.):
  - `startTime`, `endTime` (ISO 8601)
  - `durationSec` (total_timer_time)
  - `distanceKm` (total_distance / 1000)
  - `avgPaceSecPerKm` (derived from distance + duration when distance > 0)
  - `avgHeartRate`, `maxHeartRate`
  - `elevationGainM` (total_ascent)
  - `calories` (total_calories)
- Alternative considered: `@garmin/fitsdk` (official). `fit-file-parser` chosen
  for a simpler session-summary mapping; swap is low-cost if needed.

**`HermesNotifier`** (`src/notify/hermes-notifier.ts`)
- `notify(payload)`: serialize → if secret set, compute HMAC-SHA256 hex over the
  exact serialized string and set `X-Webhook-Signature` → POST via the existing
  `HttpService` to `HERMES_WEBHOOK_URL` with `Content-Type: application/json`.
- Returns success/failure; never throws past the watcher (failures are handled).
- HMAC uses Node's `crypto.createHmac('sha256', secret).update(body).digest('hex')`.

**`ActivityStateStore`** (`src/notify/activity-state-store.ts`)
- `load(): State` (returns an empty/initial state if the file is missing) and
  `save(state)` (atomic write: write temp file + rename).
- Validates the file with a zod schema (consistent with the codebase's zod use);
  on a corrupt/invalid file, logs and treats it as empty (self-heals).

### State file schema (`COROS_STATE_FILE`, default `./.coros-state.json`)

```jsonc
{
  "version": 1,
  "seenLabelIds": ["<labelId>", ...],     // dedupe set
  "lastActivityEndTime": "2026-06-06T10:00:00.000Z" | null,
  "lastActivityLabelId": "<labelId>" | null,
  "accessToken": "<token>" | null,        // cached COROS token
  "accessTokenIssuedAt": "<ISO>" | null,
  "recentActivities": [ /* last RECENT_HISTORY_COUNT enriched summaries */ ]
}
```

The state file is added to `.gitignore` (it holds a token).

### Notification payloads

```jsonc
// new activity
{
  "event": "new_activity",
  "source": "coros",
  "activity": {
    "labelId": "...", "name": "Morning Run", "sportType": "run",
    "startTime": "...", "endTime": "...",
    "durationSec": 0, "distanceKm": 0, "avgPaceSecPerKm": 0,
    "avgHeartRate": 0, "maxHeartRate": 0, "elevationGainM": 0, "calories": 0
  },
  "recentActivities": [ /* prior enriched summaries, newest first */ ]
}

// inactivity nudge
{
  "event": "inactive",
  "source": "coros",
  "inactivity": {
    "hoursSinceLastActivity": 53,
    "lastActivity": { "labelId": "...", "name": "...", "sportType": "...", "endTime": "..." }
  }
}
```

Metric fields are omitted (not zeroed) when the FIT file lacks them.

## Flow (one poll cycle)

1. **Load** config + state.
2. **Auth**: if a cached token exists and `now − accessTokenIssuedAt <
   ACCESS_TOKEN_TTL_HOURS`, reuse it by setting
   `corosAuthenticationService.accessToken = cachedToken` before any request;
   else `login()` (which only sets the token internally on
   `CorosAuthenticationService` and returns no token), then read it back via
   `corosAuthenticationService.accessToken` and cache it + issued-at. On any
   `401` during a request, re-login once and retry.
3. **Query** activities for a bounded recent window (default: last 7 days). Pass
   the "all" sport-type **value** `['0']` (i.e. `[DefaultSportType.value]`) to
   `queryActivities`, which expects numeric value strings, not keys.
4. **Diff**: `new = activities where labelId ∉ seenLabelIds`.
5. **Bootstrap** (first run = empty `seenLabelIds`): add all current labelIds to
   `seenLabelIds`, set `lastActivityEndTime`/`lastActivityLabelId` from the most
   recent activity (download+parse just that one to get a precise end time; if
   that fails, fall back to its `YYYYMMDD` date at local midnight), **do not
   notify**, persist, then go to step 8 (idle check still runs but won't fire
   right after seeding).
6. **Enrich + notify** each new activity, oldest → newest:
   a. `downloadActivityDetail` → `fileUrl`; fetch FIT bytes (axios, arraybuffer).
   b. `FitMetricsParser` → metrics; build `activity` payload (sport label via
      `sport-type.ts`).
   c. `HermesNotifier.notify({ event: "new_activity", activity, recentActivities })`.
   d. **Only on POST success**: add labelId to `seenLabelIds`, update
      `lastActivityEndTime`/`lastActivityLabelId` (max end time), unshift the
      enriched summary into `recentActivities` (cap at `RECENT_HISTORY_COUNT`).
      On failure: leave unseen so the next run retries (no dupes, no loss).
7. (Activities that failed to enrich/notify are simply retried next cycle.)
8. **Idle check**: if `lastActivityEndTime` set and
   `now − lastActivityEndTime > INACTIVITY_THRESHOLD_HOURS`, POST the `inactive`
   payload (fire-and-forget; sent every run past the threshold).
9. **Persist** state (atomic).

## Configuration (env / `.env`)

| Var | Required | Default | Meaning |
|-----|----------|---------|---------|
| `COROS_API_URL` | yes (existing) | — | COROS regional API base URL |
| `COROS_EMAIL` / `COROS_PASSWORD` | yes (existing) | — | COROS credentials |
| `HERMES_WEBHOOK_URL` | yes | — | e.g. `http://127.0.0.1:8644/webhooks/coros` |
| `HERMES_WEBHOOK_SECRET` | no | unset | HMAC secret; if set, send `X-Webhook-Signature` |
| `COROS_STATE_FILE` | no | `./.coros-state.json` | State file path |
| `INACTIVITY_THRESHOLD_HOURS` | no | `48` | Idle-nudge threshold |
| `RECENT_HISTORY_COUNT` | no | `5` | Recent activities included in payload |
| `ACCESS_TOKEN_TTL_HOURS` | no | `6` | Reuse cached token within this window |

`.env.example` is updated with the new vars. Config is read/validated with zod,
following the existing `CorosConfigService` pattern.

## Error handling

- **COROS query/login failure** → log, exit cleanly (cron retries next minute).
- **Per-activity enrich/notify failure** → log, leave the activity unseen → retried.
- **Hermes `429`** → treat as a soft failure for that POST (retried next minute);
  no special backoff beyond the natural 1-minute cadence.
- **Corrupt state file** → log, treat as empty (self-heal).
- **Expired token (`401`)** → re-login once, retry the request.
- The command should exit non-zero only on unexpected/programmer errors, so cron
  logs stay clean for the normal "nothing new" case.

## Testing (vitest + msw + fast-check, matching existing conventions)

- **`FitMetricsParser`** (unit): commit a small fixture `.fit` file under
  `src/testing/fixtures/`; assert parsed metrics; assert graceful handling of a
  FIT with no HR/distance (fields omitted) and of malformed bytes (throws/handled).
- **`HermesNotifier`** (unit, msw): asserts method/URL/`Content-Type`; asserts
  `X-Webhook-Signature` equals the expected HMAC when a secret is set and is
  absent when unset; asserts payload shape.
- **`ActivityStateStore`** (unit): JSON round-trip; missing file → empty state;
  corrupt file → empty state; atomic save leaves no partial file.
- **`ActivityWatcher` / `notify-activities`** (integration, msw mocks COROS +
  Hermes, temp state file, injected `Clock`):
  - first run seeds state and sends **no** `new_activity`;
  - a new activity is enriched and POSTed exactly once;
  - re-running with the same activities POSTs **nothing** (dedupe);
  - a Hermes POST failure leaves the activity unseen → the next run retries;
  - past the threshold, an `inactive` payload is sent (clock-driven);
  - cached, unexpired token is reused (no second `login` call); expired token
    triggers re-login.

## Dependencies

- Add `fit-file-parser` (pure JS; no build script → no `allowBuilds` change).
  Note `pnpm-workspace.yaml` `minimumReleaseAge: 4320` — pin a version older than
  ~3 days (any stable release qualifies).

## Deployment

- Build once: `pnpm build`.
- Crontab inside the Hermes container (every minute):
  ```cron
  * * * * * cd /path/to/coros-api && /usr/bin/node dist/main notify-activities >> /var/log/coros-notify.log 2>&1
  ```
- Configure the Hermes generic webhook route (name = path in `HERMES_WEBHOOK_URL`)
  with a `prompt` template referencing payload fields and, if used, the matching
  `secret`. README gets a new section documenting the command, env vars, the
  crontab line, and the Hermes route setup.
- **Note:** every-minute polling of an unofficial API is aggressive; a 5-minute
  interval is gentler with negligible latency cost. The interval is just the
  crontab schedule, so it is trivial to change. Default stays 1 minute per the
  user's request.

## Open questions / follow-ups

- Confirm the FIT `session` field names emitted by COROS files match
  `fit-file-parser`'s output once a real fixture is available (covered by the
  parser test against a committed fixture).
- The exact Hermes route name and `prompt` template are configured by the user on
  the Hermes side; this project only defines the payload shape.
