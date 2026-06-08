# COROS → Hermes Activity Notifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Commits:** The user has opted out of automated git commits. Each task ends with a **Checkpoint** step (run lint + the task's tests) instead of a commit. Do **not** run `git commit` or `git add` unless the user later asks.

**Goal:** Add a single-shot `notify-activities` CLI command, run by crontab every minute, that detects new COROS activities, enriches each with metrics parsed from its FIT file, and notifies a Hermes agent via webhook — plus an inactivity nudge after 48h idle.

**Architecture:** A new command (`NotifyActivitiesCommandRunner`) delegates one poll cycle to an `ActivityWatcher` orchestrator, which composes four focused units: `ActivityStateStore` (local JSON state + cached token), `FitMetricsParser` (FIT bytes → metrics), `HermesNotifier` (build + HMAC-sign + POST), and `NotifyConfigService` (env). It reuses the existing `CorosAPI`. State persists to a local JSON file; the COROS access token is cached there to avoid logging in every minute.

**Tech Stack:** TypeScript, NestJS + `nest-commander`, zod, dayjs, axios (`@nestjs/axios`), `fit-file-parser` (new dep), vitest + msw (tests). Biome (single quotes, 2-space indent, lineWidth 120, `noBarrelFile`, `noInferrableTypes`).

**Conventions to follow (verified in codebase):**
- Services use explicit `private readonly x: T;` fields assigned in the constructor (not TS parameter properties). Match this.
- Config services read `process.env` in their constructor and validate with zod (see `src/coros/coros.config.ts`).
- No barrel/`index.ts` files (`noBarrelFile` is an error).
- Tests: msw against `COROS_API_BASE_URL` (`http://coros-api.test`), `Test.createTestingModule({ imports: [AppModule] })`, env set in `beforeAll`, fixtures under `src/testing/fixtures/`.

**Reference:** spec at `docs/superpowers/specs/2026-06-06-coros-activity-hermes-notifier-design.md`.

**Useful commands:**
- Run one test file: `pnpm vitest run <path>`
- Lint: `pnpm lint:check`  ·  auto-fix: `pnpm lint:fix`
- Typecheck/build: `pnpm build`

---

## File Structure

**Create:**
- `src/notify/clock.ts` — injectable `Clock` (`now(): Date`) for deterministic tests.
- `src/notify/notify.config.ts` — `NotifyConfigService` (webhook URL/secret, thresholds, paths).
- `src/notify/activity-state-store.ts` — `NotifierState` zod schema, `emptyState()`, `ActivityStateStore` (load/save).
- `src/notify/fit-metrics-parser.ts` — `ActivityMetrics` type, pure `mapSessionToMetrics()`, `FitMetricsParser`.
- `src/notify/hermes-notifier.ts` — `HermesNotifier` (build/sign/POST).
- `src/notify/activity-watcher.ts` — `ActivityWatcher` orchestrator + `ActivityPayload` type.
- `src/command-runner/notify-activities.command-runner.ts` — the command.
- `src/types/fit-file-parser.d.ts` — minimal ambient types for the untyped dep.
- Test files alongside: `*.spec.ts` per unit; integration spec for the command.

**Modify:**
- `src/coros/sport-type.ts` — add `getSportTypeKeyFromValue` (reverse lookup).
- `src/coros/coros.module.ts` — export `CorosAuthenticationService`.
- `src/app.module.ts` — register the new providers + command.
- `.env.example`, `.gitignore`, `README.md`.
- `package.json` / lockfile — add `fit-file-parser`.

---

## Task 1: Add `fit-file-parser` dependency + ambient types

**Files:**
- Modify: `package.json` (via pnpm)
- Create: `src/types/fit-file-parser.d.ts`

- [ ] **Step 1: Install the dependency**

Run: `pnpm add fit-file-parser`
Expected: added to `dependencies`. Note `pnpm-workspace.yaml` sets `minimumReleaseAge: 4320` (~3 days) — any stable published release qualifies; if pnpm blocks a too-new version, pin a slightly older one (`pnpm add fit-file-parser@<version>`).

- [ ] **Step 2: Add minimal ambient types** (the package ships no types)

