import {
  claimToTag,
  decodeNsec,
  generateSecretKey,
  KIND,
  npubOf,
  parseIdentities,
  parseProfile,
  parseProofUrl,
  verificationText,
  verifyClaim,
  type IdentityClaim,
  type NostrEvent,
  type Pubkey,
  type Signer,
  type VerifyStatus,
} from '@nostr-rating/core';
import { useEffect, useState } from 'react';
import { KeyBackup } from '../components/KeyBackup.js';
import { StatusBadge } from '../components/IdentityBadge.js';
import { navigate } from '../router.js';
import { rememberSignerKind } from '../services/boot.js';
import { markBackedUp, saveLocalSigner } from '../services/signer-local.js';
import { nip07Signer } from '../services/signer-nip07.js';
import { useApp } from '../state/AppContext.js';

type Step = 'checking' | 'start' | 'restore' | 'name' | 'identity' | 'backup';

/** 貼り付けやファイルの中から nsec を取り出す（説明の行が一緒に入っていてもよい） */
function extractNsec(text: string): string {
  return text.match(/nsec1[02-9ac-hj-np-z]+/)?.[0] ?? text.trim();
}

const newest = (evs: NostrEvent[], kind: number) => evs.filter((e) => e.kind === kind).sort((a, b) => b.created_at - a.created_at)[0];

