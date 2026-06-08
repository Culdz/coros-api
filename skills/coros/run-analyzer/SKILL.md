---
name: run-analyzer
description: Analyze a single running/endurance activity from a pre-digested FIT payload and produce a structured evaluation — a session score, a comparison against the athlete's past activities, concrete improvement vectors, and a suggested next session. Use this skill whenever the user shares an activity payload (fields like activity.distanceKm, avgPaceSecPerKm, avgHeartRate, etc.), asks to "evaluate my run", "analyze this session", "comment ça s'est passé", "compare to my last runs", or wants training feedback on a workout. Trigger even when the user just pastes activity JSON without an explicit question — they want an evaluation. Also handle `event: history_backfill` with `sportCategory: "endurance"` — a one-time batch of past runs/rides/swims to seed the history.
---

# Run Analyzer

Analyze one activity against the athlete's history and return an actionable evaluation. Works on a pre-digested payload (no raw FIT parsing needed).

## Input shape

A single activity is a JSON object. History is an array of the same objects (most recent last, or with a date field). Canonical fields — tolerate missing ones, never invent values:

| Field | Meaning |
|---|---|
| `event` | `new_activity` (an activity to evaluate) or `inactive` (48h idle nudge — see below) |
| `activity.labelId` | unique id — **use this as the dedup key** |
| `activity.name` | activity name |
| `activity.sportType` | `run`, `trailRun`, `trackRun`, `indoorRun`, `bike`, `indoorBike`, `poolSwim`, `openWater`, `hike`, `walk`, … |
| `activity.startTime` / `activity.endTime` | ISO-8601 UTC |
| `activity.distanceKm` | distance |
| `activity.durationSec` | total time (s) |
| `activity.avgPaceSecPerKm` | average pace (s/km) |
| `activity.avgHeartRate` / `activity.maxHeartRate` / `activity.minHeartRate` | HR (bpm) |
| `activity.elevationGainM` | total ascent (m) |
| `activity.calories` | kcal |
| `activity.subSport` | FIT sub-sport (e.g. `generic`, `trail`, `treadmill`) — *if present* |
| `activity.avgTemperature` | °C — *if present* |
| `recentActivities[]` | up to 5 prior activity objects (same shape, newest-first), bundled in the payload |
| `activity.splitsKm[]` | per-km `{ paceSecPerKm, heartRate, cadenceSpm, elevationM }` — *only when present (FIT enrichment)* |
| `activity.avgCadenceSpm` / `activity.avgPowerW` | *only when present (FIT enrichment)* |
| `rpe` | perceived effort 1–10 — only if the user supplies it manually |

**Field reality:** every field is nested under `activity.*` and may be absent — tolerate missing ones, never invent values. The split-based analysis (decoupling, HR drift, pace CV, cadence) needs `activity.splitsKm[]` / `activity.avgCadenceSpm`; when those aren't present, skip those components and redistribute their weight (see `references/scoring.md`).

If the user pastes free-text stats instead of JSON, map them to these fields first.

## History store (persistent, required for comparison)

The athlete's history lives in a single JSON file the skill reads and appends to. This makes the skill autonomous when triggered headless (e.g. a Hermes webhook from Coros) — there's no user in the loop to attach past data.

- **Path:** `$HERMES_HOME/run-analyzer/history.json`, falling back to `~/.hermes/run-analyzer/history.json` if `$HERMES_HOME` is unset. Resolve and remember this as `HISTORY_PATH`.
- **Shape:** `{ "activities": [ <activity-object>, ... ] }` — same field schema as the input, most recent appended last.
- The skill **owns** this file. It must read it at the start of every run and append the current activity at the end of every run (see steps 1 and 7). Never overwrite the array; always append.

## Workflow

