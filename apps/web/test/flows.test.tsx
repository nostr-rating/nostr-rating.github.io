import {
  buildApplication,
  buildIdentities,
  buildMatch,
  buildProfile,
  buildReport,
  buildSettings,
  encodeNsec,
  KIND,
  LocalSigner,
  MemoryRelay,
  npubOf,
  parseMatch,
  verificationText,
  type MatchRecord,
  type RelayClient,
} from '@nostr-rating/core';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { generateSecretKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Lobby } from '../src/pages/Lobby.js';
import { MatchRoom } from '../src/pages/MatchRoom.js';
import { Onboarding } from '../src/pages/Onboarding.js';
import { clearLocalKey, isBackedUp } from '../src/services/signer-local.js';
import { makeDeps, renderWithApp } from './helpers.js';

const realNow = () => Math.floor(Date.now() / 1000);

beforeEach(async () => {
  localStorage.clear();
  await clearLocalKey();
  location.hash = '#/lobby';
});
afterEach(cleanup);

async function player(relay: MemoryRelay, name: string, gist: string) {
  const signer = new LocalSigner(generateSecretKey());
  await relay.publish(await signer.signEvent(buildProfile({ name }, realNow() - 200)));
  await relay.publish(await signer.signEvent(buildIdentities([{ platform: 'github', identity: name, proof: gist }], realNow() - 100)));
  return signer;
}

async function matchBetween(relay: MemoryRelay, a: LocalSigner, b: LocalSigner): Promise<MatchRecord> {
  const [pa, pb] = [await a.getPublicKey(), await b.getPublicKey()];
  const t = realNow() - 30;
  const sa = await a.signEvent(buildSettings('smash_sp', { stageBans: { mario: ['final_destination'] }, rangeChoice: null, rematchHours: 0 }, t - 50));
  const sb = await b.signEvent(buildSettings('smash_sp', { stageBans: {}, rangeChoice: null, rematchHours: 0 }, t - 50));
  const app = await b.signEvent(
    buildApplication('smash_sp', { recruiter: pa, firstFighter: 'mario', settingsId: sb.id, rangeChoice: null, rematchHours: 0, waitingSince: t - 10 }, t - 1),
  );
  const mev = await a.signEvent(
    buildMatch('smash_sp', { p1: pa, p2: pb, p1Fighter: 'fox', p2Fighter: 'mario', p1SettingsId: sa.id, p2SettingsId: sb.id, applicationId: app.id }, t),
  );
  for (const e of [sa, sb, app, mev]) await relay.publish(e);
  return parseMatch('smash_sp', mev)!;
}

function gistRoutes(entries: { login: string; gist: string; pubkey: string }[]): Record<string, unknown> {
  return Object.fromEntries(
    entries.map((e) => [`https://api.github.com/gists/${e.gist}`, { owner: { login: e.login }, files: { f: { content: verificationText(e.pubkey) } } }]),
  );
}

