import {
  buildReport,
  generateRoomPassword,
  isLinkedMatch,
  KIND,
  parseApplication,
  parseMatch,
  parseReport,
  parseSettings,
  matchDeadline,
  settleMatch,
  unwrapRoomMessage,
  sideOf,
  validInviteLink,
  validRoomId,
  validRoomPassword,
  wrapRoomMessage,
  type GameDefinition,
  type MatchRecord,
  type ReportResult,
  type ResultReport,
  type RoomMessage,
  type SetState,
  type Side,
  type StageBans,
  type Signer,
} from '@nostr-rating/core';
import { useEffect, useId, useState } from 'react';
import { ChatPanel, type ChatLine } from '../components/ChatPanel.js';
import { CopyButton } from '../components/CopyButton.js';
import { Dock } from '../components/Dock.js';
import { IdentityBadge } from '../components/IdentityBadge.js';
import { latestReports, ReportPanel, reportStatus } from '../components/ReportPanel.js';
import { StageGuide } from '../components/StageGuide.js';
import { defaultRoomPassword } from '../services/config.js';
import { displayName, parseEach, useApp } from '../state/AppContext.js';

/** NIP-17 は gift wrap の時刻を最大2日前までずらすので、その分さかのぼって購読する */
const WRAP_LOOKBACK_SEC = 2 * 24 * 3600 + 600;
const SEND_FAILED = '送れませんでした。電波のよい場所でもう一度押してください。';
const PAST_DEADLINE = '報告の締め切りを過ぎたため、送れませんでした。';
const bansKey = (matchId: string) => `nostr-rating:bans:${matchId}`;

const pad = (n: number) => String(n).padStart(2, '0');

function formatDeadline(deadline: number, now: number): string {
  const d = new Date(deadline * 1000);
  const left = Math.max(0, deadline - now);
  return `報告の締め切り: ${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}（あと ${Math.floor(left / 3600)}時間${Math.floor((left % 3600) / 60)}分）`;
}

