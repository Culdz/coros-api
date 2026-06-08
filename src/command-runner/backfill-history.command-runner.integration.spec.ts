import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Test } from '@nestjs/testing';
import { HttpResponse, http } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { Clock } from '../notify/clock';
import { FitMetricsParser } from '../notify/fit-metrics-parser';
import { buildDownloadActivityDetailResponse } from '../testing/fixtures/download-activity';
import { buildLoginResponse } from '../testing/fixtures/login';
import { buildActivity, buildQueryActivitiesResponse } from '../testing/fixtures/query-activities';
import { COROS_API_BASE_URL, server } from '../testing/msw-server';
import { BackfillHistoryCommandRunner } from './backfill-history.command-runner';

const HERMES_WEBHOOK = 'http://hermes.test/webhooks/coros';
const NOW = new Date('2025-01-20T08:00:00.000Z');
const FAKE_METRICS = { durationSec: 1800, avgHeartRate: 120 };

type HermesCall = { sportCategory: string; activities: Array<{ labelId: string; sportType: string }> };

describe('backfill-history', () => {
  let dir: string;
  const originalEnv = { ...process.env };
  let calls: HermesCall[];

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
    dir = await mkdtemp(path.join(tmpdir(), 'coros-backfill-'));
    process.env.COROS_STATE_FILE = path.join(dir, 'state.json');
    calls = [];
  });

  afterEach(async () => {
    server.resetHandlers();
    await rm(dir, { recursive: true, force: true });
  });

  async function run(days = 30) {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Clock)
      .useValue({ now: () => NOW })
      .overrideProvider(FitMetricsParser)
      .useValue({ parse: async () => ({ ...FAKE_METRICS }) })
      .compile();
    await moduleRef.get(BackfillHistoryCommandRunner).run([], { days } as never);
    await moduleRef.close();
  }

  it('sends one strength batch and one endurance batch, split by sportType', async () => {
    server.use(
      http.post(`${COROS_API_BASE_URL}/account/login`, () => HttpResponse.json(buildLoginResponse())),
      http.get(`${COROS_API_BASE_URL}/activity/query`, () =>
        HttpResponse.json(
          buildQueryActivitiesResponse({
            activities: [
              buildActivity({ labelId: 'run-1', date: 20250118, sportType: 100, name: 'Morning Run' }),
              buildActivity({ labelId: 'str-1', date: 20250119, sportType: 402, name: 'Strength' }),
            ],
          }),
        ),
      ),
      http.post(`${COROS_API_BASE_URL}/activity/detail/download`, ({ request }) => {
        const labelId = new URL(request.url).searchParams.get('labelId');
        return HttpResponse.json(buildDownloadActivityDetailResponse(`${COROS_API_BASE_URL}/files/${labelId}.fit`));
      }),
      http.get(`${COROS_API_BASE_URL}/files/*`, () => new HttpResponse('fake-fit')),
      http.post(HERMES_WEBHOOK, async ({ request }) => {
        const body = (await request.json()) as {
          event: string;
          sportCategory: string;
          activities: HermesCall['activities'];
        };
        expect(body.event).toBe('history_backfill');
        calls.push({ sportCategory: body.sportCategory, activities: body.activities });
        return HttpResponse.json({ ok: true });
      }),
    );

    await run(30);

    expect(calls).toHaveLength(2);
    const strength = calls.find((c) => c.sportCategory === 'strength');
    const endurance = calls.find((c) => c.sportCategory === 'endurance');
    expect(strength?.activities.map((a) => a.labelId)).toEqual(['str-1']);
    expect(endurance?.activities.map((a) => a.labelId)).toEqual(['run-1']);
    expect(strength?.activities[0].sportType).toBe('strength');
    expect(endurance?.activities[0].sportType).toBe('run');
  });

  it('sends only the endurance batch when there are no strength activities', async () => {
    server.use(
      http.post(`${COROS_API_BASE_URL}/account/login`, () => HttpResponse.json(buildLoginResponse())),
      http.get(`${COROS_API_BASE_URL}/activity/query`, () =>
        HttpResponse.json(
          buildQueryActivitiesResponse({ activities: [buildActivity({ labelId: 'run-1', sportType: 100 })] }),
        ),
      ),
      http.post(`${COROS_API_BASE_URL}/activity/detail/download`, ({ request }) => {
        const labelId = new URL(request.url).searchParams.get('labelId');
        return HttpResponse.json(buildDownloadActivityDetailResponse(`${COROS_API_BASE_URL}/files/${labelId}.fit`));
      }),
      http.get(`${COROS_API_BASE_URL}/files/*`, () => new HttpResponse('fake-fit')),
      http.post(HERMES_WEBHOOK, async ({ request }) => {
        const body = (await request.json()) as { sportCategory: string; activities: HermesCall['activities'] };
        calls.push({ sportCategory: body.sportCategory, activities: body.activities });
        return HttpResponse.json({ ok: true });
      }),
    );

    await run(30);

    expect(calls).toHaveLength(1);
    expect(calls[0].sportCategory).toBe('endurance');
  });
});
