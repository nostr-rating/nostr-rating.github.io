import { MemoryRelay } from '@nostr-rating/core';
import { describe, expect, test } from 'vitest';
import { Resolver } from '../src/account/resolver.js';
import { newPlayer } from './helpers.js';

const now = () => 1_793_030_000;

describe('Resolver', () => {
  test('uses the KEL recorded in the snapshot for an account it did not know, before asking relays', async () => {
    const p = await newPlayer(new MemoryRelay(now), now);
    const ev = await p.signer.signEvent({ kind: 1, created_at: now(), tags: [], content: 'x' });
    // このリレーには KEL が無い。記録済みの KEL はスナップショットからだけ読める
    const asked: string[][] = [];
    const resolver = new Resolver(new MemoryRelay(now));
    resolver.setKnown({}, async (aids) => {
      asked.push(aids);
      return { [p.aid]: p.account.kel };
    });
    expect([await resolver.author(ev), asked]).toEqual([p.aid, [[p.aid]]]);
    expect(await new Resolver(new MemoryRelay(now)).author(ev)).toBeNull();
  });
});
