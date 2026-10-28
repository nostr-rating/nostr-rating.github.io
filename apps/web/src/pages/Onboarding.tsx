import {
  buildAccountInfo,
  KIND,
  parseAccountInfo,
  parseProofUrl,
  verificationText,
  verifyClaim,
  type IdentityClaim,
  type Pubkey,
  type VerifyStatus,
} from '@nostr-rating/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Account } from '../account/account.js';
import { connectExternal, type ExternalDevice } from '../account/external.js';
import { StatusBadge } from '../components/IdentityBadge.js';
import { QrCode } from '../components/QrCode.js';
import { RecoveryWords } from '../components/RecoveryWords.js';
import { navigate } from '../router.js';
import { useApp } from '../state/AppContext.js';

type Step = 'checking' | 'start' | 'words' | 'join' | 'name' | 'identity';

/** この端末の名前の既定値（端末の一覧で見分けるため） */
function defaultDeviceLabel(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/iPhone|Android.*Mobile/.test(ua)) return 'スマホ';
  if (/iPad|Android/.test(ua)) return 'タブレット';
  return 'パソコン';
}

export function Onboarding() {
  const app = useApp();
  const [step, setStep] = useState<Step>(app.account ? 'checking' : 'start');
  const [words, setWords] = useState<string | null>(null);
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
        const a = parseAccountInfo(app.def.id, ev, await app.author(ev));
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
    void Account.prepareDevice(app.keyStore, label, joinExternal).then((code) => {
      if (!alive) return;
      setRequestCode(code);
      stop = Account.waitForRegistration(app.keyStore, app.relay, app.now, (a) => {
        void app.setAccount(a).then(() => setStep('checking'));
      });
    });
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
      setError(`署名アプリにつなげませんでした: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  const start = async (kind?: 'nip07' | 'nip46') => {
    setBusy(true);
    setError(null);
    try {
      const external = kind ? await connect(kind) : undefined;
      if (external === null) return;
      const { account, words } = await Account.create(app.keyStore, app.relay, app.now, kind ? `署名アプリ（${kind === 'nip07' ? 'NIP-07' : 'NIP-46'}）` : label, external);
      await app.setAccount(account);
      setWords(words);
      setStep('words');
    } catch {
      setError('始められませんでした。電波のよい場所でもう一度押してください。');
    } finally {
      setBusy(false);
    }
  };

  /** 表示名と紐づけをまとめて出し直す（アカウントの公開情報は丸ごと置き換わる） */
  const publish = async (next: { name: string; claims: IdentityClaim[] }) => {
    if (!app.signer || !app.pubkey) throw new Error('not ready');
    // 置き換え可能なイベントは、同じ秒だと id の小さいほうが残る。前に出した版より必ず新しくする
    const at = Math.max(app.now(), lastPublished.current + 1);
    lastPublished.current = at;
    const ev = await app.signer.signEvent(buildAccountInfo(app.def.id, { pubkey: app.pubkey, ...next }, at));
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
      setError('保存できませんでした。電波のよい場所でもう一度押してください。');
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    const c = parseProofUrl(url);
    setClaim(c);
    if (!c || !app.pubkey) {
      setStatus(null);
      setError('対応していない URL です（X の投稿か GitHub の Gist の URL を入力してください）');
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
      setError('登録できませんでした。電波のよい場所でもう一度押してください。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      {step === 'checking' && <p className="loading">読み込み中…</p>}

      {step === 'start' && (
        <div className="card stack">
          <h1>Nostr-Rating へようこそ</h1>
          <p>運営のいない、スマブラSP のレート対戦です。対戦結果は誰でも確かめられる形で公開されます。個人情報は預かりません。</p>
          <button type="button" className="primary" disabled={busy} onClick={() => void start()}>
            この端末で始める
          </button>
          <button type="button" onClick={() => setStep('join')}>すでにアカウントを持っている</button>
          <details>
            <summary>署名アプリを使う（Nostr に詳しい人向け）</summary>
            <SignerChoice busy={busy} bunker={bunker} setBunker={setBunker} onChoose={(k) => void start(k)} verb="始める" />
          </details>
          <p className="muted">
            <a href={`${import.meta.env.BASE_URL}help/account.html`}>アカウントの守り方</a>
          </p>
        </div>
      )}

      {step === 'words' && words && (
        <div className="card stack">
          <h2>復活の言葉</h2>
          <RecoveryWords
            key={app.pendingWords ?? words}
            words={app.pendingWords ?? words}
            onConfirmed={() => void app.confirmWords().then(() => setStep('name'))}
            onLater={() => setStep('name')}
            onSplit={app.splitWords}
          />
        </div>
      )}

      {step === 'join' && (
        <div className="card stack">
          <h2>この端末を登録する</h2>
          <p>登録済みの端末で、設定の「QR を読み取る」からこの QR コードを読み取ってください。読み取れないときは、下の「端末の申請」をコピーして貼ってください。登録が終わると、この画面は自動で進みます。</p>
          {requestCode && <QrCode text={requestCode} label="端末の申請の QR コード" />}
          <p>文字列を貼る場所は、次のどちらかです。</p>
          <ul>
            <li>登録済みの端末: 設定の「端末を追加」</li>
            <li>端末を全部失くしたとき: 復活の道具</li>
          </ul>
          <p className="mono card" data-testid="device-request">{requestCode ?? '作成中…'}</p>
          <button type="button" disabled={!requestCode} onClick={() => void navigator.clipboard?.writeText(requestCode!).catch(() => undefined)}>
            申請をコピー
          </button>
          <p className="loading">登録を待っています…</p>
          <details>
            <summary>この端末の鍵に署名アプリを使う（Nostr に詳しい人向け）</summary>
            <SignerChoice
              busy={busy}
              bunker={bunker}
              setBunker={setBunker}
              verb="申請を作り直す"
              onChoose={(k) => {
                setRequestCode(null);
                void connect(k).then((ext) => ext && setJoinExternal(ext));
              }}
            />
          </details>
          <button type="button" onClick={() => setStep('start')}>戻る</button>
        </div>
      )}

      {step === 'name' && (
        <div className="card stack">
          <h2>表示名</h2>
          <label htmlFor="name">表示名</label>
          <input id="name" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
          <p className="muted">ゲーム内の名前と同じにしてください。</p>
          <button type="button" className="primary" disabled={busy || name.trim() === '' || !app.signer} onClick={() => void saveName()}>
            次へ
          </button>
        </div>
      )}

      {step === 'identity' && app.pubkey && (
        <div className="card stack">
          <h2>X か GitHub の紐づけ</h2>
          <p>
            次の文をそのまま X に投稿するか、GitHub の公開の Gist に貼り、その URL を入力してください。1人で何個もアカウントを作れないようにするためのもので、英語のまま投稿してください。投稿や Gist は、紐づけのあとも消さないでください。
          </p>
          <p className="mono card" data-testid="verification-text">{verificationText(app.pubkey)}</p>
          <button type="button" onClick={() => void navigator.clipboard?.writeText(verificationText(app.pubkey!)).catch(() => undefined)}>
            文をコピー
          </button>
          <label htmlFor="proof-url">投稿の URL</label>
          <input id="proof-url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button type="button" onClick={() => void check()}>確認する</button>
          {status && <StatusBadge status={status} />}
          <button type="button" className="primary" disabled={busy || !claim || status !== 'verified'} onClick={() => void register()}>
            登録して次へ
          </button>
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

function SignerChoice(props: { busy: boolean; bunker: string; setBunker(v: string): void; verb: string; onChoose(kind: 'nip07' | 'nip46'): void }) {
  return (
    <div className="stack">
      <p className="muted">端末の鍵を、このブラウザではなく署名アプリに持たせます。鍵はこのページの外にあるので、ページが乗っ取られても持ち出されません。</p>
      <button type="button" disabled={props.busy} onClick={() => props.onChoose('nip07')}>
        ブラウザ拡張（NIP-07）で{props.verb}
      </button>
      <label htmlFor="bunker-url">リモート署名の接続先（bunker:// で始まる文字列）</label>
      <input id="bunker-url" autoComplete="off" value={props.bunker} onChange={(e) => props.setBunker(e.target.value)} />
      <button type="button" disabled={props.busy || !props.bunker.trim().startsWith('bunker://')} onClick={() => props.onChoose('nip46')}>
        リモート署名（NIP-46）で{props.verb}
      </button>
    </div>
  );
}
