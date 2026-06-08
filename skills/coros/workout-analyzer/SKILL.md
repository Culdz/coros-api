---
name: workout-analyzer
description: Analyze a single strength/musculation (or gym) session from a COROS webhook payload and produce a structured evaluation — an effort/consistency score, a comparison against the athlete's past strength sessions, concrete improvement vectors, and a suggested next session. The COROS payload is SESSION-LEVEL only (heart rate, duration, calories) — there is NO per-exercise/set/rep/weight data, so this is an effort-and-recovery analysis, not a volume/load analysis. Use whenever the user shares a strength activity payload (sportType "strength"/"gymCardio"/"gpsCardio"), asks to "évalue ma séance", "analyse ma muscu", "evaluate my workout", "comment ça s'est passé", or pastes an activity JSON with a strength sportType. Trigger even with no explicit question — they want an evaluation. Also handle `event: history_backfill` with `sportCategory: "strength"` — a one-time batch of past strength sessions to seed the history.
tags: [fitness, strength, musculation, gym, training, analytics, webhook]
related_skills: [run-analyzer]
---

# Workout Analyzer (Musculation / Strength)

Evaluate one strength session against the athlete's history. **Hard constraint on the data:** COROS exports a strength workout as session-level metrics only — heart rate (avg/max, sometimes min), duration, and calories. There are **no exercises, sets, reps, weights, volume, RPE, or muscle groups** in the payload, and there's no way to derive them. So this skill measures **effort, intensity, consistency, and recovery** — never volume or load. Do not ask for, expect, or invent set/rep/weight data.

## Input shape

The current session is a JSON object delivered by the COROS → Hermes webhook. Canonical fields — tolerate missing ones, never invent values:

| Field | Meaning |
|---|---|
| `event` | `new_activity` (a logged session) or `inactive` (48h idle nudge — handle separately, see below) |
| `activity.labelId` | unique id — **use this as the dedup key** |
| `activity.name` | session name (e.g. "Strength") |
| `activity.sportType` | `strength`, `gymCardio`, or `gpsCardio` |
| `activity.startTime` / `activity.endTime` | ISO-8601 UTC |
| `activity.durationSec` | total session time (seconds) |
| `activity.avgHeartRate` / `activity.maxHeartRate` | HR (bpm) |
| `activity.minHeartRate` | HR (bpm) — *only if present* |
| `activity.calories` | kcal |
| `activity.subSport` | e.g. `strength_training`, `gym_cardio` — *only if present* |
| `activity.avgTemperature` | °C — *only if present, minor context* |
| `recentActivities[]` | up to 5 prior session objects (same shape, newest-first) bundled in the payload — supplementary context |

