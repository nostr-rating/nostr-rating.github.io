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
  type DeviceRequest,
  type KelInput,
  type KelState,
  type RelayClient,
} from '@nostr-rating/core';
import jsQR from 'jsqr';
import relays from '../../../configs/relays.json';
import './style.css';

/**
 * 復活の道具。普段のアプリとは別の場所（file://）で、復活の言葉を使って端末を入れ替える。
 * 手順: 言葉を入れる → アカウントを探す → 新しい端末の申請を読む → 新しい言葉を書き写す → 入れ替える
 */

const app = document.getElementById('app')!;

interface Found {
  aid: string;
  state: KelState;
  chain: KelInput[];
  signers: Uint8Array[];
}

let relay: RelayClient | null = null;
let found: Found | null = null;
let request: DeviceRequest | null = null;
let newWords: string | null = null;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  Object.assign(el, props);
  el.append(...children);
  return el;
}

function show(...nodes: Node[]) {
  app.replaceChildren(
    h('header', {}, h('p', { className: 'app' }, 'NOSTR-RATING'), h('h1', {}, '復活の道具')),
    ...nodes,
  );
}

function error(text: string): HTMLElement {
  return h('p', { className: 'error', role: 'alert' }, text);
}

function relayList(): string[] {
  const el = document.getElementById('relays') as HTMLTextAreaElement | null;
  const list = (el?.value ?? relays.relays.join('\n')).split('\n').map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : relays.relays;
}

// ---- 1. 復活の言葉 ----

