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

/** 問い合わせの回数を数えるリレー */
function countingRelay(relay: MemoryRelay) {
  const calls: unknown[] = [];
  const query: MemoryRelay['query'] = async (filters) => {
    calls.push(filters);
    return relay.query(filters);
  };
  return { relay: Object.assign(Object.create(relay) as MemoryRelay, { query }), calls };
}

describe('Resolver with many accounts', () => {
  test('resolves the authors of many events with one snapshot read and one relay query', async () => {
    const relay = new MemoryRelay(now);
    const players = await Promise.all(Array.from({ length: 5 }, () => newPlayer(new MemoryRelay(now), now)));
    const evs = await Promise.all(players.map((p) => p.signer.signEvent({ kind: 1, created_at: now(), tags: [], content: 'x' })));
    const asked: string[][] = [];
    const counted = countingRelay(relay);
    const resolver = new Resolver(counted.relay);
    resolver.setKnown({}, async (aids) => {
      asked.push(aids);
      return Object.fromEntries(players.filter((p) => aids.includes(p.aid)).map((p) => [p.aid, p.account.kel]));
    });
    expect(await resolver.authorAll(evs)).toEqual(players.map((p) => p.aid));
    expect(asked.map((a) => [...a].sort())).toEqual([players.map((p) => p.aid).sort()]);
    expect(counted.calls.length).toBe(1);
  });

  test('keeps the KELs it read from the snapshot when the same snapshot is set again', async () => {
    const p = await newPlayer(new MemoryRelay(now), now);
    const ev = await p.signer.signEvent({ kind: 1, created_at: now(), tags: [], content: 'x' });
    const asked: string[][] = [];
    const loadKels = async (aids: string[]) => {
      asked.push(aids);
      return { [p.aid]: p.account.kel };
    };
    const resolver = new Resolver(new MemoryRelay(now));
    resolver.setKnown({}, loadKels);
    expect(await resolver.author(ev)).toBe(p.aid);
    resolver.setKnown({}, loadKels);
    expect([resolver.authorNow(ev), asked.length]).toEqual([p.aid, 1]);
  });

  test('setting only the own KEL keeps reading other accounts from the snapshot', async () => {
    const me = await newPlayer(new MemoryRelay(now), now);
    const p = await newPlayer(new MemoryRelay(now), now);
    const ev = await p.signer.signEvent({ kind: 1, created_at: now(), tags: [], content: 'x' });
    const resolver = new Resolver(new MemoryRelay(now));
    resolver.setKnown({}, async () => ({ [p.aid]: p.account.kel }));
    resolver.setKnown({ [me.aid]: me.account.kel });
    expect(await resolver.author(ev)).toBe(p.aid);
  });

  test('falls back to relays when the snapshot part cannot be read', async () => {
    const relay = new MemoryRelay(now);
    const p = await newPlayer(relay, now);
    const ev = await p.signer.signEvent({ kind: 1, created_at: now(), tags: [], content: 'x' });
    const resolver = new Resolver(relay);
    resolver.setKnown({}, async () => {
      throw new Error('HTTP 404');
    });
    expect(await resolver.author(ev)).toBe(p.aid);
  });

  test('looks again right away after a relay failure, instead of waiting for the retry interval', async () => {
    const relay = new MemoryRelay(now);
    const p = await newPlayer(relay, now);
    const ev = await p.signer.signEvent({ kind: 1, created_at: now(), tags: [], content: 'x' });
    let failing = true;
    const flaky = Object.assign(Object.create(relay) as MemoryRelay, {
      query: async (filters: Parameters<MemoryRelay['query']>[0]) => {
        if (failing) throw new Error('relay is down');
        return relay.query(filters);
      },
    });
    const resolver = new Resolver(flaky);
    await expect(resolver.author(ev)).rejects.toThrow(new Error('relay is down'));
    failing = false;
    expect(await resolver.author(ev)).toBe(p.aid);
  });
});
