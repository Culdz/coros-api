# Bulk export Coros activities

⚠️ This repository is using a **non-public API** from [COROS Training Hub](https://t.coros.com/) that could break
anytime.

> Bulk export your Coros activities to FIT to import them in a 3rd party

## Getting started

- Install Node.js (see [.nvmrc](.nvmrc) for the supported version)
- Install [pnpm](https://pnpm.io/installation)
- Run `pnpm install`
- Create a `.env` file (see [.env.example](.env.example)) with your email, password and the Coros API URL
- Run `pnpm nest start -- export-activities -out OUT_DIR`.

**Options:**

```
  -o, --out [outDir]              Output directory
  --exportType <fileType>         Export data type (choices: "fit", "tcx", "gpx", "kml", "csv", default: "fit")
  --exportSportTypes <sportType>  Export sport types, comma separated (choices: "all", "run", "indoorRun", "trailRun", "trackRun", "hike", "mtnClimb", "bike", "indoorBike", "roadEbike", "gravelRoadBike", "mountainRiding", "mountainEbike", "helmetBike", "poolSwim", "openWater", "triathlon", "strength", "gymCardio", "gpsCardio", "ski", "snowboard", "xcSki", "skiTouring", "skiTouringOld", "multiSport", "speedsurfing", "windsurfing", "row", "indoorRow", "whitewater", "flatwater", "multiPitch", "climb", "indoorClimb", "bouldering", "walk", "jumpRope", "climbStairs", "customSport", default: "all")
  --fromDate <from>               Export activities created after this date (inclusive). Format must be YYYY-MM-DD
  --toDate <to>                   Export activities created before this date (inclusive). Format must be YYYY-MM-DD
  -h, --help                      display help for command
```

Examples:

```shell
# Download all activities in fit format in Downloads folder
pnpm nest start -- export-activities -o ~/Downloads

# Download all activities between 2025-01-01 and 2025-02-01 in fit format in Downloads folder
pnpm nest start -- export-activities --fromDate 2025-01-01 --toDate 2025-02-01 -o ~/Downloads

# Download all activities in gpx format in Downloads folder
pnpm nest start -- export-activities --exportType gpx -o ~/Downloads

# Download all walk and run in gpx format in Downloads folder
pnpm nest start -- export-activities --exportType gpx --exportSportTypes walk,run -o ~/Downloads
```

## Export Training Schedule

Exports your training calendar schedule for today through the next 7 days into an ICS file.

**Usage:**

```shell
pnpm nest start -- export-training-schedule -o ~/Downloads
```

This creates a file named `training-schedule-YYYY-MM-DD-to-YYYY-MM-DD.ics` in the output directory.

**Options:**

```
  -o, --out [outDir]        Output directory
  --training-start <time>   Start time for training events (HH:mm)
  -h, --help                display help for command
```

Examples:

```shell
# Export training schedule as timed events starting at 07:30
pnpm nest start -- export-training-schedule -o ~/Downloads --training-start 07:30
```

## Notify Hermes about new activities

Polls COROS for newly recorded activities, enriches each with metrics parsed from
its FIT file, and notifies a [Hermes](https://hermes-agent.nousresearch.com/) agent
via its generic webhook. After 48h without an activity, it sends an inactivity nudge.

Designed to be run by cron every minute, **inside the Hermes container** (so it can
reach the webhook on `127.0.0.1`).

**Setup:**
- Set `HERMES_WEBHOOK_URL` (and optionally `HERMES_WEBHOOK_SECRET`) in `.env` — see [.env.example](.env.example).
- On the Hermes side, configure a webhook route whose path matches your URL
  (e.g. `coros`), a `prompt` template that reads payload fields
  (`{activity.name}`, `{activity.distanceKm}`, `{activity.avgHeartRate}`, …), and —
  if you set a secret — the matching `secret`.

**Run once (for testing):**
```shell
pnpm build
node dist/main notify-activities
```

**Crontab (every minute):**
```cron
* * * * * cd /path/to/coros-api && /usr/bin/node dist/main notify-activities >> /var/log/coros-notify.log 2>&1
```

> Note: every-minute polling of the unofficial COROS API is aggressive. A gentler
> interval (e.g. `*/5 * * * *`) works just as well — only the crontab schedule changes.

**Payload shape:**
```jsonc
// new activity
{ "event": "new_activity", "source": "coros",
  "activity": { "labelId", "name", "sportType", "startTime", "endTime",
                "durationSec", "distanceKm", "avgPaceSecPerKm",
                "avgHeartRate", "maxHeartRate", "elevationGainM", "calories" },
  "recentActivities": [ /* prior enriched activities */ ] }

// inactivity nudge
{ "event": "inactive", "source": "coros",
  "inactivity": { "hoursSinceLastActivity", "lastActivity": { ... } } }
```
Metric fields are omitted when the FIT file does not contain them.

## API Documentation

The API used by this project are documented using [Bruno](https://www.usebruno.com/) in the [api folder](./api).

## Licence

[MIT License](LICENSE.md)
