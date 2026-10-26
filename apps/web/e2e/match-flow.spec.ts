import { expect, test, type Page } from '@playwright/test';

/** はじめに画面を通す。GitHub の Gist API は応答を差し替えて、自動検証済みにする */
async function onboard(page: Page, name: string, gistUser: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'はじめる' }).click();
  await page.getByLabel('表示名').fill(name);
  await page.getByRole('button', { name: '次へ' }).click();
  const text = (await page.getByTestId('verification-text').textContent()) ?? '';
  await page.route('https://api.github.com/gists/**', (route) =>
    route.fulfill({ json: { owner: { login: gistUser }, files: { 'nostr.txt': { content: text } } } }),
  );
  await page.getByLabel('投稿の URL').fill(`https://gist.github.com/${gistUser}/e2e${Date.now()}`);
  await page.getByRole('button', { name: '確認する' }).click();
  await expect(page.getByText('自動検証済み')).toBeVisible();
  await page.getByRole('button', { name: '登録して次へ' }).click();
  await page.getByRole('checkbox', { name: '安全な場所に保存しました' }).check();
  await page.getByRole('button', { name: '対戦をはじめる' }).click();
  await expect(page).toHaveURL(/#\/lobby$/);
}

test('two players match, exchange the room id, play a set and confirm the result', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  // 結果報告の確認ダイアログには「OK」で答える
  for (const p of [a, b]) p.on('dialog', (d) => void d.accept());
  const suffix = Date.now().toString(36);

  await onboard(a, `アリス${suffix}`, `alice${suffix}`);
  await onboard(b, `ボブ${suffix}`, `bob${suffix}`);
  // OPFS の SQLite が使えていれば、メモリ保存の注意は出ない
  await expect(a.getByText('このブラウザでは対戦記録を保存できません', { exact: false })).toHaveCount(0);

  await a.getByLabel('1戦目に使うキャラ').selectOption('mario');
  await a.getByRole('button', { name: '対戦相手を探す' }).click();
  await expect(a.getByText(/^待機中… \d+秒/)).toBeVisible();
  await b.getByLabel('1戦目に使うキャラ').selectOption('fox');
  await b.getByRole('button', { name: '対戦相手を探す' }).click();

  await expect(a).toHaveURL(/#\/match\/[0-9a-f]{64}$/, { timeout: 30_000 });
  await expect(b).toHaveURL(/#\/match\/[0-9a-f]{64}$/, { timeout: 30_000 });
  expect(a.url().split('/match/')[1]).toBe(b.url().split('/match/')[1]);

  // 先に待っていたアリスが部屋を立てる側（プレイヤー1）
  await a.getByLabel('部屋 ID').fill('AB12C');
  await a.getByRole('button', { name: '部屋 ID を送る' }).click();
  await expect(b.getByTestId('room-id')).toHaveText('AB12C', { timeout: 20_000 });
  await expect(b.getByTestId('room-password')).toHaveText('1122');

  await a.getByRole('button', { name: '1戦目: あなたの勝ち' }).click();
  await a.getByRole('button', { name: '2戦目: あなたの勝ち' }).click();
  await expect(a.getByText('あなたが2本先取しました。結果を報告してください。')).toBeVisible();

  await a.getByRole('button', { name: '勝ち', exact: true }).click();
  await b.getByRole('button', { name: '負け', exact: true }).click();
  await expect(a.getByTestId('report-status')).toHaveText('結果が確定しました（あなたの勝ち）', { timeout: 20_000 });
  await expect(b.getByTestId('report-status')).toHaveText('結果が確定しました（相手の勝ち）', { timeout: 20_000 });

  // 確定したら対戦ルームからロビーに戻れる
  await expect(a.getByRole('link', { name: 'ロビーに戻る' })).toBeVisible();

  // ランキング（締め切り前の暫定値）でアリスのレートが上がっている。再読み込みしなくても反映される
  await a.goto('/#/ranking');
  const row = a.getByRole('row', { name: new RegExp(`アリス${suffix}`) });
  await expect(row).toBeVisible({ timeout: 20_000 });
  const rating = Number((await row.getByRole('cell').nth(2).textContent()) ?? '0');
  expect(rating).toBeGreaterThan(1500);

  await ctxA.close();
  await ctxB.close();
});
