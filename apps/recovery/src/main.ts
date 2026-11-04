import {
  createNostrRelayClient,
  decodeDeviceRequest,
  deviceRequestCheck,
  deviceRecordFor,
  findAccountsByNextKeys,
  isLocale,
  RecoverError,
  loadKel,
  newRecoveryWords,
  normalizeRecoveryWords,
  recoveryKey,
  recoveryRotation,
  verifyRotation,
  LOCALES,
  type DeviceRequest,
  type KelInput,
  type KelState,
  type Locale,
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

// ---- 言語 ----

/** 言語ごとの文言。英語の分は日本語の分と同じ形でないと型が通らない（apps/web/src/i18n.ts と同じ決まり） */
const messages = <T>(m: { ja: T; en: NoInfer<T> }): Record<Locale, T> => m;

const M = messages({
  ja: {
    title: '復活の道具',
    language: '言語',
    wordsPlaceholder: '12個の単語を空白か改行で区切って入力',
    relays: 'リレー（ふつうは変えません）',
    find: 'アカウントを探す',
    finding: '探しています…',
    badWords: '単語が12個そろっていないか、綴りの違う単語があります。紙を見直してください。',
    needMore: (n: number) => `このアカウントを復元するには、復活の言葉があと ${n} 枚必要です。「もう1枚入力する」から足してください。`,
    usedWords: 'この復活の言葉は、もう使えません（すでに入れ替えたあとの古い言葉です）。',
    notFound: 'この復活の言葉のアカウントが見つかりませんでした。リレーにつながっているか、単語が正しいかを確かめてください。',
    findFailed: (e: string) => `アカウントを探せませんでした: ${e}`,
    moreCard: 'もう1枚入力する（分けて保管している場合）',
    intro: 'すべての端末を失くしたときに、復活の言葉でアカウントを復元する道具です。このファイルは普段のアプリとは別の場所で開かれているので、普段のアプリのページが乗っ取られていても、復活の言葉を盗まれません。',
    warning: '復活の言葉は、この道具と、信頼できる人が配っているこの道具の写しにだけ入力してください。普段のアプリのページや、ほかのサイトには入力しないでください。',
    step1: '1. 復活の言葉',
    requestPlaceholder: 'nr-device: で始まる文字列',
    next: '次へ',
    adding: (label: string, check: string) => `追加する端末: ${label}（確認の番号 ${check}）`,
    badRequest: '端末の申請を読み取れませんでした。nr-device: から最後まで、全部を貼ってください。',
    scan: 'カメラで QR コードを読み取る',
    foundAccount: (devices: string[]) => `アカウントが見つかりました。今登録されている端末: ${devices.join('、') || 'なし'}`,
    replaceWarning: '入れ替えると、これらの端末はすべて使えなくなり、次の手順で登録する新しい端末だけが残ります。',
    step2: '2. 新しい端末の申請',
    requestHelp: '新しい端末でアプリを開き、「すでにアカウントを持っている」を選ぶと、QR コードと「端末の申請」が表示されます。QR コードを読み取るか、申請の文字列を貼ってください。',
    compareCheck: '新しい端末の画面に出ている確認の番号と同じかを確かめてから、次へ進んでください。',
    noCamera: 'カメラを使えませんでした。申請の文字列を貼ってください。',
    rotate: '書き写したので、入れ替える',
    wrongWord: '違う単語があります。新しい紙を見直してください。',
    step3: '3. 新しい復活の言葉',
    newWordsOne: (label: string) => `入れ替えると、今の復活の言葉は使えなくなります。代わりに、次の12個の単語が新しい復活の言葉になります。新しい紙に書き写してください。追加する端末: ${label}`,
    newWordsCards: (cards: number, threshold: number, label: string) =>
      `入れ替えると、今の復活の言葉は使えなくなります。代わりに、次の${cards}枚が新しい復活の言葉になります（${threshold}枚あれば復元できます）。1枚ずつ別の紙に書き写してください。追加する端末: ${label}`,
    card: (k: number) => `${k}枚目`,
    checkIntro: '書き写せたかを確かめます。次の単語を入力してください。',
    position: (pos: number) => `${pos}番目`,
    cardPosition: (card: number, pos: number) => `${card}枚目の${pos}番目`,
    rotating: '入れ替えています…',
    unverifiable: '入れ替えのイベントを確かめられませんでした',
    done: '入れ替えました',
    doneDevice: (label: string) => `新しい端末（${label}）の画面が自動で進みます。進まないときは、新しい端末でアプリを開き直してください。`,
    doneOldWords: '古い復活の言葉の紙は、もう使えません。捨ててください。新しい紙は、写真やクラウドに残さず、分けた場合は別々の場所にしまってください。',
    doneHijack: '乗っ取られて復元した場合、乗っ取った人が出した対戦の結果のうち、取り消すまでの分（最大でおよそ1日分）は残ることがあります。',
    rotateFailed: (e: string) => `入れ替えられませんでした: ${e}`,
  },
  en: {
    title: 'Recovery tool',
    language: 'Language',
    wordsPlaceholder: 'Enter the 12 words, separated by spaces or line breaks',
    relays: 'Relays (usually left as is)',
    find: 'Find my account',
    finding: 'Searching…',
    badWords: 'Some of the 12 words are missing or misspelled. Check your paper again.',
    needMore: (n: number) => `To restore this account, you need ${n} more ${n === 1 ? 'card' : 'cards'} of recovery words. Add ${n === 1 ? 'it' : 'them'} with "Enter another card".`,
    usedWords: 'These recovery words can no longer be used (they are old words that have already been replaced).',
    notFound: 'No account was found for these recovery words. Check that you are connected to the relays and that the words are correct.',
    findFailed: (e: string) => `Could not search for the account: ${e}`,
    moreCard: 'Enter another card (if you keep them separately)',
    intro: 'This tool restores your account with your recovery words when you have lost all your devices. This file is opened from a different place than the usual app, so your recovery words cannot be stolen even if the usual app\'s page is taken over.',
    warning: 'Enter your recovery words only into this tool, or into a copy of it handed out by someone you trust. Do not enter them into the usual app\'s page or any other site.',
    step1: '1. Recovery words',
    requestPlaceholder: 'Text starting with nr-device:',
    next: 'Next',
    adding: (label: string, check: string) => `Device to add: ${label} (check number ${check})`,
    badRequest: 'Could not read the device request. Paste all of it, from nr-device: to the end.',
    scan: 'Scan the QR code with the camera',
    foundAccount: (devices: string[]) => `Account found. Devices registered now: ${devices.join(', ') || 'none'}`,
    replaceWarning: 'Once replaced, all of these devices stop working, and only the new device you register in the next step remains.',
    step2: '2. Request from the new device',
    requestHelp: 'Open the app on the new device and choose "I already have an account". A QR code and a "device request" appear. Scan the QR code or paste the request text.',
    compareCheck: 'Before going on, check that the number matches the check number shown on the new device.',
    noCamera: 'Could not use the camera. Paste the request text instead.',
    rotate: 'I wrote them down. Replace now',
    wrongWord: 'Some words do not match. Check your new paper again.',
    step3: '3. New recovery words',
    newWordsOne: (label: string) => `Once replaced, your current recovery words stop working. The 12 words below become your new recovery words. Write them down on a new sheet of paper. Device to add: ${label}`,
    newWordsCards: (cards: number, threshold: number, label: string) =>
      `Once replaced, your current recovery words stop working. The ${cards} cards below become your new recovery words (any ${threshold} of them can restore the account). Write each card on a separate sheet of paper. Device to add: ${label}`,
    card: (k: number) => `Card ${k}`,
    checkIntro: 'Let\'s check that you wrote them down. Enter the following words.',
    position: (pos: number) => `Word ${pos}`,
    cardPosition: (card: number, pos: number) => `Card ${card}, word ${pos}`,
    rotating: 'Replacing…',
    unverifiable: 'Could not verify the replacement event',
    done: 'Replaced',
    doneDevice: (label: string) => `The screen on the new device (${label}) moves on by itself. If it does not, reopen the app on the new device.`,
    doneOldWords: 'The paper with your old recovery words can no longer be used. Throw it away. Do not keep photos or cloud copies of the new paper, and if you split the words into cards, store them in different places.',
    doneHijack: 'If you restored the account after it was taken over, some match results the attacker sent before you revoked them (up to about one day) may remain.',
    rotateFailed: (e: string) => `Could not replace: ${e}`,
  },
});

/** core の入れ替えのエラー（RecoverError の code）の訳 */
const ERRORS: Record<Locale, Record<RecoverError['code'], string>> = {
  ja: {
    unverifiable_account: 'アカウントの記録を確かめられませんでした',
    words_not_usable: 'この復活の言葉では入れ替えられません（もう使えない言葉か、別のアカウントの言葉です）',
  },
  en: {
    unverifiable_account: 'Could not verify the account record',
    words_not_usable: 'These recovery words cannot replace the devices (they are no longer valid, or belong to another account)',
  },
};

const LOCALE_KEY = 'nostr-rating:locale';
const LOCALE_NAMES: Record<Locale, string> = { ja: '日本語', en: 'English' };

/** 選んだ言語 → ブラウザの言語の順。file:// では保存できないことがあるので、そのときはブラウザの言語で決める */
function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // ブラウザの言語で決める
  }
  for (const l of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    const base = l?.toLowerCase().split('-')[0];
    if (isLocale(base)) return base;
  }
  return 'en';
}