/** シーズンの区切りは、ゲームの定義の時差で表す（ロビーのシーズンの表示と同じ） */
function seasonDate(def: GameDefinition, t: number): string {
  const d = new Date((t + def.seasons.utcOffsetMinutes * 60) * 1000);
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}:${pad(d.getUTCMinutes())}`;
}

function cachedBans(matchId: string): { p1: StageBans; p2: StageBans } | null {
  try {
    const raw = localStorage.getItem(bansKey(matchId));
    return raw ? (JSON.parse(raw) as { p1: StageBans; p2: StageBans }) : null;
  } catch {
    return null;
  }
}

/** 対戦に使った使い捨ての鍵の署名者（古い日の鍵でも、残っていれば使う） */
async function sessionSignerFor(signers: Signer[], pk: string): Promise<Signer | null> {
  for (const s of signers) if ((await s.getPublicKey()) === pk) return s;
  return null;
}

export function MatchRoom({ matchId }: { matchId: string }) {
  const app = useApp();
  const { def } = app;
  const id = useId();
  const [match, setMatch] = useState<MatchRecord | null>(app.activeMatch?.id === matchId ? app.activeMatch : null);
  const [bans, setBans] = useState<{ p1: StageBans; p2: StageBans } | null>(() => cachedBans(matchId));
  const [bansMissing, setBansMissing] = useState(false);
  const [room, setRoom] = useState<{ roomId: string; password: string } | null>(null);
  const [link, setLink] = useState<URL | null>(null);
  const [roomInput, setRoomInput] = useState('');
  const [password, setPassword] = useState('');
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [reports, setReports] = useState<ResultReport[]>([]);
  const [set, setSet] = useState<SetState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [linked, setLinked] = useState<boolean | null>(null);
  const [, setTick] = useState(0);
  // 対戦のゲームに切り替わってから作る（開いた時点では別のゲームのことがある）
  useEffect(() => setPassword(roomPassword(def, matchId)), [def, matchId]);

  useEffect(() => {
    if (match) return;
    let alive = true;
    void app.relay
      .query([{ kinds: [KIND.match], ids: [matchId] }])
      .then(async (evs) => {
        // ほかのゲームの対戦なら、そのゲームに切り替えて開く
        for (const g of app.games) {
          const found = (await parseEach(app, evs, (e, by) => parseMatch(g.id, e, by)))[0];
          if (found && g.id !== def.id) {
            if (alive) app.setGame(g.id);
            return;
          }
        }
        const m = (await parseEach(app, evs, (e, by) => parseMatch(def.id, e, by)))[0];
        if (!alive) return;
        if (m) setMatch(m);
        else setNotFound(true);
      })
      .catch(() => alive && setNotFound(true));
    return () => {
      alive = false;
    };
  }, [app.relay, def.id, match, matchId, notFound]);

  const me = app.pubkey;
  const side: Side | null = match && me ? (match.p1 === me ? 'p1' : match.p2 === me ? 'p2' : null) : null;
  const opponent = match && side ? (side === 'p1' ? match.p2 : match.p1) : null;
  // 部屋 ID・チャット・報告の宛先は、対戦の p タグにある使い捨ての鍵
  const [mySessionPk, setMySessionPk] = useState<string | null>(null);
  useEffect(() => {
    if (!match) return;
    let alive = true;
    void Promise.all(app.sessionSigners.map((s) => s.getPublicKey())).then((pks) => {
      if (alive) setMySessionPk(match.sessions.find((s) => pks.includes(s)) ?? null);
    });
    return () => {
      alive = false;
    };
  }, [app.sessionSigners, match]);
  const opponentSession = match && mySessionPk ? (match.sessions.find((s) => s !== mySessionPk) ?? null) : null;
  // 先後はマッチの id で決まり、1つ目の側が対戦の場所を用意する（docs/adr/0010）
  const mySide = match && side ? sideOf(match.id, side) : null;
  const hostSession = match ? (mySide === 0 ? mySessionPk : opponentSession) : null;

  // 第三者が勝手に作った対戦でないか（申し込みに結び付いているか）を確かめる
  useEffect(() => {
    if (!match) return;
    let alive = true;
    void app.relay
      .query([{ kinds: [KIND.application], ids: [match.applicationId] }])
      .then(async (evs) => {
        const a = (await parseEach(app, evs, (e, by) => parseApplication(def.id, e, by)))[0];
        if (alive) setLinked(isLinkedMatch(def, match, a));
      })
      .catch(() => alive && setLinked(null));
    return () => {
      alive = false;
    };
  }, [app.relay, def, match]);

  // 初めて対戦する相手の名前と SNS の主張を読む
  useEffect(() => {
    if (opponent) void app.loadPeople([opponent]).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opponent]);

  // マッチ時点の拒否ステージ。設定は置き換え可能なイベントで後から消えるので、読めたら端末に残す
  useEffect(() => {
    if (!match || bans) return;
    void app.relay
      .query([{ kinds: [KIND.settings], ids: [match.p1SettingsId, match.p2SettingsId] }])
      .then(async (evs) => {
        const s = await parseEach(app, evs, (e, by) => parseSettings(def.id, e, by));
        const p1 = s.find((x) => x.eventId === match.p1SettingsId && x.pubkey === match.p1);
        const p2 = s.find((x) => x.eventId === match.p2SettingsId && x.pubkey === match.p2);
        const got = { p1: p1?.stageBans ?? {}, p2: p2?.stageBans ?? {} };
        setBans(got);
        setBansMissing(!p1 || !p2);
        if (p1 && p2) {
          try {
            localStorage.setItem(bansKey(match.id), JSON.stringify(got));
          } catch {
            // 残せなくても表示はできる
          }
        }
      })
      .catch(() => setBansMissing(true));
  }, [app.relay, bans, def.id, match]);

  // 部屋 ID とチャット（暗号化 DM）
  useEffect(() => {
    if (!match || !me || !side || !mySessionPk || !opponentSession) return;
    const signer = sessionSignerFor(app.sessionSigners, mySessionPk);
    if (!signer) return;
    const seen = new Set<string>();
    const lines: ChatLine[] = [];
    let latestRoom = -1;
    return app.relay.subscribe([{ kinds: [KIND.giftWrap], '#p': [mySessionPk], since: match.createdAt - WRAP_LOOKBACK_SEC }], (ev) => {
      if (seen.has(ev.id)) return;
      seen.add(ev.id);
      void signer.then((s) => (s ? unwrapRoomMessage(s, ev) : null)).then((got) => {
        if (!got || got.matchId !== match.id) return;
        if (got.from !== mySessionPk && got.from !== opponentSession) return;
        if (got.msg.type === 'room') {
          if (got.from !== hostSession || got.createdAt < latestRoom || !validRoomId(def, got.msg.roomId) || !validRoomPassword(def, got.msg.password)) return;
          latestRoom = got.createdAt;
          setRoom({ roomId: got.msg.roomId, password: got.msg.password });
        } else if (got.msg.type === 'link') {
          const url = def.room.kind === 'link' ? validInviteLink(got.msg.url) : null;
          if (got.from !== hostSession || got.createdAt < latestRoom || !url) return;
          latestRoom = got.createdAt;
          setLink(url);
        } else {
          lines.push({ mine: got.from === mySessionPk, text: got.msg.text.slice(0, 500), at: got.createdAt });
          setChat([...lines].sort((a, b) => a.at - b.at));
        }
      });
    });
  }, [app.relay, app.sessionSigners, def, match, me, side, mySessionPk, opponentSession, hostSession]);

  // 結果報告
  useEffect(() => {
    if (!match) return;
    const got = new Map<string, ResultReport>();
    return app.relay.subscribe([{ kinds: [KIND.report], '#e': [match.id] }], (ev) => {
      app.author(ev).then(
        (by) => {
          const r = parseReport(def.id, ev, by);
          if (!r || r.matchId !== match.id || got.has(r.id)) return;
          got.set(r.id, r);
          setReports([...got.values()]);
        },
        (e: unknown) => console.warn('could not resolve the author of a report', e),
      );
    });
  }, [app.relay, def.id, match]);

  // 締め切りの表示を進めるため
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // 締め切りの時刻ちょうどにも描き直し、報告のボタンを消す
  const deadline = match ? matchDeadline(def, match.createdAt) : null;
  useEffect(() => {
    if (deadline === null) return;
    const ms = (deadline - app.now()) * 1000;
    if (ms <= 0) return;
    const t = setTimeout(() => setTick((n) => n + 1), ms);
    return () => clearTimeout(t);
  }, [deadline, app]);

  const settlement = match && deadline !== null ? settleMatch(match, reports, app.now(), deadline, def.results.draw) : null;
  const confirmed = settlement?.status === 'confirmed';
  // 確定したらレートと順位を読み直す
  useEffect(() => {
    if (confirmed) void app.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmed]);

  if (error) return <p className="error">{error}</p>;
  if (notFound) {
    return (
      <div className="card">
        <p className="error">対戦が見つかりませんでした。電波の状態を確かめてください。</p>
        <div className="actions">
          <button type="button" className="primary" onClick={() => setNotFound(false)}>もう一度読み込む</button>
          <a className="button" href="#/lobby">ロビーに戻る</a>
        </div>
      </div>
    );
  }
  if (!match || !me) return <p className="loading">対戦を読み込み中…</p>;
  if (linked === false) {
    return (
      <div className="card">
        <p className="error">この対戦は有効ではありません。あなたの申し込みに応えた対戦であることを確かめられませんでした。</p>
        <a className="button" href="#/lobby">ロビーに戻る</a>
      </div>
    );
  }
  if (!side || !opponent || !app.signer) return <p className="error">この対戦の参加者ではありません。</p>;
  const signer = app.signer;
  if (!mySessionPk || !opponentSession) return <p className="loading">対戦を読み込み中…</p>;
  const sealSigner = sessionSignerFor(app.sessionSigners, mySessionPk);

  const guarded = async (f: () => Promise<void>) => {
    setBusy(true);
    setSendError(null);
    try {
      await f();
    } catch {
      setSendError(SEND_FAILED);
    } finally {
      setBusy(false);
    }
  };

  const send = (msg: RoomMessage) =>
    guarded(async () => {
      const t = app.now();
      const s = await sealSigner;
      if (!s) throw new Error('no session key for this match');
      await app.relay.publish(await wrapRoomMessage(s, opponentSession, match.id, msg, t));
      await app.relay.publish(await wrapRoomMessage(s, mySessionPk, match.id, msg, t, opponentSession));
    });

  const report = async (result: ReportResult) => {
    // 確認のダイアログを開いたまま締め切りをまたぐと、送っても数えられない
    if (app.now() > matchDeadline(def, match.createdAt)) {
      setSendError(PAST_DEADLINE);
      setTick((n) => n + 1);
      return;
    }
    await guarded(async () => {
      await app.relay.publish(await signer.signEvent(buildReport(def.id, { matchId: match.id, opponent: opponentSession, result }, app.now())));
    });
  };

  // ステージ案内で記録した勝敗の数。どちらの結果を報告するかは、本人が決める。
  // ステージ案内のあるゲームでは最初から 0 - 0 を出し、記録が届いても下の要素を動かさない
  const games = set?.games ?? [];
  const record = def.stages && def.characters ? { mine: games.filter((g) => g.winner === side).length, theirs: games.filter((g) => g.winner !== side).length } : null;
  const closed = settlement !== null && settlement.status !== 'pending';

  const format = (
    <p className="muted" data-testid="room-format">
      {def.format.bestOf === 1 ? '1本勝負' : `${Math.ceil(def.format.bestOf / 2)}本先取`}
      {def.format.notes.length > 0 ? ` ／ ${def.format.notes.join('・')}` : ''}
      {def.room.kind === 'code' ? ` ／ 入室制限「${def.room.entryRestriction}」 ／ 部屋の人数 ${def.room.maxPlayers}人` : ''}
    </p>
  );

  return (
    <section>
      <div className="card">
        <h2>対戦ルーム</h2>
        <div className="opponent">
          <span className="muted">相手</span>
          <p>
            <strong className="opponent-name">{displayName(app, opponent)}</strong>
            <span className="muted">　レート {app.view.ratingOf(opponent).toFixed(0)}</span>
          </p>
        </div>
        <IdentityBadge claims={app.identities[opponent]} pubkey={opponent} fetchFn={app.fetchFn} />
        <p className="meta">
          <span>マナーの目安（合計）: {app.view.mannersTotalOf(opponent)}</span>
          <span data-testid="deadline">{formatDeadline(matchDeadline(def, match.createdAt), app.now())}</span>
        </p>
        {matchDeadline(def, match.createdAt) < match.createdAt + def.report.deadlineSec && (
          <p className="notice" data-testid="season-end-deadline">
            この対戦の報告の締め切りはシーズンの終わり（{seasonDate(def, matchDeadline(def, match.createdAt))}）です。それまでに双方の報告がそろわないと、結果は確定しません。
          </p>
        )}
      </div>

      <div className="card">
        <h3>{def.room.kind === 'code' ? '専用部屋' : '対局の場所'}</h3>
        <p className="side" data-testid="my-side">
          あなたは「{def.sides[mySide!]}」です（相手は「{def.sides[mySide === 0 ? 1 : 0]}」）。
        </p>
        {format}
        {def.room.notes.length > 0 && (
          <ul className="muted">
            {def.room.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
        {def.room.kind === 'code' ? (
          mySide === 0 ? (
            <>
              <p>あなたが部屋を立てます。次のパスワードで専用部屋を作り、部屋 ID とパスワードを送ってください。</p>
              <div className="field">
                <label htmlFor={`${id}-password`}>パスワード</label>
                <input
                  id={`${id}-password`}
                  className="big"
                  inputMode="numeric"
                  autoComplete="off"
                  value={password}
                  maxLength={def.room.password.maxDigits}
                  onChange={(e) => {
                    const v = e.target.value.replace(/[^0-9]/g, '');
                    setPassword(v);
                    savePassword(matchId, v);
                  }}
                />
                <p className="hint">
                  数字{def.room.password.minDigits}〜{def.room.password.maxDigits}桁。ゲームで別のパスワードにしたときは書き換えてください。
                </p>
              </div>
              <div className="field">
                <label htmlFor={`${id}-room`}>部屋 ID</label>
                <input
                  id={`${id}-room`}
                  className="big"
                  value={roomInput}
                  maxLength={5}
                  autoCapitalize="characters"
                  autoComplete="off"
                  onChange={(e) => setRoomInput(e.target.value.trim())}
                />
              </div>
              <button
                type="button"
                className="primary wide"
                disabled={busy || !validRoomId(def, roomInput) || !validRoomPassword(def, password)}
                onClick={() => void send({ type: 'room', roomId: roomInput, password })}
              >
                部屋 ID とパスワードを送る
              </button>
              <p className="slot muted" role="status">{room ? `送信済み: 部屋 ID ${room.roomId}・パスワード ${room.password}` : ''}</p>
            </>
          ) : (
            <>
              {/* 届く前から同じ枠を出しておき、届いたら中身だけを入れ替える */}
              <p className="slot" role="status">{room ? '相手から部屋 ID とパスワードが届きました。' : '相手が部屋を立てるのを待っています…'}</p>
              <div className="value-row">
                <div>
                  <span className="label">部屋 ID</span>
                  <p className="big" data-testid={room ? 'room-id' : undefined}>{room ? room.roomId : '—'}</p>
                </div>
                <CopyButton text={room ? room.roomId : null}>コピー</CopyButton>
              </div>
              <div className="value-row">
                <div>
                  <span className="label">パスワード</span>
                  <p className="big" data-testid={room ? 'room-password' : undefined}>{room ? room.password : '—'}</p>
                </div>
                <CopyButton text={room ? room.password : null}>コピー</CopyButton>
              </div>
            </>
          )
        ) : mySide === 0 ? (
          <>
            <p>あなたが対局を用意します。双方の使えるオンラインの対局サービスで相手を招待するリンクを作り、送ってください。</p>
            <div className="field">
              <label htmlFor={`${id}-link`}>招待リンク</label>
              <input id={`${id}-link`} inputMode="url" placeholder="https://…" value={roomInput} onChange={(e) => setRoomInput(e.target.value.trim())} />
              <p className="hint">https:// で始まるリンクだけを送れます。</p>
            </div>
            <button
              type="button"
              className="primary wide"
              disabled={busy || !validInviteLink(roomInput)}
              onClick={() => void send({ type: 'link', url: roomInput })}
            >
              招待リンクを送る
            </button>
            <p className="slot muted" role="status">{link ? `送信済み: ${link.hostname}` : ''}</p>
          </>
        ) : (
          <div className="invite">
            {link ? (
              <>
                <p>
                  相手から招待リンクが届きました。リンク先は <strong data-testid="invite-host">{link.hostname}</strong> です。知らないサービスなら開かず、チャットで確かめてください。
                </p>
                <a className="button primary wide" href={link.href} target="_blank" rel="noopener noreferrer">
                  招待リンクを開く
                </a>
              </>
            ) : (
              <p role="status">相手が対局を用意するのを待っています…</p>
            )}
          </div>
        )}
      </div>

      {def.stages && def.characters && <StageGuide def={def} match={match} me={side} bans={bans ?? { p1: {}, p2: {} }} onSetChange={setSet} />}
      <ChatPanel
        lines={chat}
        onSend={(text) => send({ type: 'chat', text })}
        note={
          def.room.kind === 'code'
            ? '部屋 ID とパスワードは上の「専用部屋」の欄から送ってください。'
            : '招待リンクは上の「対局の場所」の欄から送ってください。チャットに貼ったリンクは、アプリがリンク先を確かめません。'
        }
      />
      <ReportPanel
        status={reportStatus(def, match, reports, me, app.now())}
        closed={closed}
        mine={latestReports(match, reports).get(me)}
        record={record}
        allowDraw={def.results.draw}
        busy={busy}
        onReport={report}
      />
      {(bansMissing || sendError) && (
        <Dock>
          {bansMissing && <p className="notice" role="alert">拒否ステージを読み込めなかったため、拒否なしで案内しています。相手と確認してください。</p>}
          {sendError && <p className="notice bad" role="alert">{sendError}</p>}
        </Dock>
      )}
    </section>
  );
}

const PASSWORD_KEY = 'nostr-rating:room-password:';

/** 部屋を立てる人のパスワード。開き直しても同じ値にするため、対戦ごとに端末に残す */
function roomPassword(def: GameDefinition, matchId: string): string {
  if (def.room.kind !== 'code') return '';
  try {
    const saved = localStorage.getItem(PASSWORD_KEY + matchId);
    if (saved !== null) return saved;
  } catch {
    // 残せなくても、その場で作った値で進める
  }
  // 設定画面で固定の初期値を決めていれば、それを使う
  const fixed = defaultRoomPassword(def.id);
  const made = validRoomPassword(def, fixed) ? fixed : generateRoomPassword(def);
  savePassword(matchId, made);
  return made;
}

function savePassword(matchId: string, password: string): void {
  try {
    localStorage.setItem(PASSWORD_KEY + matchId, password);
  } catch {
    // 開き直すと作り直しになるだけ
  }
}