`src/types/fit-file-parser.d.ts`:
```ts
declare module 'fit-file-parser' {
  interface FitParserOptions {
    force?: boolean;
    speedUnit?: 'km/h' | 'mph' | 'm/s';
    lengthUnit?: 'km' | 'mi' | 'm';
    temperatureUnit?: 'celsius' | 'kelvin' | 'fahrenheit';
    elapsedRecordField?: boolean;
    mode?: 'list' | 'cascade' | 'both';
  }

  // The parsed FIT document. We only read `sessions`; everything is loosely typed.
  interface FitData {
    sessions?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  }

  export default class FitParser {
    constructor(options?: FitParserOptions);
    parse(content: Buffer | ArrayBuffer | Uint8Array, callback: (error: string | null, data: FitData) => void): void;
  }
}
```

- [ ] **Step 3: Verify typecheck still passes**

Run: `pnpm build`
Expected: builds with no errors.

- [ ] **Checkpoint:** `pnpm lint:check && pnpm build`

---

## Task 2: Reverse sport-type lookup

**Files:**
- Modify: `src/coros/sport-type.ts`
- Test: `src/coros/sport-type.spec.ts` (create)

- [ ] **Step 1: Write the failing test**

`src/coros/sport-type.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { getSportTypeKeyFromValue } from './sport-type';

describe('getSportTypeKeyFromValue', () => {
  it('maps a known value to its key', () => {
    expect(getSportTypeKeyFromValue('100')).toBe('run');
    expect(getSportTypeKeyFromValue('0')).toBe('all');
  });

  it('returns undefined for an unknown value', () => {
    expect(getSportTypeKeyFromValue('999999')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm vitest run src/coros/sport-type.spec.ts`
Expected: FAIL — `getSportTypeKeyFromValue` is not exported.

- [ ] **Step 3: Implement** (append to `src/coros/sport-type.ts`)

```ts
export const getSportTypeKeyFromValue = (value: string): SportTypeKey | undefined => {
  return Object.values(AllSportTypes).find((it) => it.value === value)?.key;
};
```

- [ ] **Step 4: Run it, verify PASS**

Run: `pnpm vitest run src/coros/sport-type.spec.ts`
Expected: PASS.

- [ ] **Checkpoint:** `pnpm lint:check && pnpm vitest run src/coros/sport-type.spec.ts`

---

## Task 3: `Clock`

**Files:**
- Create: `src/notify/clock.ts`

