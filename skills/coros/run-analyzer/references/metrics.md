# Metric formulas

All paces in seconds per km unless noted. Guard against division by zero and missing splits.

## Pace / speed
- `speedKmh = 3600 / avgPaceSecPerKm`
- Display pace: `floor(s/60):round(s%60)` zero-padded → `mm:ss`.

## Pace variability (consistency)
- Across `splitsKm[].paceSecPerKm`: `CV = stddev / mean`.
- <3% very steady, 3–7% normal easy/long, >12% indicates intervals or fade.

## Aerobic decoupling (Pa:HR drift)
- Split run into first half and second half by distance.
- `ratio_h = mean_pace_half / mean_HR_half` (use speed, not pace, so higher = better: `speed/HR`).
- `decoupling% = (ratio_first - ratio_second) / ratio_first * 100`.
- <5% strong aerobic durability; 5–10% moderate; >10% fatigue/heat/underfueling signal.

## HR drift
- `mean_HR_last_third - mean_HR_first_third` at comparable pace → cardiac drift in bpm.

## Grade-adjusted pace (rough)
- Per split, adjust pace by grade using ~`+0.03%` pace cost per +1% incline, credit on descents (smaller). Only when `elevationM` per split exists. Present as approximate.

## Relative-to-history comparisons
- Filter history to same `activity.sportType` and distance within ±20%.
- Report the current metric's percentile within that filtered set (e.g. "pace-at-HR better than 70% of your comparable runs").
- Need ≥3 comparable activities to give a percentile; otherwise describe the trend qualitatively.

## Cadence
- Compare `avgCadenceSpm` to the athlete's historical mean for the same intent. Flag if notably low on easy runs (overstriding proxy).
