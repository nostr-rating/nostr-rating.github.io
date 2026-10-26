import { buildIdentities, KIND, LocalSigner, MemoryRelay } from '@nostr-rating/core';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { generateSecretKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, test } from 'vitest';
import { Lobby } from '../src/pages/Lobby.js';
import { Ranking } from '../src/pages/Ranking.js';
import { makeDeps, renderWithApp } from './helpers.js';

afterEach(cleanup);

const realNow = () => Math.floor(Date.now() / 1000);

async function userWithIdentity(relay: MemoryRelay) {
  const signer = new LocalSigner(generateSecretKey());
  await relay.publish(await signer.signEvent(buildIdentities([{ platform: 'github', identity: 'u', proof: 'abc' }], realNow() - 100)));
  return signer;
}

describe('Lobby', () => {
  test('two lobbies on the same relay end up in the same match room', async () => {
    const user = userEvent.setup();
    const relay = new MemoryRelay(realNow);
    const [a, b] = [await userWithIdentity(relay), await userWithIdentity(relay)];
    const viewA = renderWithApp(<Lobby />, { deps: makeDeps({ relay, now: realNow }), signer: { signer: a, kind: 'local' }, backedUp: true });
    const viewB = renderWithApp(<Lobby />, { deps: makeDeps({ relay, now: realNow }), signer: { signer: b, kind: 'local' }, backedUp: true });
    const inA = within(viewA.container);
    const inB = within(viewB.container);

    await user.selectOptions(await inA.findByLabelText('1戦目に使うキャラ'), 'mario');
    await user.click(await inA.findByRole('button', { name: '対戦相手を探す' }));
    expect(await inA.findByText(/待機中/)).toBeTruthy();
    await user.selectOptions(await inB.findByLabelText('1戦目に使うキャラ'), 'fox');
    await user.click(await inB.findByRole('button', { name: '対戦相手を探す' }));

    await waitFor(() => expect(relay.all().filter((e) => e.kind === KIND.match)).toHaveLength(1), { timeout: 15_000 });
    const matchId = relay.all().find((e) => e.kind === KIND.match)!.id;
    await waitFor(() => {
      expect(inA.queryByRole('button', { name: 'やめる' })).toBeNull();
      expect(inB.queryByRole('button', { name: 'やめる' })).toBeNull();
    }, { timeout: 15_000 });
    expect(location.hash).toBe(`#/match/${matchId}`);
  }, 30_000);

  test('cancelling stops waiting', async () => {
    const user = userEvent.setup();
    const relay = new MemoryRelay(realNow);
    const a = await userWithIdentity(relay);
    renderWithApp(<Lobby />, { deps: makeDeps({ relay, now: realNow }), signer: { signer: a, kind: 'local' }, backedUp: true });
    await user.click(await screen.findByRole('button', { name: '対戦相手を探す' }));
    expect(await screen.findByText(/待機中/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'やめる' }));
    expect(await screen.findByRole('button', { name: '対戦相手を探す' })).toBeTruthy();
  }, 15_000);

  test('search is disabled until an SNS account is linked', async () => {
    const relay = new MemoryRelay(realNow);
    const signer = new LocalSigner(generateSecretKey());
    renderWithApp(<Lobby />, { deps: makeDeps({ relay, now: realNow }), signer: { signer, kind: 'local' }, backedUp: true });
    await waitFor(() => expect((screen.getByRole('button', { name: '対戦相手を探す' }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText('対戦するには SNS アカウントの紐づけが必要です。')).toBeTruthy();
  });

  test('backup reminder is shown for an app key that is not backed up', async () => {
    const relay = new MemoryRelay(realNow);
    const signer = await userWithIdentity(relay);
    renderWithApp(<Lobby />, { deps: makeDeps({ relay, now: realNow }), signer: { signer, kind: 'local' }, backedUp: false });
    await waitFor(() =>
      expect(document.querySelector('.notice')?.textContent).toBe(
        '引き継ぎコードをまだ保存していません。機種変更やブラウザのデータ削除で戦績が消えないよう、設定画面から保存してください。',
      ),
    );
  });
});

describe('Lobby near the season end', () => {
  test('does not start matches whose report deadline would fall after the season end', async () => {
    const end = 1_798_729_200; // シーズン1の終わり（2027-01-01 JST）
    const now = () => end - 3600;
    const relay = new MemoryRelay(now);
    const signer = new LocalSigner(generateSecretKey());
    await relay.publish(await signer.signEvent(buildIdentities([{ platform: 'github', identity: 'u', proof: 'abc' }], now() - 100)));
    renderWithApp(<Lobby />, { deps: makeDeps({ relay, now }), signer: { signer, kind: 'local' }, backedUp: true });
    expect(await screen.findByText('シーズン 1 は 1/1 0:00 に終わります。結果報告の締め切りがシーズン内に収まらないため、新しい対戦はシーズン 2 から受け付けます。')).toBeTruthy();
    expect((screen.getByRole('button', { name: '対戦相手を探す' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Ranking', () => {
  test('shows an empty state without rated players', async () => {
    renderWithApp(<Ranking />);
    expect(await screen.findByText('まだ対戦記録がありません。')).toBeTruthy();
  });
});