let locale: Locale = initialLocale();
let t = M[locale];
/** 今の画面を、入力した値を残したまま今の言語で作り直す（言語を切り替えたとき） */
let rerender: () => void = () => {};

function applyLocale() {
  t = M[locale];
  document.documentElement.lang = locale;
  document.title = `${t.title} | Nostr-Rating`;
}
applyLocale();

function setLocale(l: Locale) {
  locale = l;
  try {
    localStorage.setItem(LOCALE_KEY, l);
  } catch {
    // 次に開いたときはブラウザの言語に戻る
  }
  applyLocale();
  rerender();
}

function errorText(e: unknown): string {
  if (e instanceof RecoverError) return ERRORS[locale][e.code];
  return e instanceof Error ? e.message : String(e);
}

interface Found {
  aid: string;
  state: KelState;
  chain: KelInput[];
  signers: Uint8Array[];
}

let relay: RelayClient | null = null;
let found: Found | null = null;
let request: DeviceRequest | null = null;
/** 新しい復活の言葉。前と同じ枚数としきい値で作る */
let newWords: string[] = [];
/** 申請を読み取っているカメラ。次の画面へ移るときに消す */
let camera: MediaStream | null = null;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  Object.assign(el, props);
  el.append(...children);
  return el;
}

function show(...nodes: Node[]) {
  camera?.getTracks().forEach((t) => t.stop());
  camera = null;
  const select = h('select', { className: 'locale-select' }, ...LOCALES.map((l) => h('option', { value: l, lang: l }, LOCALE_NAMES[l])));
  select.setAttribute('aria-label', t.language);
  select.value = locale;
  select.onchange = () => setLocale(select.value as Locale);
  app.replaceChildren(
    h('header', {}, h('div', { className: 'top' }, h('p', { className: 'app' }, 'NOSTR-RATING'), select), h('h1', {}, t.title)),
    ...nodes,
  );
}