describe('match room', () => {
  test('shows the opponent name and the verification status of their SNS claim', async () => {
    const relay = new MemoryRelay(realNow);
    const a = await player(relay, 'alice', 'aaa1');
    const b = await player(relay, 'bob', 'bbb1');
    const m = await matchBetween(relay, a, b);
    const routes = gistRoutes([{ login: 'bob', gist: 'bbb1', pubkey: await b.getPublicKey() }]);
    renderWithApp(<MatchRoom matchId={m.id} />, { deps: makeDeps({ relay, now: realNow, routes }), signer: { signer: a, kind: 'local' }, backedUp: true });
    expect(await screen.findByText('bob', { selector: 'strong' })).toBeTruthy();
    expect(await screen.findByText('自動検証済み')).toBeTruthy();
  });

  test('after confirmation the report buttons are gone and my report is shown', async () => {
    const user = userEvent.setup();
    const relay = new MemoryRelay(realNow);
    const a = await player(relay, 'alice', 'aaa1');
    const b = await player(relay, 'bob', 'bbb1');
    const m = await matchBetween(relay, a, b);
    await relay.publish(await b.signEvent(buildReport('smash_sp', { matchId: m.id, opponent: m.p1, result: 'lose' }, realNow())));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderWithApp(<MatchRoom matchId={m.id} />, { deps: makeDeps({ relay, now: realNow }), signer: { signer: a, kind: 'local' }, backedUp: true });
    await user.click(await screen.findByRole('button', { name: '勝ち' }));
    await waitFor(() => expect(screen.getByTestId('report-status').textContent).toBe('結果が確定しました（あなたの勝ち）'));
    expect(screen.queryByRole('button', { name: '勝ち' })).toBeNull();
    expect(screen.getByText('あなたの報告: 勝ち')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'ロビーに戻る' })).toBeTruthy();
  });

  test('reporting asks for confirmation and sends nothing when cancelled', async () => {
    const user = userEvent.setup();
    const relay = new MemoryRelay(realNow);
    const a = await player(relay, 'alice', 'aaa1');
    const b = await player(relay, 'bob', 'bbb1');
    const m = await matchBetween(relay, a, b);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderWithApp(<MatchRoom matchId={m.id} />, { deps: makeDeps({ relay, now: realNow }), signer: { signer: a, kind: 'local' }, backedUp: true });
    await user.click(await screen.findByRole('button', { name: '負け' }));
    expect(relay.all().filter((e) => e.kind === KIND.report)).toHaveLength(0);
  });

  test('a failed send is shown to the player', async () => {
    const user = userEvent.setup();
    const relay = new MemoryRelay(realNow);
    const a = await player(relay, 'alice', 'aaa1');
    const b = await player(relay, 'bob', 'bbb1');
    const m = await matchBetween(relay, a, b);
    const failing: RelayClient = { ...relay, query: relay.query.bind(relay), subscribe: relay.subscribe.bind(relay), close: () => undefined, publish: async () => { throw new Error('offline'); } };
    renderWithApp(<MatchRoom matchId={m.id} />, { deps: { ...makeDeps({ relay, now: realNow }), relay: failing }, signer: { signer: a, kind: 'local' }, backedUp: true });
    await user.type(await screen.findByLabelText('部屋 ID'), 'AB12C');
    await user.click(screen.getByRole('button', { name: '部屋 ID を送る' }));
    expect(await screen.findByText('送れませんでした。電波のよい場所でもう一度押してください。')).toBeTruthy();
  });

  test('stage guide can undo a game and record the opponent changing fighter', async () => {
    const user = userEvent.setup();
    const relay = new MemoryRelay(realNow);
    const a = await player(relay, 'alice', 'aaa1');
    const b = await player(relay, 'bob', 'bbb1');
    const m = await matchBetween(relay, a, b);
    renderWithApp(<MatchRoom matchId={m.id} />, { deps: makeDeps({ relay, now: realNow }), signer: { signer: a, kind: 'local' }, backedUp: true });
    await user.click(await screen.findByRole('button', { name: '1戦目: あなたの勝ち' }));
    await user.selectOptions(screen.getByLabelText('相手のキャラ（直前の敗者が変えたとき）'), 'luigi');
    expect(screen.getByTestId('stage-options').textContent).toBe('終点・戦場・ポケモンスタジアム2・小戦場・ホロウバスティオン・村と街・すま村');
    await user.click(screen.getByRole('button', { name: '1つ前に戻す' }));
    expect(screen.getByTestId('stage-picker').textContent).toBe('1戦目: お互いが選び、ゲーム内の抽選に従います');
  });

  test('shows the excluded stages and the report deadline', async () => {
    const relay = new MemoryRelay(realNow);
    const a = await player(relay, 'alice', 'aaa1');
    const b = await player(relay, 'bob', 'bbb1');
    const m = await matchBetween(relay, a, b);
    renderWithApp(<MatchRoom matchId={m.id} />, { deps: makeDeps({ relay, now: realNow }), signer: { signer: b, kind: 'local' }, backedUp: true });
    await waitFor(() => expect(screen.getByTestId('excluded-stages').textContent).toBe('除外: 終点（相手の拒否）'));
    expect(screen.getByTestId('deadline').textContent).toMatch(/^報告の締め切り: \d{1,2}\/\d{1,2} \d{2}:\d{2}（あと 23時間\d+分）$/);
  });
});

