# Metric formulas (strength / session-level)

Only heart rate, duration, and calories are available — no volume/reps/weight. Guard against division by zero and missing fields. Every metric is relative to the athlete's own history, never to other people.

## Duration
- `durationMin = durationSec / 60`. Display as `h:mm:ss`.

## Relative intensity (the core effort signal)
- `maxHrEst` = the highest `maxHeartRate` across the athlete's history (fallback: this session's `maxHeartRate`). This approximates the athlete's true max; flag as provisional if history < ~5 sessions.
- `relIntensityPct = avgHeartRate / maxHrEst * 100`.
  - Rough reads for strength: <60% light/technique, 60–72% moderate, 72–82% hard/dense circuit, >82% very high (unusual for pure strength — likely a metcon/cardio-strength mix).
- `hrRange = maxHeartRate − minHeartRate` (only if `minHeartRate` present). Wide range = mixed effort (work/rest spikes); narrow high range = sustained circuit.

## Calorie density
- `kcalPerMin = calories / durationMin`.
- Interpret only *relative to the athlete's own sessions*: above their median → denser/harder session; below → lighter or more rest between efforts. COROS calorie estimates are coarse; never present as absolute.

## Training frequency
- From history (+ `recentActivities`), count strength sessions with `startTime` within the trailing 7 and 28 days.
- `freq7`, `freq28`. Typical sustainable strength frequency is ~2–4×/week; flag sustained >5/week or long gaps.

## Recovery gap
- `restDays = (current.startTime − previous_strength.startTime) / 86400`, using the most recent prior strength session.
- <1 day = back-to-back (note if both were hard by relative intensity); 1–3 typical; >7 = returning after a break.

## Trend vs history (same sportType)
- Filter history to the same `sportType`. Need ≥3 to give a percentile; otherwise describe qualitatively.
- Compare current `avgHeartRate`, `relIntensityPct`, `durationMin`, `kcalPerMin` to the mean (or percentile) of that filtered set.
- Report e.g. "avg HR 98 is right at your strength-session norm; duration 48 min is ~10% above your median".
