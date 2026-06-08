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
