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
