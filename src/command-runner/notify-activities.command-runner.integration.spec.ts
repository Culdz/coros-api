import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Test } from '@nestjs/testing';
import { HttpResponse, http } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { NotifierState } from '../notify/activity-state-store';
import { Clock } from '../notify/clock';
import { FitMetricsParser } from '../notify/fit-metrics-parser';
import { buildDownloadActivityDetailResponse } from '../testing/fixtures/download-activity';
import { buildLoginResponse } from '../testing/fixtures/login';
import { buildActivity, buildQueryActivitiesResponse } from '../testing/fixtures/query-activities';
import { COROS_API_BASE_URL, server } from '../testing/msw-server';
import { NotifyActivitiesCommandRunner } from './notify-activities.command-runner';

const HERMES_WEBHOOK = 'http://hermes.test/webhooks/coros';
const FIT_BYTES = 'fake-fit-bytes';
const NOW = new Date('2025-01-16T08:00:00.000Z');

const FAKE_METRICS = {
  startTime: '2025-01-16T07:00:00.000Z',
  endTime: '2025-01-16T07:30:00.000Z',
  durationSec: 1800,
  distanceKm: 5,
  avgPaceSecPerKm: 360,
  avgHeartRate: 150,
};

type HermesCall = { event: string; body: Record<string, unknown> };

