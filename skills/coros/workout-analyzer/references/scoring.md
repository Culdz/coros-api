# Scoring rubric (0–100, strength / session-level)

The score measures **how appropriate and sustainable the session was** — effort, consistency, recovery — given that we only have heart rate, duration, and calories. It does **not** measure volume, load, or technique (that data doesn't exist in COROS strength exports). Always say what the number reflects and that it's a coarse, HR-based read.

## Step 1 — Infer session intent (from HR + duration only)
- **Light / technique / deload**: low relative intensity (<60% est. max HR), short-to-moderate duration.
- **Standard strength**: moderate avg HR (60–72%), with a wide HR range (spikes during sets, recovery between) if `minHeartRate` is present.
- **Dense circuit / strength-cardio**: sustained high avg HR (>72%), high calorie density.
- **Returning after a break**: large recovery gap in history.

With only session HR this is approximate — state which intent you assumed.

## Step 2 — Component scores

| Component | Weight | What earns points |
|---|---|---|
| Effort appropriateness | 30 | Avg HR / relative intensity consistent with the inferred intent (a technique day stayed light; a circuit actually elevated HR). Not "junk" middling effort with no clear purpose. |
| Consistency / frequency | 25 | Strength trained on a productive cadence vs history (`freq7`/`freq28` in a sustainable band, not sporadic). |
| Recovery | 20 | Adequate `restDays` before this session for its intensity — hard sessions not stacked back-to-back. |
| Duration | 15 | Session length in a productive range for the intent (not so short it's trivial, not bloated with idle time). |
| Trend / progression | 10 | Effort/duration/frequency trending coherently with the athlete's recent pattern (gentle progression, not erratic spikes). |

Missing data (e.g. no `minHeartRate`, thin history) → redistribute that component's weight proportionally across the rest and note it.

## Step 3 — Banding
- 90–100 well-judged, sustainable session
- 75–89 solid, minor gap (e.g. slightly short recovery)
- 60–74 decent but a clear issue (e.g. third hard day in a row)
- <60 notable issue (state which — usually recovery or unclear effort)

Give one sentence on the dominant factor behind the number. Never present the score as precise — with only HR/duration/calories it's a directional read of effort and recovery, not a verdict on the training itself.