(No dedicated test — trivial wrapper, exercised via the watcher's tests with an injected fake.)

- [ ] **Step 1: Implement**

`src/notify/clock.ts`:
```ts
import { Injectable } from '@nestjs/common';

@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}
```

- [ ] **Checkpoint:** `pnpm lint:check`

---

## Task 4: `NotifyConfigService`

**Files:**
- Create: `src/notify/notify.config.ts`
- Test: `src/notify/notify.config.spec.ts`

- [ ] **Step 1: Write the failing test**

`src/notify/notify.config.spec.ts`:
```ts
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

  it('throws when the webhook URL is missing', () => {
    delete process.env.HERMES_WEBHOOK_URL;
    expect(() => new NotifyConfigService()).toThrow();
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm vitest run src/notify/notify.config.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/notify/notify.config.ts`:
```ts
import 'dotenv/config';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

const NotifyConfig = z.object({
  webhookUrl: z.string(),
  webhookSecret: z.string().optional(),
  stateFile: z.string().default('./.coros-state.json'),
  inactivityThresholdHours: z.coerce.number().default(48),
  recentHistoryCount: z.coerce.number().default(5),
  accessTokenTtlHours: z.coerce.number().default(6),
  queryWindowDays: z.coerce.number().default(7),
});
type NotifyConfig = z.infer<typeof NotifyConfig>;

@Injectable()
export class NotifyConfigService {
  private readonly config: NotifyConfig;

  constructor() {
    this.config = NotifyConfig.parse({
      webhookUrl: process.env.HERMES_WEBHOOK_URL,
      webhookSecret: process.env.HERMES_WEBHOOK_SECRET,
      stateFile: process.env.COROS_STATE_FILE,
      inactivityThresholdHours: process.env.INACTIVITY_THRESHOLD_HOURS,
      recentHistoryCount: process.env.RECENT_HISTORY_COUNT,
      accessTokenTtlHours: process.env.ACCESS_TOKEN_TTL_HOURS,
      queryWindowDays: process.env.QUERY_WINDOW_DAYS,
    });
  }

  get webhookUrl() {
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
```

> Note: `z.coerce.number()` turns `undefined` into `NaN`, which fails `.default()`. zod applies the default only when the input is `undefined`, and coercion runs after — so passing `undefined` (env not set) correctly yields the default. Passing a string like `'24'` coerces to `24`. Verified by the test above; if the default case fails, change those fields to `z.preprocess((v) => (v === undefined ? undefined : Number(v)), z.number().default(48))`.

- [ ] **Step 4: Run it, verify PASS**

Run: `pnpm vitest run src/notify/notify.config.spec.ts`
Expected: PASS. (If the default-value case fails on `NaN`, apply the `z.preprocess` fallback noted above and re-run.)

- [ ] **Checkpoint:** `pnpm lint:check && pnpm vitest run src/notify/notify.config.spec.ts`

---

## Task 5: `ActivityStateStore`

**Files:**
- Create: `src/notify/activity-state-store.ts`
- Test: `src/notify/activity-state-store.spec.ts`

- [ ] **Step 1: Write the failing test**

`src/notify/activity-state-store.spec.ts`:
```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityStateStore, emptyState } from './activity-state-store';

function makeStore(stateFile: string) {
  return new ActivityStateStore({ stateFile } as never);
}

describe('ActivityStateStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'coros-state-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns empty state when the file is missing', async () => {
    const store = makeStore(path.join(dir, 'missing.json'));
    await expect(store.load()).resolves.toEqual(emptyState());
  });

  it('round-trips state through save/load', async () => {
    const file = path.join(dir, 'state.json');
    const store = makeStore(file);
    const state = emptyState();
    state.seenLabelIds = ['a', 'b'];
    state.accessToken = 'tok';

    await store.save(state);
    await expect(store.load()).resolves.toEqual(state);
  });

  it('returns empty state when the file is corrupt', async () => {
    const file = path.join(dir, 'corrupt.json');
    await writeFile(file, 'not json {{{', 'utf-8');
    const store = makeStore(file);
    await expect(store.load()).resolves.toEqual(emptyState());
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm vitest run src/notify/activity-state-store.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/notify/activity-state-store.ts`:
```ts
import { readFile, rename, writeFile } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { NotifyConfigService } from './notify.config';

export const NotifierState = z.object({
  version: z.literal(1),
  seenLabelIds: z.array(z.string()),
  lastActivityEndTime: z.string().nullable(),
  lastActivityLabelId: z.string().nullable(),
  accessToken: z.string().nullable(),
  accessTokenIssuedAt: z.string().nullable(),
  recentActivities: z.array(z.record(z.string(), z.unknown())),
});
export type NotifierState = z.infer<typeof NotifierState>;

export function emptyState(): NotifierState {
  return {
    version: 1,
    seenLabelIds: [],
    lastActivityEndTime: null,
    lastActivityLabelId: null,
    accessToken: null,
    accessTokenIssuedAt: null,
    recentActivities: [],
  };
}

@Injectable()
export class ActivityStateStore {
  private readonly logger = new Logger(ActivityStateStore.name);
  private readonly config: NotifyConfigService;

  constructor(config: NotifyConfigService) {
    this.config = config;
  }

  async load(): Promise<NotifierState> {
    let raw: string;
    try {
      raw = await readFile(this.config.stateFile, 'utf-8');
    } catch {
      return emptyState();
    }

    try {
      const parsed = NotifierState.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        this.logger.warn(`State file ${this.config.stateFile} is invalid; starting fresh`);
        return emptyState();
      }
      return parsed.data;
    } catch {
      this.logger.warn(`State file ${this.config.stateFile} is not valid JSON; starting fresh`);
      return emptyState();
    }
  }

  async save(state: NotifierState): Promise<void> {
    const tmp = `${this.config.stateFile}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
    await rename(tmp, this.config.stateFile);
  }
}
```

- [ ] **Step 4: Run it, verify PASS**

Run: `pnpm vitest run src/notify/activity-state-store.spec.ts`
Expected: PASS.

- [ ] **Checkpoint:** `pnpm lint:check && pnpm vitest run src/notify/activity-state-store.spec.ts`

---

## Task 6: `FitMetricsParser`

**Files:**
- Create: `src/notify/fit-metrics-parser.ts`
- Test: `src/notify/fit-metrics-parser.spec.ts`

The risky part of FIT handling is the field mapping, not the library call. Split a **pure** `mapSessionToMetrics()` (fully unit-tested with plain objects) from a thin `FitMetricsParser.parse()` wrapper (tested with the library mocked). This avoids needing a hand-authored binary `.fit` fixture.

- [ ] **Step 1: Write the failing test**

`src/notify/fit-metrics-parser.spec.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { mapSessionToMetrics } from './fit-metrics-parser';