export function Onboarding() {
  const app = useApp();
  const [step, setStep] = useState<Step>(app.signer ? 'checking' : 'start');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [nsecInput, setNsecInput] = useState('');
  const [restoreInput, setRestoreInput] = useState('');
  const [claim, setClaim] = useState<IdentityClaim | null>(null);
  const [status, setStatus] = useState<VerifyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** 公開済みのプロフィールと紐づけを見て、どの手順から始めるかを決める */
  const continueFrom = async (pk: Pubkey, restored: boolean) => {
    if (restored) {
      await markBackedUp();
      app.setBackedUp(true);
    }
    let evs: NostrEvent[] = [];
    try {
      evs = await app.relay.query([{ kinds: [KIND.profile, KIND.identities], authors: [pk] }]);
    } catch {
      // 読めなければ最初の手順から
    }
    const profile = newest(evs, KIND.profile);
    const ids = newest(evs, KIND.identities);
    const existingName = profile ? (parseProfile(profile)?.name ?? '') : '';
    const claims = ids ? (parseIdentities(ids)?.claims ?? []) : [];
    if (existingName) app.rememberProfile(pk, existingName);
    if (ids) app.rememberIdentities(pk, claims);
    if (existingName && claims.length > 0) {
      if (app.signerKind === 'local' && !restored && !app.backedUp) setStep('backup');
      else navigate({ name: 'lobby' });
      return;
    }
    setName(existingName);
    setStep(existingName ? 'identity' : 'name');
  };

  useEffect(() => {
    if (step === 'checking' && app.pubkey) void continueFrom(app.pubkey, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, app.pubkey]);

  const signIn = async (signer: Signer, kind: 'local' | 'nip07', restored: boolean) => {
    rememberSignerKind(kind);
    await app.setSigner(signer, kind);
    await continueFrom(await signer.getPublicKey(), restored);
  };

  const createKey = async () => {
    const signer = await saveLocalSigner(generateSecretKey());
    rememberSignerKind('local');
    await app.setSigner(signer, 'local');
    setStep('name');
  };

  const importKey = async (text: string, restored: boolean, failMessage: string) => {
    let sk: Uint8Array;
    try {
      sk = decodeNsec(extractNsec(text));
    } catch {
      setError(failMessage);
      return;
    }
    setError(null);
    await signIn(await saveLocalSigner(sk), 'local', restored);
  };

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setRestoreInput(extractNsec(await file.text()));
  };

  const useNip07 = async () => {
    const s = nip07Signer();
    if (!s) {
      setError('NIP-07 対応の拡張機能が見つかりません');
      return;
    }
    if (!window.nostr?.nip44) {
      setError('この拡張機能は暗号化（NIP-44）に対応していないため、部屋 ID のやり取りができません。別の拡張機能を使ってください。');
      return;
    }
    app.setBackedUp(true);
    try {
      await signIn(s, 'nip07', false);
    } catch {
      setError('拡張機能でログインできませんでした');
    }
  };

  /** 既存のプロフィールの項目（画像や自己紹介）は残し、名前だけを書き換える */
  const saveName = async () => {
    if (!app.signer || !app.pubkey) return;
    setBusy(true);
    try {
      const latest = newest(await app.relay.query([{ kinds: [KIND.profile], authors: [app.pubkey] }]), KIND.profile);
      let content: Record<string, unknown> = {};
      try {
        const parsed = latest ? (JSON.parse(latest.content) as unknown) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) content = parsed as Record<string, unknown>;
      } catch {
        content = {};
      }
      const ev = await app.signer.signEvent({
        kind: KIND.profile,
        created_at: app.now(),
        tags: latest?.tags ?? [],
        content: JSON.stringify({ ...content, name: name.trim() }),
      });
      await app.relay.publish(ev);
      app.rememberProfile(app.pubkey, name.trim());
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
      setError('対応していない URL です（GitHub Gist・Mastodon・X の投稿 URL を入力してください）');
      return;
    }
    setError(null);
    setStatus(await verifyClaim(c, app.pubkey, app.fetchFn));
  };

  /** 既存の紐づけ（ほかのサービスやこのアプリが知らないものも）は残し、同じサービスの分だけ置き換える */
  const register = async () => {
    if (!app.signer || !app.pubkey || !claim) return;
    setBusy(true);
    try {
      const latest = newest(await app.relay.query([{ kinds: [KIND.identities], authors: [app.pubkey] }]), KIND.identities);
      const kept = (latest?.tags ?? []).filter((t) => !(t[0] === 'i' && t[1]?.startsWith(`${claim.platform}:`)));
      const ev = await app.signer.signEvent({ kind: KIND.identities, created_at: app.now(), tags: [...kept, claimToTag(claim)], content: '' });
      await app.relay.publish(ev);
      app.rememberIdentities(app.pubkey, parseIdentities(ev)?.claims ?? [claim]);
      if (app.signerKind === 'local' && !app.backedUp) setStep('backup');
      else navigate({ name: 'lobby' });
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
          <button type="button" className="primary" onClick={() => void createKey()}>
            はじめる
          </button>
          <button type="button" onClick={() => setStep('restore')}>バックアップから引き継ぐ</button>
          <details>
            <summary>すでに Nostr を使っている方</summary>
            <div className="stack">
              <button type="button" onClick={() => void useNip07()}>ブラウザ拡張機能（NIP-07）でログイン</button>
              <label htmlFor="nsec">nsec</label>
              <input id="nsec" type="password" autoComplete="off" value={nsecInput} onChange={(e) => setNsecInput(e.target.value)} />
              <button type="button" onClick={() => void importKey(nsecInput, false, 'nsec を読み取れませんでした')}>取り込む</button>
            </div>
          </details>
        </div>
      )}

      {step === 'restore' && (
        <div className="card stack">
          <h2>バックアップから引き継ぐ</h2>
          <p>保存しておいた引き継ぎコード（nsec1 で始まる文字列）を貼り付けるか、保存したファイルを選んでください。</p>
          <label htmlFor="restore-code">引き継ぎコード</label>
          <textarea id="restore-code" rows={3} autoComplete="off" value={restoreInput} onChange={(e) => setRestoreInput(e.target.value)} />
          <label htmlFor="restore-file">ファイルから読み込む</label>
          <input id="restore-file" type="file" accept=".txt,text/plain" onChange={(e) => void readFile(e.target.files?.[0])} />
          <button type="button" className="primary" onClick={() => void importKey(restoreInput, true, '引き継ぎコードを読み取れませんでした')}>
            引き継ぐ
          </button>
          <button type="button" onClick={() => setStep('start')}>戻る</button>
        </div>
      )}

      {step === 'name' && (
        <div className="card stack">
          <h2>表示名</h2>
          <label htmlFor="name">表示名</label>
          <input id="name" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
          <p className="muted">ゲーム内の名前と同じにしてください。</p>
          <button type="button" className="primary" disabled={busy || name.trim() === ''} onClick={() => void saveName()}>
            次へ
          </button>
          <details>
            <summary>あなたの ID</summary>
            <p className="mono muted" data-testid="my-npub">{app.pubkey ? npubOf(app.pubkey) : ''}</p>
          </details>
        </div>
      )}

      {step === 'identity' && app.pubkey && (
        <div className="card stack">
          <h2>SNS アカウントの紐づけ</h2>
          <p>
            次の文をそのまま SNS に投稿し、その投稿の URL を入力してください。本人確認のための定型文なので、英語のまま投稿してください。
            GitHub の Gist と Mastodon は自動で確認します。X は確認できないため、対戦相手が投稿を見て判断します。
          </p>
          <p className="mono card" data-testid="verification-text">{verificationText(app.pubkey)}</p>
          <button type="button" onClick={() => void navigator.clipboard?.writeText(verificationText(app.pubkey!)).catch(() => undefined)}>
            文をコピー
          </button>
          <label htmlFor="proof-url">投稿の URL</label>
          <input id="proof-url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button type="button" onClick={() => void check()}>確認する</button>
          {status && <StatusBadge status={status} />}
          {claim?.platform === 'twitter' && (
            <p className="muted">X だけを紐づけた場合、引き継ぎコードをなくすと戦績を引き継げません。コードは必ず保存してください。</p>
          )}
          <button
            type="button"
            className="primary"
            disabled={busy || !claim || status === null || status === 'failed'}
            onClick={() => void register()}
          >
            登録して次へ
          </button>
        </div>
      )}

      {step === 'backup' && (
        <div className="card stack">
          <h2>引き継ぎコードの保存</h2>
          <KeyBackup onDone={() => navigate({ name: 'lobby' })} />
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
