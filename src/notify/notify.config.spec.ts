import { afterEach, describe, expect, it } from 'vitest';
import { NotifyConfigService } from './notify.config';

const originalEnv = { ...process.env };

describe('NotifyConfigService', () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('reads required and default values', () => {
    process.env.HERMES_WEBHOOK_URL = 'http://127.0.0.1:8644/webhooks/coros';
    delete process.env.HERMES_WEBHOOK_SECRET;
    delete process.env.INACTIVITY_THRESHOLD_HOURS;

    const config = new NotifyConfigService();

    expect(config.webhookUrl).toBe('http://127.0.0.1:8644/webhooks/coros');
    expect(config.webhookSecret).toBeUndefined();
    expect(config.inactivityThresholdHours).toBe(48);
    expect(config.recentHistoryCount).toBe(5);
    expect(config.accessTokenTtlHours).toBe(6);
    expect(config.queryWindowDays).toBe(7);
    expect(config.stateFile).toBe('./.coros-state.json');
  });

  it('reads overridden values', () => {
    process.env.HERMES_WEBHOOK_URL = 'http://h/webhooks/x';
    process.env.HERMES_WEBHOOK_SECRET = 's3cret';
    process.env.INACTIVITY_THRESHOLD_HOURS = '24';
    process.env.RECENT_HISTORY_COUNT = '3';
    process.env.COROS_STATE_FILE = '/tmp/state.json';

    const config = new NotifyConfigService();

    expect(config.webhookSecret).toBe('s3cret');
    expect(config.inactivityThresholdHours).toBe(24);
    expect(config.recentHistoryCount).toBe(3);
    expect(config.stateFile).toBe('/tmp/state.json');
  });

  it('throws when the webhook URL is missing (on first access)', () => {
    delete process.env.HERMES_WEBHOOK_URL;
    expect(() => new NotifyConfigService().webhookUrl).toThrow();
  });
});