/** 画面の最後に置くエラーの欄。画面を作り直すと入力が消えるので、この欄の文字だけを変える */
function errorSlot(): HTMLElement {
  return h('p', { className: 'error', role: 'alert' });
}

function relayList(): string[] {
  const el = document.getElementById('relays') as HTMLTextAreaElement | null;
  const list = (el?.value ?? relays.relays.join('\n')).split('\n').map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : relays.relays;
}

// ---- 1. 復活の言葉 ----

function stepWords(keep: { words: string[]; relays: string } = { words: [''], relays: relays.relays.join('\n') }) {
  const cards = h('div', { className: 'stack' });
  const addCard = (value = '') => cards.append(h('textarea', { rows: 3, autocomplete: 'off', spellcheck: false, className: 'words-input', placeholder: t.wordsPlaceholder, value }));
  keep.words.forEach((w) => addCard(w));
  const relaysInput = h('textarea', { id: 'relays', rows: 4, value: keep.relays });
  const relaysBox = h('details', {}, h('summary', {}, t.relays), relaysInput);
  const go = h('button', { className: 'primary', textContent: t.find });
  const status = errorSlot();
  const fail = (text: string) => {
    status.textContent = text;
    go.disabled = false;
    go.textContent = t.find;
  };
  go.onclick = async () => {
    status.textContent = '';
    const inputs = [...cards.querySelectorAll('textarea')].map((t) => t.value).filter((v) => v.trim() !== '');
    const normalized = inputs.map(normalizeRecoveryWords);
    if (normalized.length === 0 || normalized.some((w) => w === null)) return fail(t.badWords);
    go.disabled = true;
    go.textContent = t.finding;
    try {
      relay?.close();
      relay = createNostrRelayClient(relayList());
      const keys = normalized.map((w) => recoveryKey(w!));
      const aids = await findAccountsByNextKeys(relay, keys.map((k) => k.pub));
      for (const aid of aids) {
        const { state, chain } = await loadKel(relay, aid, Math.floor(Date.now() / 1000));
        if (state && !state.abandoned && keys.some((k) => state.next.keys.includes(k.pub))) {
          found = { aid, state, chain, signers: keys.map((k) => k.sk) };
          const usable = keys.filter((k) => state.next.keys.includes(k.pub)).length;
          if (usable < state.next.threshold) return fail(t.needMore(state.next.threshold - usable));
          return stepRequest();
        }
      }
      fail(aids.length > 0 ? t.usedWords : t.notFound);
    } catch (e) {
      fail(t.findFailed(errorText(e)));
    }
  };
  const more = h('button', { textContent: t.moreCard });
  more.onclick = () => addCard();
  rerender = () => stepWords({ words: [...cards.querySelectorAll('textarea')].map((x) => x.value), relays: relaysInput.value });
  show(
    h('p', {}, t.intro),
    h('p', { className: 'notice' }, t.warning),
    h('h2', {}, t.step1),
    cards,
    more,
    relaysBox,
    go,
    status,
  );
}

