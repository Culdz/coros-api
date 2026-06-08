import { Injectable } from '@nestjs/common';
import FitParser from 'fit-file-parser';

export interface ActivityMetrics {
  startTime?: string;
  endTime?: string;
  durationSec?: number;
  distanceKm?: number;
  avgPaceSecPerKm?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  minHeartRate?: number;
  elevationGainM?: number;
  calories?: number;
  subSport?: string;
  avgTemperature?: number;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function mapSessionToMetrics(session: Record<string, unknown>): ActivityMetrics {
  const metrics: ActivityMetrics = {};

  const startMs = session.start_time ? new Date(session.start_time as string).getTime() : undefined;
  if (startMs !== undefined && Number.isFinite(startMs)) {
    metrics.startTime = new Date(startMs).toISOString();
  }

  const durationSec = asNumber(session.total_timer_time) ?? asNumber(session.total_elapsed_time);
  if (durationSec !== undefined) {
    metrics.durationSec = Math.round(durationSec);
  }

  if (metrics.startTime && metrics.durationSec !== undefined) {
    metrics.endTime = new Date(new Date(metrics.startTime).getTime() + metrics.durationSec * 1000).toISOString();
  }

  const distanceKm = asNumber(session.total_distance);
  if (distanceKm !== undefined) {
    metrics.distanceKm = Math.round(distanceKm * 100) / 100;
  }

  if (metrics.distanceKm && metrics.distanceKm > 0 && metrics.durationSec !== undefined) {
    metrics.avgPaceSecPerKm = Math.round(metrics.durationSec / metrics.distanceKm);
  }

  const avgHr = asNumber(session.avg_heart_rate);
  if (avgHr !== undefined) {
    metrics.avgHeartRate = avgHr;
  }

  const maxHr = asNumber(session.max_heart_rate);
  if (maxHr !== undefined) {
    metrics.maxHeartRate = maxHr;
  }

  const minHr = asNumber(session.min_heart_rate);
  if (minHr !== undefined) {
    metrics.minHeartRate = minHr;
  }

  const ascent = asNumber(session.total_ascent);
  if (ascent !== undefined) {
    metrics.elevationGainM = ascent;
  }

  const calories = asNumber(session.total_calories);
  if (calories !== undefined) {
    metrics.calories = calories;
  }

  if (typeof session.sub_sport === 'string') {
    metrics.subSport = session.sub_sport;
  }

  const temperature = asNumber(session.avg_temperature);
  if (temperature !== undefined) {
    metrics.avgTemperature = temperature;
  }

  return metrics;
}

@Injectable()
export class FitMetricsParser {
  parse(buffer: Buffer): Promise<ActivityMetrics> {
    return new Promise((resolve, reject) => {
      const parser = new FitParser({
        force: true,
        speedUnit: 'km/h',
        lengthUnit: 'km',
        temperatureUnit: 'celsius',
        elapsedRecordField: true,
        mode: 'list',
      });

      parser.parse(buffer, (error, data) => {
        if (error) {
          reject(new Error(error));
          return;
        }
        const session = data?.sessions?.[0];
        resolve(session ? mapSessionToMetrics(session) : {});
      });
    });
  }
}
