import {
  buildAccountInfo,
  KIND,
  newRecoveryWords,
  parseAccountInfo,
  parseProofUrl,
  verificationText,
  verifyClaim,
  type IdentityClaim,
  type Pubkey,
  type VerifyStatus,
} from '@nostr-rating/core';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Account, decodeDeviceRequest, deviceRequestCheck } from '../account/account.js';
import { connectExternal, type ExternalDevice } from '../account/external.js';
import { CopyButton } from '../components/CopyButton.js';
import { Dock } from '../components/Dock.js';
import { StatusBadge } from '../components/IdentityBadge.js';
import { QrCode } from '../components/QrCode.js';
import { RecoveryWords } from '../components/RecoveryWords.js';
import { helpPage, messages, tr, useLocale, useT } from '../i18n.js';
import { navigate } from '../router.js';
import { recoveryLink } from '../recoveryLink.js';
import { useApp } from '../state/AppContext.js';

const M = messages({
  ja: {
    phone: 'スマホ',
    tablet: 'タブレット',
    computer: 'パソコン',
    requestFailed: (e: string) => `端末の申請を作れませんでした: ${e}`,
    signerFailed: (e: string) => `署名アプリにつなげませんでした: ${e}`,
    signerDevice: (kind: string) => `署名アプリ（${kind}）`,
    startFailed: '始められませんでした。電波のよい場所でもう一度押してください。',
    confirmStartOver: 'この端末のアカウントを消して、最初からやり直しますか？いまの復活の言葉は使えなくなります。',
    saveFailed: '保存できませんでした。電波のよい場所でもう一度押してください。',
    badUrl: '対応していない URL です。X の投稿か GitHub の Gist の URL を入力してください。',
    registerFailed: '登録できませんでした。電波のよい場所でもう一度押してください。',
    loading: '読み込み中…',
    welcome: 'Nostr-Rating へようこそ',
    intro: '運営のいない、1対1の対戦ゲームのレート戦です。対戦結果は誰でも確かめられる形で公開されます。個人情報は預かりません。ゲームは始めたあとに画面の上で選べます。',
    startHere: 'この端末で始める',
    haveAccount: 'すでにアカウントを持っている',
    useSigner: '署名アプリを使う（Nostr に詳しい人向け）',
    verbStart: '始める',
    protect: 'アカウントの守り方',
    recoveryWords: '復活の言葉',
    confirmSkip: '復活の言葉を書き写さずに始めますか？端末を全部失くすと、このアカウントは復元できません。',
    registerThis: 'この端末を登録する',
    joinIntro: '登録済みの端末で、設定の「QR を読み取る」からこの QR コードを読み取ってください。読み取れないときは、下の「端末の申請」をコピーして貼ってください。登録が終わると、この画面は自動で進みます。',
    requestQr: '端末の申請の QR コード',
    creating: '作成中…',
    request: '端末の申請',
    checkNumber: '確認の番号: ',
    checkHint: '登録する側の画面にも同じ番号が出ます。違っていたら、その申請は追加しないでください。',
    copyRequest: '申請をコピー',
    pasteWhere: '文字列を貼る場所は、次のどちらかです。',
    pasteDevice: '登録済みの端末: 設定の「端末を追加」',
    pasteRecovery: '端末を全部失くしたとき: 復活の道具',
    recoveryDownload: (link: ReactNode) => <>復活の道具は{link}からダウンロードします。</>,
    releasePage: 'リリースのページ',
    waiting: '登録を待っています…',
    joinSigner: 'この端末の鍵に署名アプリを使う（Nostr に詳しい人向け）',
    verbRecreate: '申請を作り直す',
    back: '戻る',
    displayName: '表示名',
    nameHint: '対戦相手とランキングに表示される名前です。',
    next: '次へ',
    linkTitle: 'X か GitHub の紐づけ',
    linkIntro: '次の文をそのまま X に投稿するか、GitHub の公開の Gist に貼り、その URL を入力してください。紐づけのないアカウントはレート戦に参加できません。同じ X や GitHub を紐づけたアカウントは、同じ人のものとして表示します。文は英語のまま投稿してください。投稿や Gist は、紐づけのあとも消さないでください。',
    copyText: '文をコピー',
    proofUrl: '投稿の URL',
    check: '確認する',
    registerNext: '登録して次へ',
    changeName: '表示名を変える',
    startOver: '最初からやり直す',
    signerIntro: '端末の鍵を、このブラウザではなく署名アプリに持たせます。鍵はこのページの外にあるので、ページが乗っ取られても持ち出されません。',
    withNip07: (verb: string) => `ブラウザ拡張（NIP-07）で${verb}`,
    bunker: 'リモート署名の接続先',
    bunkerHint: 'bunker:// で始まる文字列を貼ってください。',
    withNip46: (verb: string) => `リモート署名（NIP-46）で${verb}`,
  },
  en: {
    phone: 'Phone',
    tablet: 'Tablet',
    computer: 'Computer',
    requestFailed: (e: string) => `Could not create the device request: ${e}`,
    signerFailed: (e: string) => `Could not connect to the signer app: ${e}`,
    signerDevice: (kind: string) => `Signer app (${kind})`,
    startFailed: 'Could not start. Move to a place with a better connection and try again.',
    confirmStartOver: 'Delete the account on this device and start over? Your current recovery words will no longer work.',
    saveFailed: 'Could not save. Move to a place with a better connection and try again.',
    badUrl: 'This URL is not supported. Enter the URL of a post on X or a GitHub Gist.',
    registerFailed: 'Could not register. Move to a place with a better connection and try again.',
    loading: 'Loading…',
    welcome: 'Welcome to Nostr-Rating',
    intro: 'Rated 1v1 matches for competitive games, with no operator. Match results are published so that anyone can verify them. No personal information is collected. You can choose a game at the top of the screen after you start.',
    startHere: 'Start on this device',
    haveAccount: 'I already have an account',
    useSigner: 'Use a signer app (for Nostr users)',
    verbStart: 'Start',
    protect: 'How to protect your account',
    recoveryWords: 'Recovery words',
    confirmSkip: 'Start without writing down your recovery words? If you lose all your devices, this account cannot be restored.',
    registerThis: 'Register this device',
    joinIntro: 'On a registered device, open "Scan QR code" in Settings and scan this QR code. If you cannot scan it, copy the device request below and paste it. This screen continues automatically once registration is done.',
    requestQr: 'QR code of the device request',
    creating: 'Creating…',
    request: 'Device request',
    checkNumber: 'Check number: ',
    checkHint: 'The same number appears on the registering device. If it differs, do not add that request.',
    copyRequest: 'Copy request',
    pasteWhere: 'Paste the text in one of these places:',
    pasteDevice: 'A registered device: "Add a device" in Settings',
    pasteRecovery: 'If you lost all your devices: the recovery tool',
    recoveryDownload: (link: ReactNode) => <>Download the recovery tool from the {link}.</>,
    releasePage: 'releases page',
    waiting: 'Waiting for registration…',
    joinSigner: 'Use a signer app for this device key (for Nostr users)',
    verbRecreate: 'Recreate the request',
    back: 'Back',
    displayName: 'Display name',
    nameHint: 'The name shown to opponents and in the ranking.',
    next: 'Next',
    linkTitle: 'Link X or GitHub',
    linkIntro: 'Post the following text as is on X, or paste it into a public GitHub Gist, then enter its URL. Accounts without a linked account cannot join rated matches. Accounts linked to the same X or GitHub account are shown as belonging to the same person. Do not delete the post or Gist after linking.',
    copyText: 'Copy text',
    proofUrl: 'Post URL',
    check: 'Check',
    registerNext: 'Register and continue',
    changeName: 'Change display name',
    startOver: 'Start over',
    signerIntro: 'Keep the device key in a signer app instead of this browser. The key stays outside this page, so it cannot be taken even if the page is compromised.',
    withNip07: (verb: string) => `${verb} with a browser extension (NIP-07)`,
    bunker: 'Remote signer address',
    bunkerHint: 'Paste the text starting with bunker://.',
    withNip46: (verb: string) => `${verb} with a remote signer (NIP-46)`,
  },
});


