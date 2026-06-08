import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import dayjs from 'dayjs';
import type { Activity } from '../coros/activity/query-activities.request';
import { CorosAPI } from '../coros/coros-api';
import { CorosAuthenticationService } from '../coros/coros-authentication.service';
import { getSportTypeKeyFromValue } from '../coros/sport-type';
import { ActivityStateStore, type NotifierState } from './activity-state-store';
import { Clock } from './clock';
import { type ActivityMetrics, FitMetricsParser } from './fit-metrics-parser';
import { HermesNotifier } from './hermes-notifier';
import { NotifyConfigService } from './notify.config';

const FIT_FILE_TYPE = '4';
const ALL_SPORT_TYPES = '0';
const MS_PER_HOUR = 1000 * 60 * 60;
// Hermes routes payloads by the top-level `event_type` field (matched against the route's
// `events` list). `event` below is our own sub-type so the agent can distinguish them.
const WEBHOOK_EVENT_TYPE = 'activity';
// Sport keys that belong to the strength skill; everything else is treated as endurance.
const STRENGTH_SPORTS = new Set(['strength', 'gymCardio', 'gpsCardio']);

// COROS activity dates are bare YYYYMMDD numbers with no time/zone. Anchor them at UTC
// midnight so the inactivity threshold is independent of the host's timezone.
function yyyymmddToUtcIso(date: number): string {
  const s = String(date);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00.000Z`;
}

export type ActivityPayload = ActivityMetrics & {
  labelId: string;
  name: string;
  sportType: string;
};

@Injectable()
export class ActivityWatcher {
  private readonly logger = new Logger(ActivityWatcher.name);
  private readonly coros: CorosAPI;
  private readonly auth: CorosAuthenticationService;
  private readonly config: NotifyConfigService;
  private readonly store: ActivityStateStore;
  private readonly fitParser: FitMetricsParser;
  private readonly notifier: HermesNotifier;
  private readonly httpService: HttpService;
  private readonly clock: Clock;

  constructor(
    coros: CorosAPI,
    auth: CorosAuthenticationService,
    config: NotifyConfigService,
    store: ActivityStateStore,
    fitParser: FitMetricsParser,
    notifier: HermesNotifier,
    httpService: HttpService,
    clock: Clock,
  ) {
    this.coros = coros;
    this.auth = auth;
    this.config = config;
    this.store = store;
    this.fitParser = fitParser;
    this.notifier = notifier;
    this.httpService = httpService;
    this.clock = clock;
  }

  async run(): Promise<void> {
    const state = await this.store.load();
    await this.ensureAuth(state);

    const activities = await this.queryRecentWithAuthRetry(state);

    if (state.seenLabelIds.length === 0) {
      await this.bootstrap(state, activities);
      await this.checkInactivity(state);
      await this.store.save(state);
      return;
    }

    const newActivities = activities
      .filter((activity) => !state.seenLabelIds.includes(activity.labelId))
      .sort((a, b) => a.date - b.date);

    if (newActivities.length > 0) {
      this.logger.log(`Found ${newActivities.length} new activity(ies)`);
    }

    for (const activity of newActivities) {
      await this.processNewActivity(state, activity);
    }

    await this.checkInactivity(state);
    await this.store.save(state);
  }

  /**
   * One-time seed: enrich the last `days` of activities and send them to Hermes as two
   * `history_backfill` batches (strength → workout-analyzer, endurance → run-analyzer) so the
   * skills' history is populated immediately. Does not change the new-activity dedup state.
   */
  async backfill(days: number): Promise<void> {
    const state = await this.store.load();
    await this.ensureAuth(state);

    const from = dayjs(this.clock.now()).subtract(days, 'day').toDate();
    const activities = await this.queryFromWithAuthRetry(state, from);
    this.logger.log(`Backfill: enriching ${activities.length} activity(ies) from the last ${days} days`);

    const enriched: ActivityPayload[] = [];
    for (const activity of [...activities].sort((a, b) => b.date - a.date)) {
      try {
        enriched.push(await this.enrich(activity));
      } catch (error) {
        this.logger.warn(`Backfill enrich failed for ${activity.labelId}: ${error}`);
      }
    }

    const strength = enriched.filter((p) => STRENGTH_SPORTS.has(p.sportType));
    const endurance = enriched.filter((p) => !STRENGTH_SPORTS.has(p.sportType));

    if (strength.length > 0) {
      await this.sendBackfill('strength', strength);
    }
    if (endurance.length > 0) {
      await this.sendBackfill('endurance', endurance);
    }

    await this.store.save(state);
    this.logger.log(`Backfill sent: ${strength.length} strength, ${endurance.length} endurance`);
  }

  private categoryFor(sportType: string): 'strength' | 'endurance' {
    return STRENGTH_SPORTS.has(sportType) ? 'strength' : 'endurance';
  }

  private async sendBackfill(sportCategory: 'strength' | 'endurance', activities: ActivityPayload[]): Promise<void> {
    const ok = await this.notifier.notify(
      {
        event_type: WEBHOOK_EVENT_TYPE,
        event: 'history_backfill',
        source: 'coros',
        sportCategory,
        activities,
      },
      this.config.webhookUrlForCategory(sportCategory),
    );
    if (!ok) {
      this.logger.warn(`Backfill batch '${sportCategory}' (${activities.length}) failed to deliver`);
    }
  }

  private async ensureAuth(state: NotifierState): Promise<void> {
    if (state.accessToken && state.accessTokenIssuedAt) {
      const ageHours = (this.clock.now().getTime() - new Date(state.accessTokenIssuedAt).getTime()) / MS_PER_HOUR;
      if (ageHours < this.config.accessTokenTtlHours) {
        this.auth.accessToken = state.accessToken;
        return;
      }
    }
    await this.login(state);
  }

  private async login(state: NotifierState): Promise<void> {
    await this.coros.login();
    state.accessToken = this.auth.accessToken;
    state.accessTokenIssuedAt = this.clock.now().toISOString();
  }

  private async queryRecentWithAuthRetry(state: NotifierState): Promise<Activity[]> {
    const from = dayjs(this.clock.now()).subtract(this.config.queryWindowDays, 'day').toDate();
    return this.queryFromWithAuthRetry(state, from);
  }

  // Query activities since `from`, re-logging in once if the (possibly cached) token is rejected.
  private async queryFromWithAuthRetry(state: NotifierState, from: Date): Promise<Activity[]> {
    try {
      return (await this.coros.queryActivities({ from, sportTypes: [ALL_SPORT_TYPES] })).activities;
    } catch (error) {
      if (this.isAuthError(error)) {
        this.logger.warn('Query failed with an auth error; re-logging in and retrying');
        await this.login(state);
        return (await this.coros.queryActivities({ from, sportTypes: [ALL_SPORT_TYPES] })).activities;
      }
      throw error;
    }
  }

  private async bootstrap(state: NotifierState, activities: Activity[]): Promise<void> {
    state.seenLabelIds = activities.map((activity) => activity.labelId);
    if (activities.length > 0) {
      const mostRecent = activities.reduce((a, b) => (a.date >= b.date ? a : b));
      state.lastActivityEndTime = yyyymmddToUtcIso(mostRecent.date);
      state.lastActivityLabelId = mostRecent.labelId;

      // Backfill recent history (enriched, newest-first) so the FIRST real notification
      // already carries context for the agent — without sending anything now.
      const recent = [...activities].sort((a, b) => b.date - a.date).slice(0, this.config.recentHistoryCount);
      const payloads: ActivityPayload[] = [];
      for (const activity of recent) {
        try {
          payloads.push(await this.enrich(activity));
        } catch (error) {
          this.logger.warn(`Bootstrap enrich failed for ${activity.labelId}: ${error}`);
        }
      }
      state.recentActivities = payloads;
    }
    this.logger.log(
      `Bootstrap: seeded ${state.seenLabelIds.length} activity(ies); backfilled ${state.recentActivities.length} for history; no notifications sent`,
    );
  }

  private async enrich(activity: Activity): Promise<ActivityPayload> {
    const { fileUrl } = await this.coros.downloadActivityDetail({
      labelId: activity.labelId,
      sportType: activity.sportType,
      fileType: FIT_FILE_TYPE,
    });
    const buffer = await this.fetchFitFile(fileUrl);
    const metrics = await this.fitParser.parse(buffer);
    return this.buildActivityPayload(activity, metrics);
  }

  private async processNewActivity(state: NotifierState, activity: Activity): Promise<void> {
    try {
      const payload = await this.enrich(activity);

      const ok = await this.notifier.notify(
        {
          event_type: WEBHOOK_EVENT_TYPE,
          event: 'new_activity',
          source: 'coros',
          activity: payload,
          recentActivities: state.recentActivities,
        },
        this.config.webhookUrlForCategory(this.categoryFor(payload.sportType)),
      );

      if (!ok) {
        this.logger.warn(`Hermes notify failed for ${activity.labelId}; leaving unseen to retry next run`);
        return;
      }

      state.seenLabelIds.push(activity.labelId);
      state.recentActivities = [payload, ...state.recentActivities].slice(0, this.config.recentHistoryCount);

      const endTime = payload.endTime ?? yyyymmddToUtcIso(activity.date);
      if (!state.lastActivityEndTime || endTime > state.lastActivityEndTime) {
        state.lastActivityEndTime = endTime;
        state.lastActivityLabelId = activity.labelId;
      }
    } catch (error) {
      this.logger.error(`Failed to process activity ${activity.labelId}: ${error}`);
    }
  }

  private async fetchFitFile(url: string): Promise<Buffer> {
    const { data } = await this.httpService.axiosRef.get(url, { responseType: 'arraybuffer' });
    return Buffer.from(data);
  }

  private buildActivityPayload(activity: Activity, metrics: ActivityMetrics): ActivityPayload {
    const sportType = getSportTypeKeyFromValue(String(activity.sportType)) ?? String(activity.sportType);
    return {
      labelId: activity.labelId,
      name: activity.name?.trim() || 'Activity',
      sportType,
      ...metrics,
    };
  }

  private async checkInactivity(state: NotifierState): Promise<void> {
    if (!state.lastActivityEndTime) {
      return;
    }
    const hours = (this.clock.now().getTime() - new Date(state.lastActivityEndTime).getTime()) / MS_PER_HOUR;
    if (hours <= this.config.inactivityThresholdHours) {
      return;
    }

    // Route the nudge to the coach for the most recent activity's sport (default endurance).
    const last = state.recentActivities[0] as { sportType?: string } | undefined;
    const category = last?.sportType ? this.categoryFor(last.sportType) : 'endurance';

    await this.notifier.notify(
      {
        event_type: WEBHOOK_EVENT_TYPE,
        event: 'inactive',
        source: 'coros',
        inactivity: {
          hoursSinceLastActivity: Math.floor(hours),
          lastActivity: state.recentActivities[0] ?? { labelId: state.lastActivityLabelId },
        },
      },
      this.config.webhookUrlForCategory(category),
    );
  }

  private isAuthError(error: unknown): boolean {
    // HTTP 401 (rare for COROS) ...
    if (
      typeof error === 'object' &&
      error !== null &&
      'response' in error &&
      (error as { response?: { status?: number } }).response?.status === 401
    ) {
      return true;
    }
    // ... or COROS's own signal: HTTP 200 with result "1019" "Access token is invalid",
    // which base-request throws as an Error carrying `cause.result`.
    return error instanceof Error && (error.cause as { result?: string } | undefined)?.result === '1019';
  }
}