describe('mapSessionToMetrics', () => {
  it('maps a full running session', () => {
    const metrics = mapSessionToMetrics({
      start_time: '2025-01-15T07:00:00.000Z',
      total_timer_time: 1800, // 30 min
      total_distance: 5, // km (parser configured with lengthUnit: 'km')
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
    const { FitMetricsParser } = await import('./fit-metrics-parser');
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
          cb('bad fit', { });
        }
      },
    }));
    const { FitMetricsParser } = await import('./fit-metrics-parser');
    const parser = new FitMetricsParser();

    await expect(parser.parse(Buffer.from('x'))).rejects.toThrow('bad fit');
    vi.doUnmock('fit-file-parser');
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm vitest run src/notify/fit-metrics-parser.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/notify/fit-metrics-parser.ts`:
```ts
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
  elevationGainM?: number;
  calories?: number;
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

  const ascent = asNumber(session.total_ascent);
  if (ascent !== undefined) {
    metrics.elevationGainM = ascent;
  }

  const calories = asNumber(session.total_calories);
  if (calories !== undefined) {
    metrics.calories = calories;
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
```

- [ ] **Step 4: Run it, verify PASS**

Run: `pnpm vitest run src/notify/fit-metrics-parser.spec.ts`
Expected: PASS.

- [ ] **Checkpoint:** `pnpm lint:check && pnpm vitest run src/notify/fit-metrics-parser.spec.ts`

---

## Task 7: `HermesNotifier`

**Files:**
- Create: `src/notify/hermes-notifier.ts`
- Test: `src/notify/hermes-notifier.spec.ts`

- [ ] **Step 1: Write the failing test**

`src/notify/hermes-notifier.spec.ts`:
```ts
import { createHmac } from 'node:crypto';
import { HttpService } from '@nestjs/axios';
import { HttpResponse, http } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { server } from '../testing/msw-server';
import { HermesNotifier } from './hermes-notifier';

const WEBHOOK = 'http://hermes.test/webhooks/coros';

function makeNotifier(secret?: string) {
  return new HermesNotifier(new HttpService(), { webhookUrl: WEBHOOK, webhookSecret: secret } as never);
}

describe('HermesNotifier', () => {
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  it('POSTs JSON with the signature header when a secret is set', async () => {
    const secret = 'topsecret';
    let receivedBody = '';
    let receivedSig: string | null = null;
    let receivedType: string | null = null;

    server.use(
      http.post(WEBHOOK, async ({ request }) => {
        receivedBody = await request.text();
        receivedSig = request.headers.get('x-webhook-signature');
        receivedType = request.headers.get('content-type');
        return HttpResponse.json({ ok: true });
      }),
    );

    const payload = { event: 'new_activity', source: 'coros' };
    const ok = await makeNotifier(secret).notify(payload);

    expect(ok).toBe(true);
    expect(JSON.parse(receivedBody)).toEqual(payload);
    expect(receivedType).toContain('application/json');
    expect(receivedSig).toBe(createHmac('sha256', secret).update(receivedBody).digest('hex'));
  });

  it('omits the signature header when no secret is set', async () => {
    let receivedSig: string | null = 'unset';
    server.use(
      http.post(WEBHOOK, ({ request }) => {
        receivedSig = request.headers.get('x-webhook-signature');
        return HttpResponse.json({ ok: true });
      }),
    );

    await makeNotifier(undefined).notify({ event: 'inactive' });
    expect(receivedSig).toBeNull();
  });

  it('returns false (does not throw) when Hermes responds with an error', async () => {
    server.use(http.post(WEBHOOK, () => new HttpResponse(null, { status: 500 })));
    await expect(makeNotifier().notify({ event: 'x' })).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm vitest run src/notify/hermes-notifier.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/notify/hermes-notifier.ts`:
```ts
import { createHmac } from 'node:crypto';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { NotifyConfigService } from './notify.config';

@Injectable()
export class HermesNotifier {
  private readonly logger = new Logger(HermesNotifier.name);
  private readonly httpService: HttpService;
  private readonly config: NotifyConfigService;

  constructor(httpService: HttpService, config: NotifyConfigService) {
    this.httpService = httpService;
    this.config = config;
  }

  async notify(payload: unknown): Promise<boolean> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (this.config.webhookSecret) {
      headers['X-Webhook-Signature'] = createHmac('sha256', this.config.webhookSecret).update(body).digest('hex');
    }

    try {
      await this.httpService.axiosRef.post(this.config.webhookUrl, body, { headers });
      return true;
    } catch (error) {
      this.logger.error(`Failed to notify Hermes: ${error}`);
      return false;
    }
  }
}
```

> Posting the pre-serialized `body` string (not the object) guarantees the bytes sent match the bytes signed.

- [ ] **Step 4: Run it, verify PASS**

Run: `pnpm vitest run src/notify/hermes-notifier.spec.ts`
Expected: PASS.

- [ ] **Checkpoint:** `pnpm lint:check && pnpm vitest run src/notify/hermes-notifier.spec.ts`

---

## Task 8: Export `CorosAuthenticationService` from `CorosModule`

**Files:**
- Modify: `src/coros/coros.module.ts`

The watcher needs to set/read the access token directly for caching. Export the auth service so it's injectable in `AppModule`.

- [ ] **Step 1: Add to the module's `exports`**

In `src/coros/coros.module.ts`, change:
```ts
  exports: [CorosAPI],
```
to:
```ts
  exports: [CorosAPI, CorosAuthenticationService],
```
(`CorosAuthenticationService` is already imported and listed in `providers`.)

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: builds clean.

- [ ] **Checkpoint:** `pnpm lint:check && pnpm build`

---

## Task 9: `ActivityWatcher` (orchestrator)

**Files:**
- Create: `src/notify/activity-watcher.ts`
- (Tested via the integration spec in Task 11.)

- [ ] **Step 1: Implement**

`src/notify/activity-watcher.ts`:
```ts
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

    let activities = await this.queryRecentWithAuthRetry(state);

    if (state.seenLabelIds.length === 0) {
      this.bootstrap(state, activities);
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
    try {
      return await this.queryRecent();
    } catch (error) {
      if (this.isAuthError(error)) {
        this.logger.warn('Query failed with an auth error; re-logging in and retrying');
        await this.login(state);
        return await this.queryRecent();
      }
      throw error;
    }
  }

  private async queryRecent(): Promise<Activity[]> {
    const from = dayjs(this.clock.now()).subtract(this.config.queryWindowDays, 'day').toDate();
    const { activities } = await this.coros.queryActivities({ from, sportTypes: [ALL_SPORT_TYPES] });
    return activities;
  }

  private bootstrap(state: NotifierState, activities: Activity[]): void {
    state.seenLabelIds = activities.map((activity) => activity.labelId);
    if (activities.length > 0) {
      const mostRecent = activities.reduce((a, b) => (a.date >= b.date ? a : b));
      state.lastActivityEndTime = dayjs(String(mostRecent.date), 'YYYYMMDD').toDate().toISOString();
      state.lastActivityLabelId = mostRecent.labelId;
    }
    this.logger.log(`Bootstrap: seeded ${state.seenLabelIds.length} activity(ies); no notifications sent`);
  }

  private async processNewActivity(state: NotifierState, activity: Activity): Promise<void> {
    try {
      const { fileUrl } = await this.coros.downloadActivityDetail({
        labelId: activity.labelId,
        sportType: activity.sportType,
        fileType: FIT_FILE_TYPE,
      });
      const buffer = await this.fetchFitFile(fileUrl);
      const metrics = await this.fitParser.parse(buffer);
      const payload = this.buildActivityPayload(activity, metrics);

      const ok = await this.notifier.notify({
        event: 'new_activity',
        source: 'coros',
        activity: payload,
        recentActivities: state.recentActivities,
      });

      if (!ok) {
        this.logger.warn(`Hermes notify failed for ${activity.labelId}; leaving unseen to retry next run`);
        return;
      }

      state.seenLabelIds.push(activity.labelId);
      state.recentActivities = [payload, ...state.recentActivities].slice(0, this.config.recentHistoryCount);

      const endTime = payload.endTime ?? dayjs(String(activity.date), 'YYYYMMDD').toDate().toISOString();
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

    await this.notifier.notify({
      event: 'inactive',
      source: 'coros',
      inactivity: {
        hoursSinceLastActivity: Math.floor(hours),
        lastActivity: state.recentActivities[0] ?? { labelId: state.lastActivityLabelId },
      },
    });
  }

  private isAuthError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'response' in error &&
      (error as { response?: { status?: number } }).response?.status === 401
    );
  }
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: builds clean.

- [ ] **Checkpoint:** `pnpm lint:check && pnpm build`

---

## Task 10: `NotifyActivitiesCommandRunner` + module wiring

**Files:**
- Create: `src/command-runner/notify-activities.command-runner.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 1: Implement the command**

`src/command-runner/notify-activities.command-runner.ts`:
```ts
import { Logger } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { ActivityWatcher } from '../notify/activity-watcher';

@Command({ name: 'notify-activities', description: 'Poll COROS for new activities and notify the Hermes agent' })
export class NotifyActivitiesCommandRunner extends CommandRunner {
  private readonly logger = new Logger(NotifyActivitiesCommandRunner.name);
  private readonly watcher: ActivityWatcher;

  constructor(watcher: ActivityWatcher) {
    super();
    this.watcher = watcher;
  }

  async run(): Promise<void> {
    try {
      await this.watcher.run();
    } catch (error) {
      this.logger.error(`notify-activities failed: ${error}`);
    }
  }
}
```

- [ ] **Step 2: Register providers in `AppModule`**

`src/app.module.ts` — add imports and providers:
```ts
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ExportActivitiesCommandRunner } from './command-runner/export-activities.command-runner';
import { ExportTrainingScheduleCommandRunner } from './command-runner/export-training-schedule.command-runner';
import { NotifyActivitiesCommandRunner } from './command-runner/notify-activities.command-runner';
import { DownloadFile } from './core/download-file.service';
import { CorosModule } from './coros/coros.module';
import { ActivityStateStore } from './notify/activity-state-store';
import { ActivityWatcher } from './notify/activity-watcher';
import { Clock } from './notify/clock';
import { FitMetricsParser } from './notify/fit-metrics-parser';
import { HermesNotifier } from './notify/hermes-notifier';
import { NotifyConfigService } from './notify/notify.config';

@Module({
  imports: [CorosModule, HttpModule],
  providers: [
    ExportActivitiesCommandRunner,
    ExportTrainingScheduleCommandRunner,
    NotifyActivitiesCommandRunner,
    DownloadFile,
    NotifyConfigService,
    Clock,
    ActivityStateStore,
    FitMetricsParser,
    HermesNotifier,
    ActivityWatcher,
  ],
})
export class AppModule {}
```

- [ ] **Step 3: Verify the command is registered**

Run: `pnpm build && node dist/main notify-activities --help`
Expected: help text shows the `notify-activities` command (it will not actually run a cycle for `--help`). If it errors on missing `HERMES_WEBHOOK_URL`, that confirms wiring works — set the env to test, or rely on the integration test in Task 11.

- [ ] **Checkpoint:** `pnpm lint:check && pnpm build`

---

## Task 11: Integration test for the full cycle

**Files:**
- Create: `src/command-runner/notify-activities.command-runner.integration.spec.ts`

Mirror the existing `export-activities.command-runner.integration.spec.ts` harness (msw + `Test.createTestingModule`). Override `Clock` with a fixed time and point `COROS_STATE_FILE` at a temp file. Use a Hermes webhook URL on a test host and assert posted payloads.

- [ ] **Step 1: Write the test**

`src/command-runner/notify-activities.command-runner.integration.spec.ts`:
```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Test } from '@nestjs/testing';
import { HttpResponse, http } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { Clock } from '../notify/clock';
import { NotifierState } from '../notify/activity-state-store';
import { buildDownloadActivityDetailResponse } from '../testing/fixtures/download-activity';
import { buildLoginResponse } from '../testing/fixtures/login';
import { buildActivity, buildQueryActivitiesResponse } from '../testing/fixtures/query-activities';
import { COROS_API_BASE_URL, server } from '../testing/msw-server';
import { NotifyActivitiesCommandRunner } from './notify-activities.command-runner';

const HERMES_WEBHOOK = 'http://hermes.test/webhooks/coros';
const FIT_BYTES = 'fake-fit-bytes';
// Fixed "now" close to the fixture activity dates so the 7-day query window covers them.
const NOW = new Date('2025-01-16T08:00:00.000Z');

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
      http.get(`${COROS_API_BASE_URL}/files/*`, () =>
        new HttpResponse(FIT_BYTES, { headers: { 'Content-Type': 'application/octet-stream' } }),
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
  });

  it('notifies for a new activity on a subsequent run', async () => {
    // Seed with a1 already seen.
    server.use(...baseHandlers([buildActivity({ labelId: 'a1', date: 20250115 })]));
    await runCommand();
    expect(hermesCalls).toHaveLength(0);

    // a2 is new.
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
    const activity = newActivityCalls[0].body.activity as Record<string, unknown>;
    expect(activity.labelId).toBe('a2');
    expect(activity.name).toBe('Lunch Run');
    expect(activity.sportType).toBe('run');

    const state = await readState();
    expect(state.seenLabelIds).toContain('a2');
  });

  it('does not re-notify for an already-seen activity (dedupe)', async () => {
    server.use(...baseHandlers([buildActivity({ labelId: 'a1', date: 20250115 })]));
    await runCommand(); // seed
    server.resetHandlers();
    server.use(
      ...baseHandlers([
        buildActivity({ labelId: 'a1', date: 20250115 }),
        buildActivity({ labelId: 'a2', date: 20250116 }),
      ]),
    );
    await runCommand(); // notifies a2
    server.resetHandlers();
    server.use(
      ...baseHandlers([
        buildActivity({ labelId: 'a1', date: 20250115 }),
        buildActivity({ labelId: 'a2', date: 20250116 }),
      ]),
    );

    await runCommand(); // nothing new

    expect(hermesCalls.filter((c) => c.event === 'new_activity')).toHaveLength(0);
  });

  it('leaves an activity unseen when the Hermes POST fails, so it retries next run', async () => {
    server.use(...baseHandlers([buildActivity({ labelId: 'a1', date: 20250115 })]));
    await runCommand(); // seed

    // a2 is new but Hermes fails.
    server.resetHandlers();
    server.use(
      http.post(`${COROS_API_BASE_URL}/account/login`, () => HttpResponse.json(buildLoginResponse())),
      http.get(`${COROS_API_BASE_URL}/activity/query`, () =>
        HttpResponse.json(
          buildQueryActivitiesResponse({
            activities: [buildActivity({ labelId: 'a1', date: 20250115 }), buildActivity({ labelId: 'a2', date: 20250116 })],
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
    // Seed with an old activity, then run "now" well beyond 48h later.
    server.use(...baseHandlers([buildActivity({ labelId: 'a1', date: 20250101 })]));
    await runCommand(new Date('2025-01-01T08:00:00.000Z')); // seed, lastActivity = 2025-01-01

    server.resetHandlers();
    server.use(...baseHandlers([buildActivity({ labelId: 'a1', date: 20250101 })])); // nothing new

    await runCommand(new Date('2025-01-10T08:00:00.000Z')); // 9 days later

    const inactiveCalls = hermesCalls.filter((c) => c.event === 'inactive');
    expect(inactiveCalls).toHaveLength(1);
    const inactivity = inactiveCalls[0].body.inactivity as Record<string, unknown>;
    expect(inactivity.hoursSinceLastActivity as number).toBeGreaterThanOrEqual(48);
  });

  it('reuses a cached token without logging in again', async () => {
    server.use(...baseHandlers([buildActivity({ labelId: 'a1', date: 20250115 })]));
    await runCommand(); // logs in once, caches token
    expect(loginCount).toBe(1);

    server.resetHandlers();
    server.use(...baseHandlers([buildActivity({ labelId: 'a1', date: 20250115 })]));

    await runCommand(); // within TTL → no new login
    expect(loginCount).toBe(0); // counter reset in beforeEach? No — see note
  });
});
```

> **Note on the last test:** `loginCount` is reset in `beforeEach`, but both `runCommand()` calls happen in the same test, so the reset does not occur between them. After the first run `loginCount === 1`; `server.resetHandlers()` + re-registering does not reset the counter variable. So assert `loginCount === 1` after BOTH runs (the second run must NOT log in). Fix the final assertion to: `expect(loginCount).toBe(1);`. Update the test accordingly when implementing.

- [ ] **Step 2: Run the integration test, verify it fails (no impl gaps) then passes**

Run: `pnpm vitest run src/command-runner/notify-activities.command-runner.integration.spec.ts`
Expected: With Tasks 1–10 done, these should pass. If the token-reuse test fails, apply the assertion fix in the note. If the inactivity test's hour math is off by timezone, prefer UTC dates in fixtures (already used).

- [ ] **Checkpoint:** `pnpm lint:check && pnpm vitest run src/command-runner/notify-activities.command-runner.integration.spec.ts`

---

## Task 12: Docs & config files

**Files:**
- Modify: `.env.example`, `.gitignore`, `README.md`

- [ ] **Step 1: Add env vars to `.env.example`**

Append:
```dotenv
# --- Hermes activity notifier (notify-activities command) ---
# Hermes generic webhook URL (inside the Hermes container, use 127.0.0.1)
HERMES_WEBHOOK_URL=http://127.0.0.1:8644/webhooks/coros
# Optional HMAC shared secret; if set, sent as the X-Webhook-Signature header
# HERMES_WEBHOOK_SECRET=change-me
# Path to the local state file (gitignored)
# COROS_STATE_FILE=./.coros-state.json
# Hours of inactivity before sending an "inactive" nudge
# INACTIVITY_THRESHOLD_HOURS=48
# How many recent activities to include in the payload for comparison
# RECENT_HISTORY_COUNT=5
# Reuse the cached COROS access token for this many hours before re-login
# ACCESS_TOKEN_TTL_HOURS=6
# How many days back to query for activities each run
# QUERY_WINDOW_DAYS=7
```

- [ ] **Step 2: Ignore the state file**

Add to `.gitignore`:
```gitignore
.coros-state.json
.coros-state.json.tmp
```

- [ ] **Step 3: Document the command in `README.md`**

Add a new section (after the training-schedule section):
````markdown
## Notify Hermes about new activities

Polls COROS for newly recorded activities, enriches each with metrics parsed from
its FIT file, and notifies a [Hermes](https://hermes-agent.nousresearch.com/) agent
via its generic webhook. After 48h without an activity, it sends an inactivity nudge.

Designed to be run by cron every minute, **inside the Hermes container** (so it can
reach the webhook on `127.0.0.1`).

**Setup:**
- Set `HERMES_WEBHOOK_URL` (and optionally `HERMES_WEBHOOK_SECRET`) in `.env` — see [.env.example](.env.example).
- On the Hermes side, configure a webhook route whose path matches your URL
  (e.g. `coros`), a `prompt` template that reads payload fields
  (`{activity.name}`, `{activity.distanceKm}`, `{activity.avgHeartRate}`, …), and —
  if you set a secret — the matching `secret`.

**Run once (for testing):**
```shell
pnpm build
node dist/main notify-activities
```

**Crontab (every minute):**
```cron
* * * * * cd /path/to/coros-api && /usr/bin/node dist/main notify-activities >> /var/log/coros-notify.log 2>&1
```

> Note: every-minute polling of the unofficial COROS API is aggressive. A gentler
> interval (e.g. `*/5 * * * *`) works just as well — only the crontab schedule changes.

**Payload shape:**
```jsonc
// new activity
{ "event": "new_activity", "source": "coros",
  "activity": { "labelId", "name", "sportType", "startTime", "endTime",
                "durationSec", "distanceKm", "avgPaceSecPerKm",
                "avgHeartRate", "maxHeartRate", "elevationGainM", "calories" },
  "recentActivities": [ /* prior enriched activities */ ] }

// inactivity nudge
{ "event": "inactive", "source": "coros",
  "inactivity": { "hoursSinceLastActivity", "lastActivity": { ... } } }
```
Metric fields are omitted when the FIT file does not contain them.
````

- [ ] **Checkpoint:** `pnpm lint:check`

---

## Task 13: Full verification

- [ ] **Step 1: Run the whole suite**

Run: `pnpm test`
Expected: all tests pass (existing + new).

- [ ] **Step 2: Lint + build**

Run: `pnpm lint:check && pnpm build`
Expected: clean lint, successful build.

- [ ] **Step 3: Smoke-test the command against a local stub (optional)**

Set `HERMES_WEBHOOK_URL` to a local listener (e.g. `nc -l 8644` or a tiny server) and run `node dist/main notify-activities` with valid COROS creds to confirm an end-to-end POST. (Requires real credentials; skip if unavailable — the integration test already covers behavior.)

- [ ] **Done.** Per the user's preference, do not commit unless asked.

---

## Notes / risks for the implementer

- **FIT field names**: `mapSessionToMetrics` reads standard FIT `session` fields (`total_distance`, `total_timer_time`, `avg_heart_rate`, etc.). COROS FIT files are standard, but if a real export reveals different/missing fields, adjust the mapping (the pure function is easy to extend and test). Adding a real `.fit` fixture later for an end-to-end decode test is a good follow-up.
- **`fit-file-parser` import**: relies on `esModuleInterop` (provided by `@tsconfig/node24`). If the default import fails at runtime, use `import * as FitParserModule` / `const FitParser = (FitParserModule as any).default ?? FitParserModule`.
- **Token caching**: the access token is stored in plaintext in the state file (same trust level as `.env`). The file is gitignored. This matches the existing model where credentials live in `.env`.
- **Idle nudge cadence**: by design it fires every run past the threshold; Hermes throttles. This is intentional per the spec.