// ---- 2. 新しい端末の申請 ----

function stepRequest(keep = '') {
  const f = found!;
  const now = Math.floor(Date.now() / 1000);
  const devices = [...f.state.devices.values()].filter((d) => d.intervals.some((i) => i.from <= now && now < i.to));
  const input = h('textarea', { rows: 4, autocomplete: 'off', spellcheck: false, placeholder: t.requestPlaceholder, value: keep });
  const next = h('button', { className: 'primary', textContent: t.next });
  const status = errorSlot();
  const check = h('p', { className: 'slot' });
  input.oninput = () => {
    const r = decodeDeviceRequest(input.value);
    check.textContent = r ? t.adding(r.label, deviceRequestCheck(r)) : '';
  };
  input.dispatchEvent(new Event('input'));
  next.onclick = () => {
    const r = decodeDeviceRequest(input.value);
    if (!r) return void (status.textContent = t.badRequest);
    request = r;
    newWords = Array.from({ length: Math.min(found!.state.next.keys.length, 3) }, () => newRecoveryWords());
    checks = null;
    stepNewWords();
  };
  const scan = h('button', { textContent: t.scan });
  const video = h('video', { className: 'scanner', playsInline: true, muted: true, hidden: true });
  // 読み取ったら確認の番号を出して止まり、見比べてから本人が次へ進む
  scan.onclick = () => void scanInto(video, input, () => input.dispatchEvent(new Event('input')));
  rerender = () => stepRequest(input.value);
  show(
    h('p', {}, t.foundAccount(devices.map((d) => d.record.label))),
    h('p', {}, t.replaceWarning),
    h('h2', {}, t.step2),
    h('p', {}, t.requestHelp),
    scan,
    video,
    input,
    check,
    h('p', { className: 'hint' }, t.compareCheck),
    next,
    status,
  );
}

