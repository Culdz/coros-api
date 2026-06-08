import { describe, expect, it, vi } from 'vitest';
import { mapSessionToMetrics } from './fit-metrics-parser';

describe('mapSessionToMetrics', () => {
  it('maps a full running session', () => {
    const metrics = mapSessionToMetrics({
      start_time: '2025-01-15T07:00:00.000Z',
      total_timer_time: 1800,
      total_distance: 5,
      avg_heart_rate: 150,
      max_heart_rate: 172,
      total_ascent: 80,
      total_calories: 320,
    });

    expect(metrics).toEqual({
      startTime: '2025-01-15T07:00:00.000Z',
      endTime: '2025-01-15T07:30:00.000Z',
      durationSec: 1800,
      distanceKm: 5,
      avgPaceSecPerKm: 360,
      avgHeartRate: 150,
      maxHeartRate: 172,
      elevationGainM: 80,
      calories: 320,
    });
  });

  it('omits missing fields (e.g. a strength session with no distance/HR)', () => {
    const metrics = mapSessionToMetrics({
      start_time: '2025-01-15T07:00:00.000Z',
      total_timer_time: 600,
      total_calories: 120,
    });

    expect(metrics).toEqual({
      startTime: '2025-01-15T07:00:00.000Z',
      endTime: '2025-01-15T07:10:00.000Z',
      durationSec: 600,
      calories: 120,
    });
    expect(metrics).not.toHaveProperty('distanceKm');
    expect(metrics).not.toHaveProperty('avgPaceSecPerKm');
  });

  it('maps a real strength session (HR range, sub_sport, temperature; no distance)', () => {
    const metrics = mapSessionToMetrics({
      sub_sport: 'strength_training',
      start_time: '2026-06-08T07:00:20.000Z',
      total_timer_time: 2893.28,
      total_calories: 277,
      max_heart_rate: 127,
      min_heart_rate: 81,
      avg_heart_rate: 98,
      avg_temperature: 27,
    });

    expect(metrics).toEqual({
      subSport: 'strength_training',
      startTime: '2026-06-08T07:00:20.000Z',
      endTime: '2026-06-08T07:48:33.000Z',
      durationSec: 2893,
      avgHeartRate: 98,
      maxHeartRate: 127,
      minHeartRate: 81,
      calories: 277,
      avgTemperature: 27,
    });
    expect(metrics).not.toHaveProperty('distanceKm');
  });

  it('returns an empty object for an empty session', () => {
    expect(mapSessionToMetrics({})).toEqual({});
  });
});

describe('FitMetricsParser.parse', () => {
  it('resolves metrics from the first session', async () => {
    vi.resetModules();
    vi.doMock('fit-file-parser', () => ({
      default: class {
        parse(_buf: unknown, cb: (e: string | null, d: unknown) => void) {
          cb(null, { sessions: [{ start_time: '2025-01-15T07:00:00.000Z', total_timer_time: 60 }] });
        }
      },
    }));
    const { FitMetricsParser } = await import('./fit-metrics-parser.js');
    const parser = new FitMetricsParser();

    const metrics = await parser.parse(Buffer.from('x'));
    expect(metrics.durationSec).toBe(60);
    vi.doUnmock('fit-file-parser');
  });

  it('rejects when the library reports an error', async () => {
    vi.resetModules();
    vi.doMock('fit-file-parser', () => ({
      default: class {
        parse(_buf: unknown, cb: (e: string | null, d: unknown) => void) {
          cb('bad fit', {});
        }
      },
    }));
    const { FitMetricsParser } = await import('./fit-metrics-parser.js');
    const parser = new FitMetricsParser();

    await expect(parser.parse(Buffer.from('x'))).rejects.toThrow('bad fit');
    vi.doUnmock('fit-file-parser');
  });
});
