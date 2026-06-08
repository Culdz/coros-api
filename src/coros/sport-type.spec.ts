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