describe('notify-activities', () => {
  let stateFile: string;
  let dir: string;
  const originalEnv = { ...process.env };
  let hermesCalls: HermesCall[];
  let loginCount: number;

  beforeAll(() => {
    process.env.COROS_API_URL = COROS_API_BASE_URL;
    process.env.COROS_EMAIL = 'test@example.com';
    process.env.COROS_PASSWORD = 'testpassword';
    process.env.HERMES_WEBHOOK_URL = HERMES_WEBHOOK;
    delete process.env.HERMES_WEBHOOK_SECRET;
    server.listen({ onUnhandledRequest: 'error' });
  });

  afterAll(() => {
    server.close();
    process.env = originalEnv;
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'coros-notify-'));
    stateFile = path.join(dir, 'state.json');
    process.env.COROS_STATE_FILE = stateFile;
    hermesCalls = [];
    loginCount = 0;
  });

  afterEach(async () => {
    server.resetHandlers();
    await rm(dir, { recursive: true, force: true });
  });

  function baseHandlers(activities = [buildActivity()]) {
    return [
      http.post(`${COROS_API_BASE_URL}/account/login`, () => {
        loginCount += 1;
        return HttpResponse.json(buildLoginResponse());
      }),
      http.get(`${COROS_API_BASE_URL}/activity/query`, () =>
        HttpResponse.json(buildQueryActivitiesResponse({ activities })),
      ),
      http.post(`${COROS_API_BASE_URL}/activity/detail/download`, ({ request }) => {
        const labelId = new URL(request.url).searchParams.get('labelId');
        return HttpResponse.json(buildDownloadActivityDetailResponse(`${COROS_API_BASE_URL}/files/${labelId}.fit`));
      }),
      http.get(
        `${COROS_API_BASE_URL}/files/*`,
        () => new HttpResponse(FIT_BYTES, { headers: { 'Content-Type': 'application/octet-stream' } }),
      ),
      http.post(HERMES_WEBHOOK, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        hermesCalls.push({ event: body.event as string, body });
        return HttpResponse.json({ ok: true });
      }),
    ];
  }

  async function runCommand(now = NOW) {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Clock)
      .useValue({ now: () => now })
      .overrideProvider(FitMetricsParser)
      .useValue({ parse: async () => ({ ...FAKE_METRICS }) })
      .compile();
    const runner = moduleRef.get(NotifyActivitiesCommandRunner);
    await runner.run([], {} as never);
    await moduleRef.close();
  }

  async function readState(): Promise<NotifierState> {
    return NotifierState.parse(JSON.parse(await readFile(stateFile, 'utf-8')));
  }

  it('first run seeds state and sends no notifications', async () => {
    server.use(...baseHandlers([buildActivity({ labelId: 'a1', date: 20250115 })]));

    await runCommand();

    expect(hermesCalls).toHaveLength(0);
    const state = await readState();
    expect(state.seenLabelIds).toEqual(['a1']);
    expect(state.lastActivityLabelId).toBe('a1');
    // History is backfilled at bootstrap (enriched, no notification) so the first real
    // activity already carries context.
    expect(state.recentActivities).toHaveLength(1);
    expect((state.recentActivities[0] as { labelId: string }).labelId).toBe('a1');
  });

  it('notifies for a new activity on a subsequent run', async () => {
    server.use(...baseHandlers([buildActivity({ labelId: 'a1', date: 20250115 })]));
    await runCommand();
    expect(hermesCalls).toHaveLength(0);

    server.resetHandlers();
    server.use(
      ...baseHandlers([
        buildActivity({ labelId: 'a1', date: 20250115 }),
        buildActivity({ labelId: 'a2', date: 20250116, name: 'Lunch Run' }),
      ]),
    );

    await runCommand();

    const newActivityCalls = hermesCalls.filter((c) => c.event === 'new_activity');
    expect(newActivityCalls).toHaveLength(1);
    expect(newActivityCalls[0].body.event_type).toBe('activity');
    const activity = newActivityCalls[0].body.activity as Record<string, unknown>;
    expect(activity.labelId).toBe('a2');
    expect(activity.name).toBe('Lunch Run');
    expect(activity.sportType).toBe('run');
    expect(activity.distanceKm).toBe(5);

    const state = await readState();
    expect(state.seenLabelIds).toContain('a2');
  });

  it('does not re-notify for an already-seen activity (dedupe)', async () => {
    server.use(...baseHandlers([buildActivity({ labelId: 'a1', date: 20250115 })]));
    await runCommand();
    server.resetHandlers();
    server.use(
      ...baseHandlers([
        buildActivity({ labelId: 'a1', date: 20250115 }),
        buildActivity({ labelId: 'a2', date: 20250116 }),
      ]),
    );
    await runCommand();
    server.resetHandlers();
    server.use(
      ...baseHandlers([
        buildActivity({ labelId: 'a1', date: 20250115 }),
        buildActivity({ labelId: 'a2', date: 20250116 }),
      ]),
    );

    // Capture the call count before run 3; run 3 must not add any new_activity events.
    const countBeforeRun3 = hermesCalls.filter((c) => c.event === 'new_activity').length;

    await runCommand();

    expect(hermesCalls.filter((c) => c.event === 'new_activity')).toHaveLength(countBeforeRun3);
  });

  it('leaves an activity unseen when the Hermes POST fails, so it retries next run', async () => {
    server.use(...baseHandlers([buildActivity({ labelId: 'a1', date: 20250115 })]));
    await runCommand();

    server.resetHandlers();
    server.use(
      http.post(`${COROS_API_BASE_URL}/account/login`, () => HttpResponse.json(buildLoginResponse())),
      http.get(`${COROS_API_BASE_URL}/activity/query`, () =>
        HttpResponse.json(
          buildQueryActivitiesResponse({
            activities: [
              buildActivity({ labelId: 'a1', date: 20250115 }),
              buildActivity({ labelId: 'a2', date: 20250116 }),
            ],
          }),
        ),
      ),
      http.post(`${COROS_API_BASE_URL}/activity/detail/download`, ({ request }) => {
        const labelId = new URL(request.url).searchParams.get('labelId');
        return HttpResponse.json(buildDownloadActivityDetailResponse(`${COROS_API_BASE_URL}/files/${labelId}.fit`));
      }),
      http.get(`${COROS_API_BASE_URL}/files/*`, () => new HttpResponse(FIT_BYTES)),
      http.post(HERMES_WEBHOOK, () => new HttpResponse(null, { status: 500 })),
    );

    await runCommand();

    const state = await readState();
    expect(state.seenLabelIds).not.toContain('a2');
  });

  it('sends an inactive nudge when past the threshold', async () => {
    server.use(...baseHandlers([buildActivity({ labelId: 'a1', date: 20250101 })]));
    await runCommand(new Date('2025-01-01T08:00:00.000Z'));

    server.resetHandlers();
    server.use(...baseHandlers([buildActivity({ labelId: 'a1', date: 20250101 })]));

    await runCommand(new Date('2025-01-10T08:00:00.000Z'));

    const inactiveCalls = hermesCalls.filter((c) => c.event === 'inactive');
    expect(inactiveCalls).toHaveLength(1);
    expect(inactiveCalls[0].body.event_type).toBe('activity');
    const inactivity = inactiveCalls[0].body.inactivity as Record<string, unknown>;
    expect(inactivity.hoursSinceLastActivity as number).toBeGreaterThanOrEqual(48);
  });

  it('reuses a cached token without logging in again', async () => {
    server.use(...baseHandlers([buildActivity({ labelId: 'a1', date: 20250115 })]));
    await runCommand();
    expect(loginCount).toBe(1);

    server.resetHandlers();
    server.use(...baseHandlers([buildActivity({ labelId: 'a1', date: 20250115 })]));

    await runCommand();

    // loginCount is reset only in beforeEach, not between these two runs in the same test.
    // After the first run it is 1; the second run must reuse the cached token (no new login),
    // so it stays at 1.
    expect(loginCount).toBe(1);
  });

  it('re-logs in when COROS rejects the cached token (result 1019)', async () => {
    // Seed a fresh-but-invalid cached token so ensureAuth reuses it (no initial login).
    await writeFile(
      stateFile,
      JSON.stringify({
        version: 1,
        seenLabelIds: [],
        lastActivityEndTime: null,
        lastActivityLabelId: null,
        accessToken: 'stale-token',
        accessTokenIssuedAt: NOW.toISOString(),
        recentActivities: [],
      }),
    );

    let queryCount = 0;
    server.use(
      http.post(`${COROS_API_BASE_URL}/account/login`, () => {
        loginCount += 1;
        return HttpResponse.json(buildLoginResponse());
      }),
      http.get(`${COROS_API_BASE_URL}/activity/query`, () => {
        queryCount += 1;
        if (queryCount === 1) {
          // COROS signals an invalid token with HTTP 200 + result 1019 (no apiCode).
          return HttpResponse.json({ result: '1019', message: 'Access token is invalid', tlogId: 'x' });
        }
        return HttpResponse.json(buildQueryActivitiesResponse({ activities: [buildActivity({ labelId: 'a1' })] }));
      }),
      http.post(`${COROS_API_BASE_URL}/activity/detail/download`, ({ request }) => {
        const labelId = new URL(request.url).searchParams.get('labelId');
        return HttpResponse.json(buildDownloadActivityDetailResponse(`${COROS_API_BASE_URL}/files/${labelId}.fit`));
      }),
      http.get(`${COROS_API_BASE_URL}/files/*`, () => new HttpResponse('fake-fit')),
      http.post(HERMES_WEBHOOK, () => HttpResponse.json({ ok: true })),
    );

    await runCommand();

    // The cached token was reused, rejected (1019), then a single re-login recovered it.
    expect(loginCount).toBe(1);
    const state = await readState();
    expect(state.seenLabelIds).toEqual(['a1']);
  });
});
