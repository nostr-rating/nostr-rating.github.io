import {
  buildReport,
  isLinkedMatch,
  KIND,
  parseApplication,
  parseMatch,
  parseReport,
  parseSettings,
  setWinner,
  settleMatch,
  unwrapRoomMessage,
  validRoomId,
  wrapRoomMessage,
  type MatchRecord,
  type ReportResult,
  type ResultReport,
  type RoomMessage,
  type SetState,
  type Side,
  type StageBans,
} from '@nostr-rating/core';
import { useEffect, useId, useState } from 'react';
import { ChatPanel, type ChatLine } from '../components/ChatPanel.js';
import { IdentityBadge } from '../components/IdentityBadge.js';
import { latestReports, ReportPanel, reportStatus } from '../components/ReportPanel.js';
import { StageGuide } from '../components/StageGuide.js';
import { displayName, useApp } from '../state/AppContext.js';

/** NIP-17 は gift wrap の時刻を最大2日前までずらすので、その分さかのぼって購読する */
const WRAP_LOOKBACK_SEC = 2 * 24 * 3600 + 600;
const SEND_FAILED = '送れませんでした。電波のよい場所でもう一度押してください。';
const bansKey = (matchId: string) => `nostr-rating:bans:${matchId}`;

function formatDeadline(deadline: number, now: number): string {
  const d = new Date(deadline * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const left = Math.max(0, deadline - now);
  return `報告の締め切り: ${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}（あと ${Math.floor(left / 3600)}時間${Math.floor((left % 3600) / 60)}分）`;
}

function cachedBans(matchId: string): { p1: StageBans; p2: StageBans } | null {
  try {
    const raw = localStorage.getItem(bansKey(matchId));
    return raw ? (JSON.parse(raw) as { p1: StageBans; p2: StageBans }) : null;
  } catch {
    return null;
  }
}

export function MatchRoom({ matchId }: { matchId: string }) {
  const app = useApp();
  const { def } = app;
  const id = useId();
  const [match, setMatch] = useState<MatchRecord | null>(app.activeMatch?.id === matchId ? app.activeMatch : null);
  const [bans, setBans] = useState<{ p1: StageBans; p2: StageBans } | null>(() => cachedBans(matchId));
  const [bansMissing, setBansMissing] = useState(false);
  const [room, setRoom] = useState<{ roomId: string; password: string } | null>(null);
  const [roomInput, setRoomInput] = useState('');
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [reports, setReports] = useState<ResultReport[]>([]);
  const [set, setSet] = useState<SetState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [linked, setLinked] = useState<boolean | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (match) return;
    let alive = true;
    void app.relay
      .query([{ kinds: [KIND.match], ids: [matchId] }])
      .then((evs) => {
        const m = evs.map((e) => parseMatch(def.id, e)).find((x) => x !== null);
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

  // 第三者が勝手に作った対戦でないか（申し込みに結び付いているか）を確かめる
  useEffect(() => {
    if (!match) return;
    let alive = true;
    void app.relay
      .query([{ kinds: [KIND.application], ids: [match.applicationId] }])
      .then((evs) => {
        const a = evs.map((e) => parseApplication(def.id, e)).find((x) => x !== null);
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
      .then((evs) => {
        const s = evs.map((e) => parseSettings(def.id, e)).filter((x) => x !== null);
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
    if (!match || !me || !app.signer || !side) return;
    const signer = app.signer;
    const seen = new Set<string>();
    const lines: ChatLine[] = [];
    let latestRoom = -1;
    return app.relay.subscribe([{ kinds: [KIND.giftWrap], '#p': [me], since: match.createdAt - WRAP_LOOKBACK_SEC }], (ev) => {
      if (seen.has(ev.id)) return;
      seen.add(ev.id);
      void unwrapRoomMessage(signer, ev).then((got) => {
        if (!got || got.matchId !== match.id) return;
        if (got.from !== match.p1 && got.from !== match.p2) return;
        if (got.msg.type === 'room') {
          if (got.from !== match.p1 || got.createdAt < latestRoom || !validRoomId(def, got.msg.roomId)) return;
          latestRoom = got.createdAt;
          setRoom({ roomId: got.msg.roomId, password: got.msg.password });
        } else {
          lines.push({ mine: got.from === me, text: got.msg.text.slice(0, 500), at: got.createdAt });
          setChat([...lines].sort((a, b) => a.at - b.at));
        }
      });
    });
  }, [app.relay, app.signer, def, match, me, side]);

  // 結果報告
  useEffect(() => {
    if (!match) return;
    const got = new Map<string, ResultReport>();
    return app.relay.subscribe([{ kinds: [KIND.report], '#e': [match.id] }], (ev) => {
      const r = parseReport(def.id, ev);
      if (!r || r.matchId !== match.id || got.has(r.id)) return;
      got.set(r.id, r);
      setReports([...got.values()]);
    });
  }, [app.relay, def.id, match]);

  // 締め切りの表示を進めるため
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const settlement = match ? settleMatch(match, reports, app.now(), def.report.deadlineSec) : null;
  const confirmed = settlement?.status === 'confirmed';
  // 確定したらレートと順位を読み直す
  useEffect(() => {
    if (confirmed) void app.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmed]);

  if (error) return <p className="error">{error}</p>;
  if (notFound) {
    return (
      <div className="card stack">
        <p className="error">対戦が見つかりませんでした。電波の状態を確かめてください。</p>
        <button type="button" onClick={() => setNotFound(false)}>もう一度読み込む</button>
        <a href="#/lobby">ロビーに戻る</a>
      </div>
    );
  }
  if (!match || !me) return <p className="loading">対戦を読み込み中…</p>;
  if (linked === false) {
    return (
      <div className="card stack">
        <p className="error">この対戦は有効ではありません。あなたの申し込みに応えた対戦であることを確かめられませんでした。</p>
        <a href="#/lobby">ロビーに戻る</a>
      </div>
    );
  }
  if (!side || !opponent || !app.signer) return <p className="error">この対戦の参加者ではありません。</p>;
  const signer = app.signer;

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
      await app.relay.publish(await wrapRoomMessage(signer, opponent, match.id, msg, t));
      await app.relay.publish(await wrapRoomMessage(signer, me, match.id, msg, t, opponent));
    });

  const report = (result: ReportResult) =>
    guarded(async () => {
      await app.relay.publish(await signer.signEvent(buildReport(def.id, { matchId: match.id, opponent, result }, app.now())));
    });

  const decided = set ? setWinner(def, set) : null;
  const suggested: ReportResult | null = decided === null ? null : decided === side ? 'win' : 'lose';
  const closed = settlement !== null && settlement.status !== 'pending';
  const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => undefined);

  return (
    <section>
      <div className="card stack">
        <h2>対戦ルーム</h2>
        <p>
          相手: <strong>{displayName(app, opponent)}</strong>（レート {app.view.ratingOf(opponent).toFixed(0)}）
        </p>
        <IdentityBadge claims={app.identities[opponent]} pubkey={opponent} fetchFn={app.fetchFn} />
        <p className="muted">マナーの目安（合計）: {app.view.mannersTotalOf(opponent)}</p>
        <p className="muted" data-testid="deadline">{formatDeadline(match.createdAt + def.report.deadlineSec, app.now())}</p>
      </div>

      <div className="card stack">
        <h3>専用部屋</h3>
        <p className="muted">
          ストック{def.format.stock}・{def.format.timeLimitSec / 60}分・{Math.ceil(def.format.bestOf / 2)}本先取 ／ 入室制限「
          {def.room.entryRestriction}」 ／ 部屋の人数 {def.room.maxPlayers}人
        </p>
        <ul className="muted">
          {def.room.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
        {side === 'p1' ? (
          <>
            <p>あなたが部屋を立てます。パスワード「{def.room.defaultPassword}」で専用部屋を作り、部屋 ID を送ってください。</p>
            <label htmlFor={`${id}-room`}>部屋 ID</label>
            <input
              id={`${id}-room`}
              value={roomInput}
              maxLength={5}
              autoCapitalize="characters"
              onChange={(e) => setRoomInput(e.target.value.trim())}
            />
            <button
              type="button"
              className="primary"
              disabled={busy || !validRoomId(def, roomInput)}
              onClick={() => void send({ type: 'room', roomId: roomInput, password: def.room.defaultPassword })}
            >
              部屋 ID を送る
            </button>
            {room && <p className="muted">送信済み: {room.roomId}</p>}
          </>
        ) : room ? (
          <>
            <p>部屋 ID</p>
            <p className="big" data-testid="room-id">{room.roomId}</p>
            <button type="button" onClick={() => copy(room.roomId)}>部屋 ID をコピー</button>
            <p>パスワード</p>
            <p className="big" data-testid="room-password">{room.password}</p>
            <button type="button" onClick={() => copy(room.password)}>パスワードをコピー</button>
          </>
        ) : (
          <p>相手が部屋を立てるのを待っています…</p>
        )}
      </div>

      {bansMissing && <p className="notice" role="alert">拒否ステージを読み込めなかったため、拒否なしで案内しています。相手と確認してください。</p>}
      <StageGuide def={def} match={match} me={side} bans={bans ?? { p1: {}, p2: {} }} onSetChange={setSet} />
      <ChatPanel lines={chat} onSend={(text) => send({ type: 'chat', text })} />
      <ReportPanel
        status={reportStatus(def, match, reports, me, app.now())}
        closed={closed}
        mine={latestReports(match, reports).get(me)}
        suggested={suggested}
        busy={busy}
        onReport={report}
      />
      {sendError && <p className="error" role="alert">{sendError}</p>}
    </section>
  );
}