async function forgedMatch(relay: MemoryRelay, attacker: LocalSigner, victim: LocalSigner): Promise<string> {
  const [pa, pv] = [await attacker.getPublicKey(), await victim.getPublicKey()];
  const ev = await attacker.signEvent(
    buildMatch('smash_sp', { p1: pa, p2: pv, p1Fighter: 'fox', p2Fighter: 'mario', p1SettingsId: '1'.repeat(64), p2SettingsId: '2'.repeat(64), applicationId: 'a'.repeat(64) }, realNow() - 30),
  );
  await relay.publish(ev);
  return ev.id;
}

describe('forged matches', () => {
  test('a match without the victim application is not listed in the lobby', async () => {
    const relay = new MemoryRelay(realNow);
    const a = await player(relay, 'alice', 'aaa1');
    const b = await player(relay, 'bob', 'bbb1');
    const mallory = await player(relay, 'mallory', 'eee1');
    const real = await matchBetween(relay, a, b);
    await forgedMatch(relay, mallory, b);
    renderWithApp(<Lobby />, { deps: makeDeps({ relay, now: realNow }), signer: { signer: b, kind: 'local' }, backedUp: true });
    expect(await screen.findByRole('link', { name: '対戦ルームへ戻る（alice さん）' })).toBeTruthy();
    expect(document.querySelectorAll(`a[href^="#/match/"]`)).toHaveLength(1);
    expect(document.querySelector('a[href^="#/match/"]')!.getAttribute('href')).toBe(`#/match/${real.id}`);
  });

  test('opening a forged match room says it is not a valid match', async () => {
    const relay = new MemoryRelay(realNow);
    const b = await player(relay, 'bob', 'bbb1');
    const mallory = await player(relay, 'mallory', 'eee1');
    const id = await forgedMatch(relay, mallory, b);
    renderWithApp(<MatchRoom matchId={id} />, { deps: makeDeps({ relay, now: realNow }), signer: { signer: b, kind: 'local' }, backedUp: true });
    expect(await screen.findByText('この対戦は有効ではありません。あなたの申し込みに応えた対戦であることを確かめられませんでした。')).toBeTruthy();
  });
});