1. **Locate the data + load history.** The current activity is required (from the message, an attached file, or — under a webhook — the rendered payload). Then load history:
   ```bash
   HISTORY_PATH="${HERMES_HOME:-$HOME/.hermes}/run-analyzer/history.json"
   mkdir -p "$(dirname "$HISTORY_PATH")"
   [ -f "$HISTORY_PATH" ] || echo '{"activities":[]}' > "$HISTORY_PATH"
   cat "$HISTORY_PATH"
   ```
   Then **merge any `recentActivities[]` from the payload into history** (append entries whose `labelId` isn't already stored) and save — this seeds the bot with context even on the very first activity it sees (the notifier backfills recent history at bootstrap). Use the merged set as the comparison set. If it still has fewer than ~3 comparable entries, keep the message lighter (no trend claims) — never block on thin history.

2. **Normalize.** Convert paces to `mm:ss/km` for display, durations to `h:mm:ss`. Compute derived metrics: speed, HR drift (compare first-third vs last-third split HR), pace variability (coefficient of variation across splits), decoupling (pace:HR ratio drift), grade-adjusted pace if `elevationGainM` and `splitsKm` allow it.

3. **Form an internal read (don't print it).** Use `references/scoring.md` to privately gauge the session — easy/solid/hard, well-executed or ragged — to set the *tone* of the coaching message. This is internal: do not output a number or a rubric.

4. **Compare to history.** Percentile or trend for the key metrics (pace at comparable HR, distance, cadence, decoupling) vs the athlete's own past activities of the same type. Lead with same-type, similar-distance comparisons. Never compare to other people.

5. **Improvement vectors.** 2–4 concrete, prioritized items tied to the data (e.g. "cadence 168 spm is below your 176 average — short, quick strides on easy runs"). Each vector = observation → why it matters → one actionable change.

6. **Next session.** One suggested workout coherent with this session and recent load (don't stack hard on hard).

7. **Append to history.** After producing the evaluation, append the current activity to `HISTORY_PATH` so the next run can compare against it. Append-only, atomic, never lose existing entries:
   ```bash
   CURRENT_JSON='<the current activity object, exactly as analyzed>'
   tmp="$(mktemp)"
   jq --argjson a "$CURRENT_JSON" \
      '.activities |= (if any(.[]; .labelId == ($a.labelId)) then . else . + [$a] end)' \
      "$HISTORY_PATH" > "$tmp" && mv "$tmp" "$HISTORY_PATH"
   ```
   **Dedup on `labelId`** — webhooks retry, so never append an activity whose `labelId` is already stored. If `jq` is unavailable, do the equivalent read-modify-write in Python. Don't let an append failure block delivery; report it briefly instead.

## The `inactive` event

If `event` is `inactive`, this is a 48h-idle nudge, not a run to evaluate. The payload is `{ inactivity: { hoursSinceLastActivity, lastActivity } }`. Send a short, warm "get back out there" message: note how long it's been, reference `lastActivity` if it has detail, suggest an easy way back. No score, no history append.

## The `history_backfill` event

If `event` is `history_backfill`, this is a **one-time seed** of past runs (sent once at setup), not a run to coach. The payload is `{ sportCategory: "endurance", activities: [ ... ] }`. Ingest **every** entry in `activities[]` into the history file, dedup by `labelId`, then reply with **one** short confirmation (e.g. *"J'ai chargé tes N dernières sorties — je connais ton historique maintenant 👌"*). Do not coach or score individual activities.

```bash
HISTORY_PATH="${HERMES_HOME:-$HOME/.hermes}/run-analyzer/history.json"
mkdir -p "$(dirname "$HISTORY_PATH")"; [ -f "$HISTORY_PATH" ] || echo '{"activities":[]}' > "$HISTORY_PATH"
BATCH='<the activities array from the payload>'
tmp="$(mktemp)"
jq --argjson b "$BATCH" '.activities = ((.activities + $b) | unique_by(.labelId))' "$HISTORY_PATH" > "$tmp" && mv "$tmp" "$HISTORY_PATH"
```
If `jq` is unavailable, do the equivalent read-modify-write in Python (concatenate, keep one per `labelId`).

## Output format — a short coach's message

Output **only a brief, warm coaching message** — like a coach texting the athlete, not a report. Use everything above (your internal read, history, recency, frequency) to DECIDE what to say, but do **not** print scores, numbers tables, percentiles, or section headers.

- 2–4 short sentences, ~40–80 words, plain text (an emoji or two is fine).
- Open with a quick, specific acknowledgement (sport + one concrete detail — distance, duration, or that the effort was well-judged).
- Add **one** focus or encouragement grounded in the data (a trend, consistency, or effort observation).
- Optionally one reminder (hydration, sleep/recovery, don't stack hard days).
- If there's a notable gap, nudge on it — recency/frequency only ("ça fait 8 jours sans course, ne perds pas ton fond"). You **cannot** reference specific muscle groups or exercises (that data doesn't exist).
- Warm, motivating, concrete. Respond in the user's language (French by default).

Example tone: *"Belle sortie de 10 km, allure régulière 👌 Tu cours 3× cette semaine, super régularité — pense à bien t'hydrater et garde la prochaine en footing tranquille. Continue comme ça !"*

## Safety

Not medical advice. Flag genuinely concerning signals (e.g. HR far above prior max, sharp unexplained decoupling) by suggesting rest/check-in, without diagnosing. Don't give precise calorie/weight targets. If the user shows signs of overtraining or compulsive patterns, prioritize recovery framing over performance.

See `references/scoring.md` for the scoring rubric and `references/metrics.md` for metric formulas. The skill maintains its own history file (see "History store") so it works both interactively and when triggered headless by a webhook — in the latter case it reads history, analyzes, and appends without any user in the loop.
