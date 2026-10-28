import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  createNostrRelayClient,
  decodeDeviceRequest,
  deviceRecordFor,
  findAccountsByNextKeys,
  loadKel,
  newRecoveryWords,
  normalizeRecoveryWords,
  recoveryKey,
  recoveryRotation,
  verifyRotation,
} from '@nostr-rating/core';

/**
 * 復活の道具の CLI 版（docs/adr/0008「復活の道具」）。復活の言葉で、端末を新しい端末1台に入れ替える。
 * 入力した言葉は画面に残るので、使い終わったら端末の履歴とスクロールを消すこと。
 */
const root = resolve(import.meta.dirname, '../../..');
const relays = (JSON.parse(readFileSync(join(root, 'configs/relays.json'), 'utf8')) as { relays: string[] }).relays;
const rl = createInterface({ input: process.stdin, output: process.stdout });
const relay = createNostrRelayClient(process.env.RELAYS ? process.env.RELAYS.split(',') : relays);

try {
  const words: string[] = [];
  for (;;) {
    const w = normalizeRecoveryWords(await rl.question(`復活の言葉（${words.length + 1}枚目、12語）: `));
    if (!w) {
      console.log('単語が12個そろっていないか、綴りの違う単語があります。');
      continue;
    }
    words.push(w);
    if ((await rl.question('ほかにも分けて保管している言葉がありますか (y/N): ')).trim().toLowerCase() !== 'y') break;
  }
  const keys = words.map((w) => recoveryKey(w));
  const aids = await findAccountsByNextKeys(relay, keys.map((k) => k.pub));
  let found: Awaited<ReturnType<typeof loadKel>> | null = null;
  for (const aid of aids) {
    const r = await loadKel(relay, aid);
    if (r.state && !r.state.abandoned && keys.some((k) => r.state!.next.keys.includes(k.pub))) found = r;
  }
  if (!found?.state) throw new Error(aids.length > 0 ? 'この復活の言葉は、もう使えません' : 'アカウントが見つかりませんでした');
  const state = found.state;
  console.log(`アカウント: ${state.aid}`);
  console.log(`今の端末: ${[...state.devices.values()].map((d) => d.record.label).join('、')}（入れ替えると、すべて使えなくなります）`);

  const request = decodeDeviceRequest(await rl.question('新しい端末の「端末の申請」（nr-device: で始まる文字列）: '));
  if (!request) throw new Error('端末の申請を読み取れませんでした');
  const fresh = newRecoveryWords();
  console.log(`\n新しい復活の言葉（紙に書き写してください）:\n\n  ${fresh}\n`);
  if ((await rl.question('書き写したら、入れ替えるために yes と入力してください: ')).trim() !== 'yes') throw new Error('やめました');

  const at = Math.floor(Date.now() / 1000);
  const { entry, event } = recoveryRotation(state, [deviceRecordFor(request, at)], { keys: [recoveryKey(fresh).pub], threshold: 1 }, keys.map((k) => k.sk), at, [request.publisher]);
  if (!verifyRotation(state.aid, found.chain, entry, event.created_at)) throw new Error('入れ替えのイベントを確かめられませんでした');
  await relay.publish(event);
  console.log(`入れ替えました。新しい端末（${request.label}）の画面が自動で進みます。古い言葉の紙は捨ててください。`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  rl.close();
  relay.close();
}
process.exit();