There is deliberately **no** `distanceKm`, `avgPaceSecPerKm`, `elevationGainM`, `exercises[]`, `sets`, `reps`, `weight`, `totalVolume`, or `muscleGroupsFocused` for strength sessions. If a payload *does* carry distance/pace (i.e. it's actually a run mis-routed here), defer to `run-analyzer`.

If the user pastes free-text stats instead of JSON, map them to these fields first.

## History store (persistent, required for comparison)

The athlete's strength history lives in a single JSON file the skill reads and appends to, so it's autonomous under a headless webhook.

- **Path:** `$HERMES_HOME/workout-analyzer/history.json`, falling back to `~/.hermes/workout-analyzer/history.json` if `$HERMES_HOME` is unset. Resolve and remember as `HISTORY_PATH`.
- **Shape:** `{ "sessions": [ <activity-object>, ... ] }` — same field schema as `activity`, most recent appended last.
- The skill **owns** this file: read it at the start of every run, append the current session at the end. Never overwrite; always append. **Dedup on `labelId`** (webhooks retry).

## Workflow

1. **Locate the data + load history.** The current session is `activity` from the rendered payload. Then:
   ```bash
   HISTORY_PATH="${HERMES_HOME:-$HOME/.hermes}/workout-analyzer/history.json"
   mkdir -p "$(dirname "$HISTORY_PATH")"
   [ -f "$HISTORY_PATH" ] || echo '{"sessions":[]}' > "$HISTORY_PATH"
   cat "$HISTORY_PATH"
   ```
   Then **merge any `recentActivities[]` from the payload into `sessions`** (append entries whose `labelId` isn't already stored) and save — the notifier backfills recent history at bootstrap, so this seeds the bot with context even on the first session it sees. Use the merged set as the comparison set. With fewer than ~3 comparable strength sessions, keep the message lighter (no trend claims) — never block on thin history.

2. **Normalize + derive.** Duration → `h:mm:ss` and minutes. Then compute (see `references/metrics.md`): **relative intensity** (`avgHeartRate` vs the athlete's estimated max HR — the highest `maxHeartRate` across history, else this session's max), **HR range** (`maxHeartRate − minHeartRate` if min present), **calorie density** (`calories / durationMin`), **training frequency** (strength sessions in the trailing 7 and 28 days), and **recovery gap** (days since the previous strength session, from history `startTime`s).

3. **Form an internal read (don't print it).** Use `references/scoring.md` to privately gauge the session — light / solid / hard, well-judged or under-recovered — to set the *tone* of the coaching message. This is internal: do not output a number or a rubric.

4. **Compare to history.** Trend or percentile for the metrics we actually have — avg HR, relative intensity, duration, calorie density, weekly frequency — vs the athlete's own past strength sessions. Lead with same-`sportType` comparisons. Never compare to other people.

5. **Improvement vectors.** 2–4 concrete, prioritized items tied to the data (e.g. "3 strength sessions in 7 days with shrinking recovery gaps — intensity is fine, but back-to-back days risk under-recovery"). Each = observation → why it matters → one actionable change. Stay within what HR/duration/frequency can support; don't invent form/volume advice.

6. **Next session.** One suggestion coherent with this session and recent load — balance hard/easy, respect recovery, and (since we can't see muscle groups) frame it by effort/intent and rest, e.g. "lighter technique-focused session or a rest day; next hard session in 48h".

7. **Append to history.** Append the current session to `HISTORY_PATH`, append-only, atomic, dedup on `labelId`:
   ```bash
   CURRENT_JSON='<the current activity object, exactly as analyzed>'
   tmp="$(mktemp)"
   jq --argjson s "$CURRENT_JSON" \
      '.sessions |= (if any(.[]; .labelId == ($s.labelId)) then . else . + [$s] end)' \
      "$HISTORY_PATH" > "$tmp" && mv "$tmp" "$HISTORY_PATH"
   ```
   If `jq` is unavailable, do the equivalent read-modify-write in Python. Don't let an append failure block delivery of the analysis; report it briefly instead.

## The `inactive` event

If `event` is `inactive`, this isn't a session to score. The payload is `{ inactivity: { hoursSinceLastActivity, lastActivity } }`. Produce a short, encouraging nudge: note how long it's been (`hoursSinceLastActivity`), reference `lastActivity` if it carries detail, and suggest an easy way back in. No score, no history append.

## The `history_backfill` event

If `event` is `history_backfill`, this is a **one-time seed** of past sessions (sent once when the integration is set up), not a session to coach. The payload is `{ sportCategory: "strength", activities: [ ... ] }`. Ingest **every** entry in `activities[]` into the history file, dedup by `labelId`, then reply with **one** short confirmation (e.g. *"J'ai chargé tes N dernières séances de muscu — je connais ton historique maintenant 💪"*). Do not coach or score individual sessions.

```bash
HISTORY_PATH="${HERMES_HOME:-$HOME/.hermes}/workout-analyzer/history.json"
mkdir -p "$(dirname "$HISTORY_PATH")"; [ -f "$HISTORY_PATH" ] || echo '{"sessions":[]}' > "$HISTORY_PATH"
BATCH='<the activities array from the payload>'
tmp="$(mktemp)"
jq --argjson b "$BATCH" '.sessions = ((.sessions + $b) | unique_by(.labelId))' "$HISTORY_PATH" > "$tmp" && mv "$tmp" "$HISTORY_PATH"
```
If `jq` is unavailable, do the equivalent read-modify-write in Python (concatenate, keep one per `labelId`).

## Output format — a short coach's message

Output **only a brief, warm coaching message** — like a coach texting the athlete, not a report. Use everything above (your internal read, history, recency, frequency) to DECIDE what to say, but do **not** print scores, numbers tables, percentiles, or section headers.

- 2–4 short sentences, ~40–80 words, plain text (an emoji or two is fine).
- Open with a quick, specific acknowledgement (e.g. "séance de muscu de 48 min, effort maîtrisé").
- Add **one** focus or encouragement grounded in the data (consistency, effort vs your norm, recovery).
- Optionally one reminder (hydration, protein/recovery, sleep, don't stack hard days).
- If there's a notable gap, nudge on it — by sport and recency only ("ça fait 6 jours sans muscu, ne perds pas ton travail"). You **cannot** reference specific muscle groups or exercises (COROS doesn't record them — never say "shoulders", "bench", etc.).
- Warm, motivating, concrete. Respond in the user's language (French by default).

Example tone: *"Belle séance de muscu, 48 min à intensité maîtrisée 💪 Tu es à 3 séances cette semaine, belle régularité — pense à bien t'hydrater et à t'accorder un jour de récup avant la prochaine grosse session. Continue !"*

## Safety

Not medical or form advice (and we can't see form anyway). Flag genuinely concerning signals from what we *can* see — e.g. avg HR far above the athlete's norm for strength, or a cluster of sessions with no recovery gap — by suggesting rest/check-in, without diagnosing. No precise calorie/macro targets. If patterns suggest overtraining or compulsion (rising frequency + shrinking recovery), prioritize recovery framing over performance.

## Pitfalls

- **No volume/exercise data, ever.** Never reference sets, reps, weights, `totalVolume`, or muscle groups — they're not in COROS strength payloads. If tempted, fall back to HR/duration/calories.
- **Max-HR estimate.** `maxHeartRate` is per-session, not the athlete's true max. Estimate true max as the highest `maxHeartRate` seen across history; if history is thin, say relative-intensity figures are provisional.
- **Calories are coarse.** COROS calorie estimates are rough; use calorie density as a *relative* density signal across the athlete's own sessions, not an absolute target.
- **Cold start.** Empty history + empty `recentActivities` → effort + recovery read only, no trend; say so.

See `references/scoring.md` for the rubric and `references/metrics.md` for formulas. The skill maintains its own history file so it works both interactively and headless under a webhook — read history, analyze, append, with no user in the loop.