type Step = 'checking' | 'start' | 'words' | 'join' | 'name' | 'identity';

/** この端末の名前の既定値（端末の一覧で見分けるため） */
function defaultDeviceLabel(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/iPhone|Android.*Mobile/.test(ua)) return tr(M).phone;
  if (/iPad|Android/.test(ua)) return tr(M).tablet;
  return tr(M).computer;
}

export function Onboarding() {
  const app = useApp();
  const t = useT(M);
  const l = useLocale();
  const [step, setStep] = useState<Step>(app.account ? 'checking' : 'start');
  /** 書き写している復活の言葉（1枚ずつ改行で区切る）。端末には保存せず、確かめてからアカウントを作る */
  const [words, setWords] = useState<string | null>(null);
  /** 作るアカウントの端末の名前と、端末の鍵に使う署名アプリ */
  const [device, setDevice] = useState<{ label: string; external?: ExternalDevice } | null>(null);
  const [requestCode, setRequestCode] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [claims, setClaims] = useState<IdentityClaim[]>([]);
  const [url, setUrl] = useState('');
  const [claim, setClaim] = useState<IdentityClaim | null>(null);
  const [status, setStatus] = useState<VerifyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const label = useMemo(defaultDeviceLabel, []);
  const lastPublished = useRef(0);
  const [bunker, setBunker] = useState('');
  /** 2台目・復活で、この端末の鍵に使う署名アプリ */
  const [joinExternal, setJoinExternal] = useState<ExternalDevice | undefined>(undefined);

  /** 公開済みの表示名と紐づけを見て、どの手順から始めるかを決める */
  const continueFrom = async (aid: Pubkey) => {
    let latest: { name: string; claims: IdentityClaim[]; at: number } | null = null;
    try {
      for (const ev of await app.relay.query([{ kinds: [KIND.account], '#d': [aid] }])) {
        const a = parseAccountInfo(ev, await app.author(ev));
        if (a && a.pubkey === aid && (!latest || latest.at < a.createdAt)) latest = { name: a.name, claims: a.claims, at: a.createdAt };
      }
    } catch {
      // 読めなければ最初の手順から
    }
    if (latest?.name) app.rememberProfile(aid, latest.name);
    if (latest) app.rememberIdentities(aid, latest.claims);
    setName(latest?.name ?? '');
    setClaims(latest?.claims ?? []);
    if (latest?.name && latest.claims.length > 0) navigate({ name: 'lobby' });
    else setStep(latest?.name ? 'identity' : 'name');
  };

  useEffect(() => {
    if (step === 'checking' && app.pubkey && app.signer) void continueFrom(app.pubkey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, app.pubkey, app.signer]);

  // 2台目・復活: 申請した端末が KEL に載るのを待つ
  useEffect(() => {
    if (step !== 'join') return;
    let alive = true;
    let stop = () => undefined as void;
    // 申請の鍵を作り終えてから待ち受ける（先に待つと、鍵がまだなくて何も届かない）
    void Account.prepareDevice(app.keyStore, label, joinExternal).then(
      (code) => {
        if (!alive) return;
        setRequestCode(code);
        stop = Account.waitForRegistration(app.keyStore, app.relay, app.now, (a) => {
          void app.setAccount(a).then(() => setStep('checking'));
        });
      },
      (e) => alive && setError(tr(M).requestFailed(e instanceof Error ? e.message : String(e))),
    );
    return () => {
      alive = false;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, joinExternal]);

  /** 署名アプリにつなぐ（Nostr に詳しい人向け） */
  const connect = async (kind: 'nip07' | 'nip46'): Promise<ExternalDevice | null> => {
    try {
      return (await connectExternal(kind === 'nip07' ? { kind } : { kind, bunker })).ext;
    } catch (e) {
      setError(t.signerFailed(e instanceof Error ? e.message : String(e)));
      return null;
    }
  };

  const start = async (kind?: 'nip07' | 'nip46') => {
    setBusy(true);
    setError(null);
    try {
      const external = kind ? await connect(kind) : undefined;
      if (external === null) return;
      setDevice({ label: kind ? t.signerDevice(kind === 'nip07' ? 'NIP-07' : 'NIP-46') : label, external });
      setWords(newRecoveryWords());
      setStep('words');
    } finally {
      setBusy(false);
    }
  };

  /** 書き写したと確かめたら、その言葉を次の鍵にしてアカウントを作る */
  const create = async () => {
    const cards = words!.split('\n');
    try {
      const account = await Account.create(app.keyStore, app.relay, app.now, device!.label, { cards, threshold: cards.length > 1 ? 2 : 1 }, device!.external);
      await app.setAccount(account);
    } catch {
      throw new Error(t.startFailed);
    }
    setStep('name');
  };

  /** この端末のアカウントを消して、最初の手順に戻る。リレーに出した KEL は残るが、表示名と紐づけがなければどこにも載らない */
  const startOver = async () => {
    if (!window.confirm(t.confirmStartOver)) return;
    await Account.forget(app.keyStore);
    await app.setAccount(null);
    setWords(null);
    setDevice(null);
    setName('');
    setClaims([]);
    setUrl('');
    setClaim(null);
    setStatus(null);
    setError(null);
    setStep('start');
  };

  /** 表示名と紐づけをまとめて出し直す（アカウントの公開情報は丸ごと置き換わる） */
  const publish = async (next: { name: string; claims: IdentityClaim[] }) => {
    if (!app.signer || !app.pubkey) throw new Error('not ready');
    // 置き換え可能なイベントは、同じ秒だと id の小さいほうが残る。前に出した版より必ず新しくする
    const at = Math.max(app.now(), lastPublished.current + 1);
    lastPublished.current = at;
    const ev = await app.signer.signEvent(buildAccountInfo({ pubkey: app.pubkey, ...next }, at));
    await app.relay.publish(ev);
    await app.store.put([ev]);
    app.rememberProfile(app.pubkey, next.name);
    app.rememberIdentities(app.pubkey, next.claims);
  };

  const saveName = async () => {
    setBusy(true);
    try {
      await publish({ name: name.trim(), claims });
      setStep('identity');
    } catch {
      setError(t.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    const c = parseProofUrl(url);
    setClaim(c);
    if (!c || !app.pubkey) {
      setStatus(null);
      setError(t.badUrl);
      return;
    }
    setError(null);
    setStatus(await verifyClaim(c, app.pubkey, app.fetchFn));
  };

  /** 同じサービスの紐づけだけを置き換える */
  const register = async () => {
    if (!claim) return;
    setBusy(true);
    try {
      const next = [...claims.filter((c) => c.platform !== claim.platform), claim];
      await publish({ name, claims: next });
      setClaims(next);
      navigate({ name: 'lobby' });
    } catch {
      setError(t.registerFailed);
    } finally {
      setBusy(false);
    }
  };

  /** 操作の失敗は画面の下に出す（上の要素を押し出さない）。URL の形の誤りだけは入力欄の下に出す */
  const errorSlot = error && step !== 'identity' && (
    <Dock>
      <p className="notice bad" role="alert">{error}</p>
    </Dock>
  );

  return (
    <section>
      {step === 'checking' && <p className="loading">{t.loading}</p>}

      {step === 'start' && (
        <div className="card">
          <h1>{t.welcome}</h1>
          <p>{t.intro}</p>
          <div className="stack">
            <button type="button" className="primary wide" disabled={busy} onClick={() => void start()}>
              {t.startHere}
            </button>
            <button type="button" className="wide" onClick={() => setStep('join')}>
              {t.haveAccount}
            </button>
          </div>
          {errorSlot}
          <details>
            <summary>{t.useSigner}</summary>
            <SignerChoice busy={busy} bunker={bunker} setBunker={setBunker} onChoose={(k) => void start(k)} verb={t.verbStart} />
          </details>
          <p className="muted">
            <a href={helpPage(l)}>{t.protect}</a>
          </p>
        </div>
      )}

      {step === 'words' && words && (
        <div className="card">
          <h2>{t.recoveryWords}</h2>
          <RecoveryWords
            key={words}
            words={words}
            onConfirmed={create}
            onSplit={() => setWords(Array.from({ length: 3 }, () => newRecoveryWords()).join('\n'))}
            onSkip={async () => {
              if (window.confirm(t.confirmSkip)) await create();
            }}
          />
        </div>
      )}

      {step === 'join' && (
        <div className="card">
          <h2>{t.registerThis}</h2>
          <p>{t.joinIntro}</p>
          {requestCode ? <QrCode text={requestCode} label={t.requestQr} /> : <div className="qr">{t.creating}</div>}
          <div className="field">
            <span className="label">{t.request}</span>
            <p className="code-box" data-testid="device-request">{requestCode ?? t.creating}</p>
          </div>
          <p data-testid="device-check">
            {t.checkNumber}<strong>{requestCode ? deviceRequestCheck(decodeDeviceRequest(requestCode)!) : t.creating}</strong>
          </p>
          <p className="hint">{t.checkHint}</p>
          <CopyButton text={requestCode}>{t.copyRequest}</CopyButton>
          <div className="stack">
            <p>{t.pasteWhere}</p>
            <ul>
              <li>{t.pasteDevice}</li>
              <li>{t.pasteRecovery}</li>
            </ul>
            {recoveryLink() && (
              <p className="hint">
                {t.recoveryDownload(
                  <a href={recoveryLink()!} target="_blank" rel="noopener noreferrer">
                    {t.releasePage}
                  </a>,
                )}
              </p>
            )}
          </div>
          <p className="muted" role="status">{t.waiting}</p>
          {errorSlot}
          <details>
            <summary>{t.joinSigner}</summary>
            <SignerChoice
              busy={busy}
              bunker={bunker}
              setBunker={setBunker}
              verb={t.verbRecreate}
              onChoose={(k) => {
                setError(null);
                // つなげなかったときは、今の申請を残す
                void connect(k).then((ext) => {
                  if (!ext) return;
                  setRequestCode(null);
                  setJoinExternal(ext);
                });
              }}
            />
          </details>
          <button type="button" onClick={() => setStep('start')}>{t.back}</button>
        </div>
      )}

      {step === 'name' && (
        <div className="card">
          <h2>{t.displayName}</h2>
          <div className="field">
            <label htmlFor="name">{t.displayName}</label>
            <input id="name" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
            <p className="hint" data-testid="name-hint">{t.nameHint}</p>
          </div>
          {errorSlot}
          <button type="button" className="primary wide" disabled={busy || name.trim() === '' || !app.signer} onClick={() => void saveName()}>
            {t.next}
          </button>
        </div>
      )}

      {step === 'identity' && app.pubkey && (
        <div className="card">
          <h2>{t.linkTitle}</h2>
          <p>{t.linkIntro}</p>
          <p className="code-box" data-testid="verification-text">{verificationText(app.pubkey)}</p>
          <CopyButton text={verificationText(app.pubkey)}>{t.copyText}</CopyButton>
          <div className="field">
            <label htmlFor="proof-url">{t.proofUrl}</label>
            <input
              id="proof-url"
              inputMode="url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setStatus(null);
                setClaim(null);
              }}
            />
            <div className="slot two" data-testid="claim-status">
              {error ? <span className="error" role="alert">{error}</span> : status ? <StatusBadge status={status} /> : ''}
            </div>
          </div>
          <div className="stack">
            <button type="button" disabled={url.trim() === ''} onClick={() => void check()}>{t.check}</button>
            <button type="button" className="primary wide" disabled={busy || !claim || status !== 'verified'} onClick={() => void register()}>
              {t.registerNext}
            </button>
          </div>
        </div>
      )}

      {(step === 'words' || step === 'name' || step === 'identity') && (
        <div className="sub-actions">
          {step === 'identity' && (
            <button type="button" className="text" onClick={() => setStep('name')}>{t.changeName}</button>
          )}
          <button type="button" className="text danger" disabled={busy} onClick={() => void startOver()}>{t.startOver}</button>
        </div>
      )}
    </section>
  );
}

function SignerChoice(props: { busy: boolean; bunker: string; setBunker(v: string): void; verb: string; onChoose(kind: 'nip07' | 'nip46'): void }) {
  const t = useT(M);
  return (
    <div className="stack">
      <p className="muted">{t.signerIntro}</p>
      <button type="button" disabled={props.busy} onClick={() => props.onChoose('nip07')}>
        {t.withNip07(props.verb)}
      </button>
      <div className="field">
        <label htmlFor="bunker-url">{t.bunker}</label>
        <input id="bunker-url" autoComplete="off" placeholder="bunker://…" value={props.bunker} onChange={(e) => props.setBunker(e.target.value)} />
        <p className="hint">{t.bunkerHint}</p>
      </div>
      <button type="button" disabled={props.busy || !props.bunker.trim().startsWith('bunker://')} onClick={() => props.onChoose('nip46')}>
        {t.withNip46(props.verb)}
      </button>
    </div>
  );
}