async function scanInto(video: HTMLVideoElement, input: HTMLTextAreaElement, done: () => void) {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch {
    input.placeholder = t.noCamera;
    return;
  }
  // 許可を待つ間に次の画面へ移っていたら使わない。2回押されたら、前のカメラを消してから使う
  if (!video.isConnected) return stream.getTracks().forEach((t) => t.stop());
  camera?.getTracks().forEach((t) => t.stop());
  camera = stream;
  video.srcObject = stream;
  video.hidden = false;
  await video.play();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const tick = () => {
    if (camera !== stream) return;
    if (video.videoWidth > 0) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const code = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
      if (code && decodeDeviceRequest(code.data)) {
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

/** 書き写せたかを確かめる単語の位置。言語を切り替えて画面を作り直しても変えない */
let checks: { card: number; pos: number }[] | null = null;

function stepNewWords(keep: string[] = []) {
  const cards = newWords.map((w) => w.split(' '));
  const threshold = Math.min(found!.state.next.threshold, cards.length);
  // 1枚なら3語、分けているときは1枚につき1語を確かめる
  const shuffled = () => [...Array(12).keys()].sort(() => Math.random() - 0.5);
  const asked = (checks ??= cards.length === 1 ? shuffled().slice(0, 3).sort((a, b) => a - b).map((pos) => ({ card: 0, pos })) : cards.map((_, card) => ({ card, pos: shuffled()[0]! })));
  const inputs = asked.map((_, i) => h('input', { autocomplete: 'off', autocapitalize: 'none', value: keep[i] ?? '' }));
  const go = h('button', { className: 'primary', textContent: t.rotate });
  const status = errorSlot();
  go.onclick = () => {
    status.textContent = '';
    if (!asked.every((c, i) => inputs[i]!.value.trim().toLowerCase() === cards[c.card]![c.pos])) {
      status.textContent = t.wrongWord;
      return;
    }
    void rotate(go, status, threshold);
  };
  rerender = () => stepNewWords(inputs.map((x) => x.value));
  show(
    h('h2', {}, t.step3),
    h('p', {}, cards.length === 1 ? t.newWordsOne(request!.label) : t.newWordsCards(cards.length, threshold, request!.label)),
    ...cards.flatMap((c, k) => [...(cards.length > 1 ? [h('h3', {}, t.card(k + 1))] : []), h('ol', { className: 'words' }, ...c.map((w) => h('li', {}, w)))]),
    h('p', {}, t.checkIntro),
    ...asked.map((c, i) => h('label', { className: 'stack' }, cards.length > 1 ? t.cardPosition(c.card + 1, c.pos + 1) : t.position(c.pos + 1), inputs[i]!)),
    go,
    status,
  );
}

// ---- 4. 入れ替え ----

async function rotate(button: HTMLButtonElement, status: HTMLElement, threshold: number) {
  const f = found!;
  button.disabled = true;
  button.textContent = t.rotating;
  // 入れ替えの途中で言語を切り替えても、押した画面のまま待つ
  rerender = () => {};
  try {
    const at = Math.floor(Date.now() / 1000);
    const { entry, event } = recoveryRotation(f.aid, f.chain, [deviceRecordFor(request!, at)], { keys: newWords.map((w) => recoveryKey(w).pub), threshold }, f.signers, at, [request!.publisher]);
    if (!verifyRotation(f.aid, f.chain, entry, event.created_at)) throw new Error(t.unverifiable);
    await relay!.publish(event);
    stepDone();
  } catch (e) {
    status.textContent = t.rotateFailed(errorText(e));
    button.disabled = false;
    button.textContent = t.rotate;
    rerender = () => stepNewWords([...document.querySelectorAll<HTMLInputElement>('label input')].map((x) => x.value));
  }
}

function stepDone() {
  rerender = stepDone;
  show(h('h2', {}, t.done), h('p', {}, t.doneDevice(request!.label)), h('p', {}, t.doneOldWords), h('p', {}, t.doneHijack));
}

stepWords();
