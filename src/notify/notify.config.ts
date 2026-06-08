import 'dotenv/config';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

const NotifyConfig = z.object({
  webhookUrl: z.string(),
  // Optional per-sport routes. When set, strength goes to one Hermes route (pinned to the
  // workout-analyzer skill) and endurance to another (run-analyzer) — so the agent never has
  // to choose a skill. If unset, everything falls back to webhookUrl (single-route mode).
  strengthWebhookUrl: z.string().optional(),
  enduranceWebhookUrl: z.string().optional(),
  webhookSecret: z.string().optional(),
  stateFile: z.string().default('./.coros-state.json'),
  inactivityThresholdHours: z.preprocess((v) => (v === undefined ? undefined : Number(v)), z.number().default(48)),
  recentHistoryCount: z.preprocess((v) => (v === undefined ? undefined : Number(v)), z.number().default(5)),
  accessTokenTtlHours: z.preprocess((v) => (v === undefined ? undefined : Number(v)), z.number().default(6)),
  queryWindowDays: z.preprocess((v) => (v === undefined ? undefined : Number(v)), z.number().default(7)),
});
type NotifyConfig = z.infer<typeof NotifyConfig>;

@Injectable()
export class NotifyConfigService {
  private parsed: NotifyConfig | undefined;

  // Validated lazily on first access rather than in the constructor: AppModule eagerly
  // instantiates every provider, so validating here would force unrelated commands
  // (e.g. export-activities) to require the Hermes env vars. Only the notify-activities
  // command reads these getters, so only it triggers validation.
  private get config(): NotifyConfig {
    if (!this.parsed) {
      this.parsed = NotifyConfig.parse({
        webhookUrl: process.env.HERMES_WEBHOOK_URL,
        strengthWebhookUrl: process.env.HERMES_WEBHOOK_STRENGTH_URL,
        enduranceWebhookUrl: process.env.HERMES_WEBHOOK_ENDURANCE_URL,
        webhookSecret: process.env.HERMES_WEBHOOK_SECRET,
        stateFile: process.env.COROS_STATE_FILE,
        inactivityThresholdHours: process.env.INACTIVITY_THRESHOLD_HOURS,
        recentHistoryCount: process.env.RECENT_HISTORY_COUNT,
        accessTokenTtlHours: process.env.ACCESS_TOKEN_TTL_HOURS,
        queryWindowDays: process.env.QUERY_WINDOW_DAYS,
      });
    }
    return this.parsed;
  }

  get webhookUrl() {
    return this.config.webhookUrl;
  }

  // The Hermes route URL for a sport category, falling back to webhookUrl when no
  // per-sport route is configured (single-route mode).
  webhookUrlForCategory(category: 'strength' | 'endurance'): string {
    if (category === 'strength' && this.config.strengthWebhookUrl) {
      return this.config.strengthWebhookUrl;
    }
    if (category === 'endurance' && this.config.enduranceWebhookUrl) {
      return this.config.enduranceWebhookUrl;
    }
    return this.config.webhookUrl;
  }

  get webhookSecret() {
    return this.config.webhookSecret;
  }

  get stateFile() {
    return this.config.stateFile;
  }

  get inactivityThresholdHours() {
    return this.config.inactivityThresholdHours;
  }

  get recentHistoryCount() {
    return this.config.recentHistoryCount;
  }

  get accessTokenTtlHours() {
    return this.config.accessTokenTtlHours;
  }

  get queryWindowDays() {
    return this.config.queryWindowDays;
  }
}
