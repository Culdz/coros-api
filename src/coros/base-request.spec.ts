import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BaseRequest } from './base-request';

// Minimal concrete subclass to exercise the protected response assertions.
class ProbeRequest extends BaseRequest<unknown, never> {
  protected inputValidator(): z.Schema<unknown> {
    return z.unknown();
  }
  protected responseValidator(): z.Schema<never> {
    return z.any() as unknown as z.Schema<never>;
  }
  protected async handle(): Promise<never> {
    return undefined as never;
  }
  public check(data: unknown): void {
    this.assertCorosResponseBase(data);
  }
}

describe('BaseRequest.assertCorosResponseBase', () => {
  const probe = new ProbeRequest();

  it('surfaces the COROS error message when the error envelope has no apiCode', () => {
    // Real COROS error envelopes (e.g. invalid token) omit apiCode and data.
    expect(() =>
      probe.check({ result: '1019', tlogId: '18990718413549824', message: 'Access token is invalid' }),
    ).toThrowError('Access token is invalid');
  });

  it('does not throw for a success envelope with apiCode', () => {
    expect(() => probe.check({ apiCode: '41C2B95C', result: '0000', message: 'OK' })).not.toThrow();
  });

  it('does not throw for a success envelope even without apiCode', () => {
    expect(() => probe.check({ result: '0000', message: 'OK' })).not.toThrow();
  });
});