function stepWords(message?: string) {
  const cards = h('div', { className: 'stack' });
  const addCard = () => cards.append(h('textarea', { rows: 3, autocomplete: 'off', spellcheck: false, className: 'words-input', placeholder: '12個の単語を空白か改行で区切って入力' }));
  addCard();
  const relaysBox = h('details', {}, h('summary', {}, 'リレー（ふつうは変えません）'), h('textarea', { id: 'relays', rows: 4, value: relays.relays.join('\n') }));
  const go = h('button', { className: 'primary', textContent: 'アカウントを探す' });
  go.onclick = async () => {
    const inputs = [...cards.querySelectorAll('textarea')].map((t) => t.value).filter((v) => v.trim() !== '');
    const normalized = inputs.map(normalizeRecoveryWords);
    if (normalized.length === 0 || normalized.some((w) => w === null)) return stepWords('単語が12個そろっていないか、綴りの違う単語があります。紙を見直してください。');
    go.disabled = true;
    go.textContent = '探しています…';
    try {
      relay?.close();
      relay = createNostrRelayClient(relayList());
      const keys = normalized.map((w) => recoveryKey(w!));
      const aids = await findAccountsByNextKeys(relay, keys.map((k) => k.pub));
      for (const aid of aids) {
        const { state, chain } = await loadKel(relay, aid);
        if (state && !state.abandoned && keys.some((k) => state.next.keys.includes(k.pub))) {
          found = { aid, state, chain, signers: keys.map((k) => k.sk) };
          const usable = keys.filter((k) => state.next.keys.includes(k.pub)).length;
          if (usable < state.next.threshold) return stepWords(`このアカウントを戻すには、復活の言葉があと ${state.next.threshold - usable} 枚必要です。「もう1枚入力する」から足してください。`);
          return stepRequest();
        }
      }
      stepWords(aids.length > 0 ? 'この復活の言葉は、もう使えません（すでに入れ替えたあとの古い言葉です）。' : 'この復活の言葉のアカウントが見つかりませんでした。リレーにつながっているか、単語が正しいかを確かめてください。');
    } catch (e) {
      stepWords(`アカウントを探せませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const more = h('button', { textContent: 'もう1枚入力する（分けて保管している場合）' });
  more.onclick = addCard;
  show(
    h('p', {}, 'すべての端末を失くしたときに、復活の言葉でアカウントを戻す道具です。このファイルは普段のアプリとは別の場所で開かれているので、普段のアプリのページが乗っ取られていても、復活の言葉を盗まれません。'),
    h('p', { className: 'notice' }, '復活の言葉は、この道具と、信頼できる人が配っているこの道具の写しにだけ入力してください。普段のアプリのページや、ほかのサイトには入力しないでください。'),
    h('h2', {}, '1. 復活の言葉'),
    cards,
    more,
    relaysBox,
    go,
    ...(message ? [error(message)] : []),
  );
}

// ---- 2. 新しい端末の申請 ----

function stepRequest(message?: string) {
  const f = found!;
  const t = Math.floor(Date.now() / 1000);
  const devices = [...f.state.devices.values()].filter((d) => d.intervals.some((i) => i.from <= t && t < i.to));
  const input = h('textarea', { rows: 4, autocomplete: 'off', spellcheck: false, placeholder: 'nr-device: で始まる文字列' });
  const next = h('button', { className: 'primary', textContent: '次へ' });
  next.onclick = () => {
    const r = decodeDeviceRequest(input.value);
    if (!r) return stepRequest('端末の申請を読み取れませんでした。nr-device: から最後まで、全部を貼ってください。');
    request = r;
    newWords = newRecoveryWords();
    stepNewWords();
  };
  const scan = h('button', { textContent: 'カメラで QR コードを読み取る' });
  const video = h('video', { className: 'scanner', playsInline: true, muted: true, hidden: true });
  scan.onclick = () => void scanInto(video, input, () => next.click());
  show(
    h('p', {}, `アカウントが見つかりました。今登録されている端末: ${devices.map((d) => d.record.label).join('、') || 'なし'}`),
    h('p', {}, '入れ替えると、これらの端末はすべて使えなくなり、次の手順で登録する新しい端末だけが残ります。'),
    h('h2', {}, '2. 新しい端末の申請'),
    h('p', {}, '新しい端末でアプリを開き、「すでにアカウントを持っている」を選ぶと、QR コードと「端末の申請」が表示されます。QR コードを読み取るか、申請の文字列を貼ってください。'),
    scan,
    video,
    input,
    next,
    ...(message ? [error(message)] : []),
  );
}

async function scanInto(video: HTMLVideoElement, input: HTMLTextAreaElement, done: () => void) {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch {
    input.placeholder = 'カメラを使えませんでした。申請の文字列を貼ってください。';
    return;
  }
  video.srcObject = stream;
  video.hidden = false;
  await video.play();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const tick = () => {
    if (video.videoWidth > 0) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const code = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
      if (code && decodeDeviceRequest(code.data)) {
        stream.getTracks().forEach((t) => t.stop());
        input.value = code.data;
        done();
        return;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---- 3. 新しい復活の言葉 ----

function stepNewWords(message?: string) {
  const list = newWords!.split(' ');
  const positions = [...Array(12).keys()].sort(() => Math.random() - 0.5).slice(0, 3).sort((a, b) => a - b);
  const inputs = positions.map(() => h('input', { autocomplete: 'off', autocapitalize: 'none' }));
  const go = h('button', { className: 'primary', textContent: '書き写したので、入れ替える' });
  go.onclick = () => {
    if (!positions.every((p, i) => inputs[i]!.value.trim().toLowerCase() === list[p])) {
      return stepNewWords('違う単語があります。新しい紙を見直してください。');
    }
    void rotate(go);
  };
  show(
    h('h2', {}, '3. 新しい復活の言葉'),
    h('p', {}, `入れ替えると、今の復活の言葉は使えなくなります。代わりに、次の12個の単語が新しい復活の言葉になります。新しい紙に書き写してください。追加する端末: ${request!.label}`),
    h('ol', { className: 'words' }, ...list.map((w) => h('li', {}, w))),
    h('p', {}, '書き写せたかを確かめます。次の番号の単語を入力してください。'),
    ...positions.map((p, i) => h('label', { className: 'stack' }, `${p + 1}番目`, inputs[i]!)),
    go,
    ...(message ? [error(message)] : []),
  );
}

// ---- 4. 入れ替え ----

async function rotate(button: HTMLButtonElement) {
  const f = found!;
  button.disabled = true;
  button.textContent = '入れ替えています…';
  try {
    const at = Math.floor(Date.now() / 1000);
    const { entry, event } = recoveryRotation(f.state, [deviceRecordFor(request!, at)], { keys: [recoveryKey(newWords!).pub], threshold: 1 }, f.signers, at, [request!.publisher]);
    if (!verifyRotation(f.aid, f.chain, entry, event.created_at)) throw new Error('入れ替えのイベントを確かめられませんでした');
    await relay!.publish(event);
    show(
      h('h2', {}, '入れ替えました'),
      h('p', {}, `新しい端末（${request!.label}）の画面が自動で進みます。進まないときは、新しい端末でアプリを開き直してください。`),
      h('p', {}, '古い復活の言葉の紙は、もう使えません。捨ててください。新しい紙は、写真やクラウドに残さずしまってください。'),
      h('p', {}, '乗っ取られて戻した場合、乗っ取った人が出した対戦の結果のうち、取り消すまでの分（最大でおよそ1日分）は残ることがあります。'),
    );
  } catch (e) {
    stepNewWords(`入れ替えられませんでした: ${e instanceof Error ? e.message : String(e)}`);
  }
}

stepWords();