describe('lobby', () => {
  test('lists an ongoing match with a way back to the room', async () => {
    const relay = new MemoryRelay(realNow);
    const a = await player(relay, 'alice', 'aaa1');
    const b = await player(relay, 'bob', 'bbb1');
    const m = await matchBetween(relay, a, b);
    renderWithApp(<Lobby />, { deps: makeDeps({ relay, now: realNow }), signer: { signer: a, kind: 'local' }, backedUp: true });
    const link = await screen.findByRole('link', { name: '対戦ルームへ戻る（bob さん）' });
    expect(link.getAttribute('href')).toBe(`#/match/${m.id}`);
  });

  test('search waits for saved settings and keeps the saved stage bans', async () => {
    const user = userEvent.setup();
    const relay = new MemoryRelay(realNow);
    const a = await player(relay, 'alice', 'aaa1');
    await relay.publish(await a.signEvent(buildSettings('smash_sp', { stageBans: { mario: ['smashville'] }, rangeChoice: 100, rematchHours: 3 }, realNow() - 10)));
    renderWithApp(<Lobby />, { deps: makeDeps({ relay, now: realNow }), signer: { signer: a, kind: 'local' }, backedUp: true });
    await waitFor(() => expect((screen.getByRole('button', { name: '対戦相手を探す' }) as HTMLButtonElement).disabled).toBe(false));
    await user.selectOptions(screen.getByLabelText('マッチングするレート差'), '50');
    await user.click(screen.getByRole('button', { name: '対戦相手を探す' }));
    await waitFor(() => expect(relay.all().filter((e) => e.kind === KIND.settings).length).toBe(1));
    const latest = relay.all().find((e) => e.kind === KIND.settings)!;
    expect(JSON.parse(latest.content)).toEqual({ stageBans: { mario: ['smashville'] }, rangeChoice: 50, rematchHours: 3 });
    await user.click(await screen.findByRole('button', { name: 'やめる' }));
  });

  test('pressing search twice starts only one search', async () => {
    const user = userEvent.setup();
    const relay = new MemoryRelay(realNow);
    const a = await player(relay, 'alice', 'aaa1');
    renderWithApp(<Lobby />, { deps: makeDeps({ relay, now: realNow }), signer: { signer: a, kind: 'local' }, backedUp: true });
    const button = await screen.findByRole('button', { name: '対戦相手を探す' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await user.dblClick(button);
    await screen.findByRole('button', { name: 'やめる' });
    await new Promise((r) => setTimeout(r, 1500));
    expect(new Set(relay.all().filter((e) => e.kind === KIND.recruitment).map((e) => JSON.parse(e.content).waitingSince)).size).toBe(1);
    await user.click(screen.getByRole('button', { name: 'やめる' }));
  });
});

describe('onboarding', () => {
  test('restoring from a backup with an existing profile goes straight to the lobby', async () => {
    const user = userEvent.setup();
    const relay = new MemoryRelay(realNow);
    const sk = generateSecretKey();
    const s = new LocalSigner(sk);
    await relay.publish(await s.signEvent(buildProfile({ name: 'carol' }, realNow() - 100)));
    await relay.publish(await s.signEvent(buildIdentities([{ platform: 'github', identity: 'carol', proof: 'ccc1' }], realNow() - 100)));
    location.hash = '#/onboarding';
    renderWithApp(<Onboarding />, { deps: makeDeps({ relay, now: realNow }) });
    await user.click(screen.getByRole('button', { name: 'バックアップから引き継ぐ' }));
    await user.type(screen.getByLabelText('引き継ぎコード'), encodeNsec(sk));
    await user.click(screen.getByRole('button', { name: '引き継ぐ' }));
    await waitFor(() => expect(location.hash).toBe('#/lobby'));
    expect(await isBackedUp()).toBe(true);
  });

  test('keeps other profile fields and other identity claims when publishing', async () => {
    const user = userEvent.setup();
    const relay = new MemoryRelay(realNow);
    const sk = generateSecretKey();
    const s = new LocalSigner(sk);
    await relay.publish(await s.signEvent({ kind: 0, created_at: realNow() - 100, tags: [], content: JSON.stringify({ picture: 'https://img.example/p.png', about: 'hi' }) }));
    await relay.publish(await s.signEvent({ kind: 10011, created_at: realNow() - 100, tags: [['i', 'telegram:123', 'chan/1']], content: '' }));
    const pk = await s.getPublicKey();
    const routes = gistRoutes([{ login: 'dave', gist: 'ddd1', pubkey: pk }]);
    location.hash = '#/onboarding';
    renderWithApp(<Onboarding />, { deps: makeDeps({ relay, now: realNow, routes }) });
    await user.click(screen.getByRole('button', { name: 'バックアップから引き継ぐ' }));
    await user.type(screen.getByLabelText('引き継ぎコード'), encodeNsec(sk));
    await user.click(screen.getByRole('button', { name: '引き継ぐ' }));
    await user.type(await screen.findByLabelText('表示名'), 'dave');
    await user.click(screen.getByRole('button', { name: '次へ' }));
    await user.type(await screen.findByLabelText('投稿の URL'), 'https://gist.github.com/dave/ddd1');
    await user.click(screen.getByRole('button', { name: '確認する' }));
    await screen.findByText('自動検証済み');
    await user.click(screen.getByRole('button', { name: '登録して次へ' }));
    await waitFor(() => {
      const profile = relay.all().find((e) => e.kind === 0)!;
      expect(JSON.parse(profile.content)).toEqual({ picture: 'https://img.example/p.png', about: 'hi', name: 'dave' });
      expect(relay.all().find((e) => e.kind === 10011)!.tags).toEqual([['i', 'telegram:123', 'chan/1'], ['i', 'github:dave', 'ddd1']]);
    });
    expect(npubOf(pk)).toMatch(/^npub1/);
  });
});
