import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const RELAY = process.env.E2E_RELAY ?? 'ws://localhost:7777';
const REPO = resolve(import.meta.dirname, '../../..');

/** 表示された12語を読み、確認で聞かれた番号の単語を入れる。読んだ12語を返す */
async function writeDownWords(page: Page): Promise<string[]> {
  const items = page.getByTestId('recovery-words').getByRole('listitem');
  // allTextContents は待たないので、12語が出るのを待ってから読む
  await expect(items).toHaveCount(12);
  const words = await items.allTextContents();
  await page.getByRole('button', { name: '書き写した' }).click();
  for (const input of await page.getByLabel(/番目/).all()) {
    const label = await input.evaluate((el) => el.closest('label')?.textContent ?? '');
    await input.fill(words[Number(label.match(/(\d+)番目/)![1]) - 1]!);
  }
  await page.getByRole('button', { name: '確かめる' }).click();
  return words;
}

/** はじめに画面を通す。GitHub の Gist API は応答を差し替えて、確認済みにする */
async function onboard(page: Page, name: string, gistUser: string): Promise<string[]> {
  await page.goto('/');
  await page.getByRole('button', { name: 'この端末で始める' }).click();
  const words = await writeDownWords(page);
  await page.getByLabel('表示名').fill(name);
  await page.getByRole('button', { name: '次へ' }).click();
  const text = (await page.getByTestId('verification-text').textContent()) ?? '';
  await page.route('https://api.github.com/gists/**', (route) =>
    route.fulfill({ json: { owner: { login: gistUser }, files: { 'nostr.txt': { content: text } } } }),
  );
  await page.getByLabel('投稿の URL').fill(`https://gist.github.com/${gistUser}/e2e${Date.now()}`);
  await page.getByRole('button', { name: '確認する' }).click();
  await expect(page.getByText('確認済み')).toBeVisible();
  await page.getByRole('button', { name: '登録して次へ' }).click();
  await expect(page).toHaveURL(/#\/lobby$/);
  return words;
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

  // 部屋を立てるのは P1 の側。どちらが P1 かはマッチの id で決まる
  await expect(a.getByTestId('my-side')).toHaveText(/^あなたは「P[12]」です/);
  const aIsP1 = ((await a.getByTestId('my-side').textContent()) ?? '').startsWith('あなたは「P1」');
  const [host, guest] = aIsP1 ? [a, b] : [b, a];
  await expect(guest.getByTestId('my-side')).toHaveText('あなたは「P2」です（相手は「P1」）。');
  const password = await host.getByLabel('パスワード').inputValue();
  expect(password).toMatch(/^[0-9]{4}$/);
  await host.getByLabel('部屋 ID').fill('AB12C');
  await host.getByRole('button', { name: '部屋 ID とパスワードを送る' }).click();
  await expect(guest.getByTestId('room-id')).toHaveText('AB12C', { timeout: 20_000 });
  await expect(guest.getByTestId('room-password')).toHaveText(password);

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

test('two players choose chess, exchange an invite link and settle a draw', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  for (const p of [a, b]) p.on('dialog', (d) => void d.accept());
  const suffix = Date.now().toString(36);
  await onboard(a, `シロ${suffix}`, `shiro${suffix}`);
  await onboard(b, `クロ${suffix}`, `kuro${suffix}`);

  for (const p of [a, b]) {
    await p.getByLabel('ゲーム').selectOption('chess');
    await expect(p.getByLabel('1戦目に使うキャラ')).toHaveCount(0);
    await p.getByRole('button', { name: '対戦相手を探す' }).click();
  }
  await expect(a).toHaveURL(/#\/match\/[0-9a-f]{64}$/, { timeout: 30_000 });
  await expect(b).toHaveURL(/#\/match\/[0-9a-f]{64}$/, { timeout: 30_000 });

  await expect(a.getByTestId('my-side')).toHaveText(/^あなたは「[白黒]」です/);
  const aIsWhite = ((await a.getByTestId('my-side').textContent()) ?? '').startsWith('あなたは「白」');
  const [white, black] = aIsWhite ? [a, b] : [b, a];
  await white.getByLabel('招待リンク').fill('https://chess.example/invite/e2e');
  await white.getByRole('button', { name: '招待リンクを送る' }).click();
  await expect(black.getByTestId('invite-host')).toHaveText('chess.example', { timeout: 20_000 });

  await white.getByRole('button', { name: '引き分け', exact: true }).click();
  await black.getByRole('button', { name: '引き分け', exact: true }).click();
  for (const p of [a, b]) await expect(p.getByTestId('report-status')).toHaveText('結果が確定しました（引き分け）', { timeout: 20_000 });

  await ctxA.close();
  await ctxB.close();
});

test('a second device is added by pasting its request, and the first device revokes it', async ({ browser }) => {
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const first = await ctx1.newPage();
  const second = await ctx2.newPage();
  first.on('dialog', (d) => void d.accept());
  const suffix = Date.now().toString(36);
  await onboard(first, `カオリ${suffix}`, `kaori${suffix}`);

  await second.goto('/');
  await second.getByRole('button', { name: 'すでにアカウントを持っている' }).click();
  await expect(second.getByRole('img', { name: '端末の申請の QR コード' })).toBeVisible();
  const request = (await second.getByTestId('device-request').textContent()) ?? '';
  expect(request).toMatch(/^nr-device:/);

  await first.goto('/#/settings');
  await first.getByLabel('端末の申請').fill(request);
  await first.getByRole('button', { name: 'この端末を追加' }).click();
  // 表示名と紐づけがあるアカウントなので、2台目はそのままロビーへ進む
  await expect(second).toHaveURL(/#\/lobby$/, { timeout: 20_000 });
  await expect(second.getByText(`カオリ${suffix}`)).toBeVisible({ timeout: 20_000 });

  // 1台目から2台目を取り消すと、2台目は開き直したときに使えないと分かる
  const devices = first.getByTestId('devices');
  await expect(devices.getByRole('listitem')).toHaveCount(2);
  await devices.getByRole('button', { name: '取り消す' }).click();
  await expect(devices.getByRole('listitem')).toHaveCount(1, { timeout: 20_000 });
  await second.reload();
  await expect(second.getByText('この端末の登録は取り消されたか、期限が切れています', { exact: false })).toBeVisible({ timeout: 20_000 });

  await ctx1.close();
  await ctx2.close();
});

test('the recovery tool moves the account to a new device and the old device stops working', async ({ browser }) => {
  execSync('npm run -s recovery:build', { cwd: REPO, stdio: 'ignore' });
  const toolUrl = `file://${REPO}/apps/recovery/dist/nostr-rating-recovery.html`;
  const ctxOld = await browser.newContext();
  const ctxNew = await browser.newContext();
  const ctxTool = await browser.newContext();
  const old = await ctxOld.newPage();
  const fresh = await ctxNew.newPage();
  const tool = await ctxTool.newPage();
  const suffix = Date.now().toString(36);
  const words = await onboard(old, `リク${suffix}`, `riku${suffix}`);

  // 新しい端末で申請を出す
  await fresh.goto('/');
  await fresh.getByRole('button', { name: 'すでにアカウントを持っている' }).click();
  await expect(fresh.getByTestId('device-request')).toHaveText(/^nr-device:/);
  const request = (await fresh.getByTestId('device-request').textContent()) ?? '';

  const openTool = async () => {
    await tool.goto(toolUrl);
    await tool.getByText('リレー（ふつうは変えません）').click();
    await tool.locator('#relays').fill(RELAY);
    await tool.locator('textarea.words-input').fill(words.join(' '));
    await tool.getByRole('button', { name: 'アカウントを探す' }).click();
  };

  // 復活の道具（ダウンロードした HTML を file:// で開いたもの）で入れ替える
  await openTool();
  await expect(tool.getByText('アカウントが見つかりました', { exact: false })).toBeVisible({ timeout: 20_000 });
  await tool.getByPlaceholder('nr-device: で始まる文字列').fill(request);
  await tool.getByRole('button', { name: '次へ' }).click();
  await expect(tool.locator('ol.words li')).toHaveCount(12);
  const newWords = await tool.locator('ol.words li').allTextContents();
  for (const label of await tool.locator('label').all()) {
    const n = Number(((await label.textContent()) ?? '').match(/(\d+)番目/)![1]);
    await label.locator('input').fill(newWords[n - 1]!);
  }
  await tool.getByRole('button', { name: '書き写したので、入れ替える' }).click();
  await expect(tool.getByRole('heading', { name: '入れ替えました' })).toBeVisible({ timeout: 20_000 });

  // 新しい端末はロビーへ進み、古い端末は使えなくなる
  await expect(fresh).toHaveURL(/#\/lobby$/, { timeout: 20_000 });
  await old.reload();
  await expect(old.getByText('この端末の登録は取り消されたか、期限が切れています', { exact: false })).toBeVisible({ timeout: 20_000 });

  // 古い言葉では、もう入れ替えられない
  await openTool();
  await expect(tool.getByText('この復活の言葉は、もう使えません', { exact: false })).toBeVisible({ timeout: 20_000 });

  await ctxOld.close();
  await ctxNew.close();
  await ctxTool.close();
});
