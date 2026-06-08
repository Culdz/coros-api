# Scoring rubric (0–100)

The score measures **how well the session was executed for its intended purpose**, not how fast it was. A perfectly paced recovery jog can score 90+; a ragged interval session can score low even if fast.

## Step 1 — Infer session intent
From the data, classify the session before scoring:
- **Easy / recovery**: HR mostly in low zones, steady pace, low variability.
- **Long run**: distance well above the athlete's median, moderate HR.
- **Tempo / threshold**: sustained elevated HR, low pace variability.
- **Intervals**: high pace variability with structured peaks/valleys in `splitsKm`.
- **Race**: `rpe` high and/or pace near the athlete's best for the distance.

If intent is ambiguous, say which you assumed.

## Step 2 — Component scores

| Component | Weight | What earns points |
|---|---|---|
| Pacing execution | 30 | Pace consistency *appropriate to intent* (low CV for steady runs; clean repeatable splits for intervals) |
| Aerobic decoupling | 25 | Small pace:HR drift first-half vs second-half (<5% excellent, >10% weak) |
| Effort appropriateness | 20 | HR/RPE matches the intent (easy run stayed easy; tempo held threshold) |
| Relative performance | 15 | Pace-at-HR vs the athlete's own history for this type/distance |
| Durability | 10 | Held form late (cadence, pace) — especially on long runs / final splits |

Missing data → redistribute that component's weight proportionally across the rest and note it.

## Step 3 — Banding
- 90–100 excellent execution
- 75–89 solid, minor gaps
- 60–74 decent with a clear weak spot
- <60 notable execution issue (state which)

Always give one sentence explaining the dominant factor behind the number. Never present the score as precise to the point — it's a coarse read.
