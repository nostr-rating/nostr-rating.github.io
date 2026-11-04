import {
  acceptsNewMatches,
  matchDeadline,
  allowedRange,
  currentSeason,
  buildSettings,
  isLinkedMatch,
  KIND,
  parseApplication,
  parseMatch,
  parseReport,
  parseSettings,
  settleMatch,
  type MatchRecord,
  type ResultReport,
  type Settings,
} from '@nostr-rating/core';
import { useEffect, useId, useState } from 'react';
import { Dock } from '../components/Dock.js';
import { navigate } from '../router.js';
import { displayName, parseEach, useApp } from '../state/AppContext.js';
import { rangeLabel } from './Settings.js';

const FIGHTER_KEY = 'nostr-rating:firstFighter';

/** シーズンの区切りは定義の時差で表示する（端末の時差に左右されない） */
export function seasonTime(def: { seasons: { utcOffsetMinutes: number } }, t: number): string {
  const d = new Date((t + def.seasons.utcOffsetMinutes * 60) * 1000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function rememberedFighter(): string {
  try {
    return localStorage.getItem(FIGHTER_KEY) ?? '';
  } catch {
    return '';
  }
}

function notifyMatched(): void {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification('対戦相手が見つかりました');
    navigator.vibrate?.(200);
  } catch {
    // Android Chrome などでは new Notification が使えない。通知は補助なので無視する
  }
}

/** 締め切り前で、まだ確定も中止もしていない自分の対戦（再読み込みや画面移動のあとに戻れるように） */
function useOpenMatches(): MatchRecord[] {
  const app = useApp();
  const [open, setOpen] = useState<MatchRecord[]>([]);
  useEffect(() => {
    const me = app.pubkey;
    if (!me) return;
    let alive = true;
    const t = app.now();
    void (async () => {
      const evs = await app.relay.query([{ kinds: [KIND.match], '#p': app.mySessions, since: t - app.def.report.deadlineSec }]);
      const candidates = (await parseEach(app, evs, (e, by) => parseMatch(app.def.id, e, by))).filter((m) => m.p1 === me || m.p2 === me);
      if (candidates.length === 0) {
        if (alive) setOpen([]);
        return;
      }
      // 第三者が勝手に作った対戦は、申し込みに結び付かないので出さない
      const appEvs = await app.relay.query([{ kinds: [KIND.application], ids: candidates.map((m) => m.applicationId) }]);
      const apps = new Map((await parseEach(app, appEvs, (e, by) => parseApplication(app.def.id, e, by))).map((a) => [a.eventId, a]));
      const matches = candidates.filter((m) => isLinkedMatch(app.def, m, apps.get(m.applicationId)));
      if (matches.length === 0) {
        if (alive) setOpen([]);
        return;
      }
      const reps = await app.relay.query([{ kinds: [KIND.report], '#e': matches.map((m) => m.id) }]);
      const reports: ResultReport[] = await parseEach(app, reps, (e, by) => parseReport(app.def.id, e, by));
      const pending = matches
        .filter((m) => settleMatch(m, reports.filter((r) => r.matchId === m.id), t, matchDeadline(app.def, m.createdAt), app.def.results.draw).status === 'pending')
        .sort((a, b) => b.createdAt - a.createdAt);
      if (!alive) return;
      setOpen(pending);
      await app.loadPeople(pending.map((m) => (m.p1 === me ? m.p2 : m.p1)));
    })().catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.pubkey, app.relay, app.def, app.mySessions.join()]);
  return open;
}

export function Lobby() {
  const app = useApp();
  const { def } = app;
  const id = useId();
  const [fighter, setFighter] = useState(rememberedFighter() || def.characters?.list[0]!.id || '');
  const [range, setRange] = useState<number | null>(app.mySettings?.rangeChoice ?? null);
  const [, setTick] = useState(0);
  const open = useOpenMatches();

  useEffect(() => {
    if (app.mySettings) setRange(app.mySettings.rangeChoice);
  }, [app.mySettings]);

  useEffect(() => {
    if (app.pubkey) void app.refresh();
    // 画面を開いたときに最新のレートを読む
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.pubkey]);

  useEffect(() => {
    if (app.search.waitingSince === null) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [app.search.waitingSince]);

  const me = app.pubkey;
  const mine = me ? app.ratings.players[me] : undefined;
  const linked = me ? (app.identities[me]?.length ?? 0) > 0 : false;
  const rank = me
    ? Object.entries(app.ratings.players)
        .filter(([, p]) => p.matches > 0)
        .sort(([, a], [, b]) => b.rating - a.rating)
        .findIndex(([pk]) => pk === me) + 1
    : 0;

  /** 保存済みの拒否ステージと連戦設定を残したまま、レート差だけを変える */
  const ensureSettings = async (): Promise<Settings> => {
    if (app.mySettings && app.mySettings.rangeChoice === range) return app.mySettings;
    const base = app.mySettings ?? { stageBans: {}, rematchHours: 0 };
    const ev = await app.signer!.signEvent(
      buildSettings(def.id, { stageBans: base.stageBans, rangeChoice: range, rematchHours: base.rematchHours }, app.now()),
    );
    await app.relay.publish(ev);
    await app.store.put([ev]);
    const s = parseSettings(def.id, ev, app.pubkey)!;
    app.setMySettings(s);
    return s;
  };

  // キャラのないゲームでは空。ゲームを切り替えて前のゲームのキャラが残っていたら、一覧の最初にする
  const chosenFighter = def.characters ? (def.characters.list.some((f) => f.id === fighter) ? fighter : def.characters.list[0]!.id) : '';

  const search = async () => {
    try {
      localStorage.setItem(FIGHTER_KEY, fighter);
    } catch {
      // 次回の初期値に使うだけ
    }
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission().catch(() => undefined);
    }
    const m = await app.startSearch(async () => {
      const settings = await ensureSettings();
      return { firstFighter: chosenFighter, rangeChoice: settings.rangeChoice, rematchHours: settings.rematchHours, settingsId: settings.eventId };
    });
    if (!m) return;
    navigate({ name: 'match', id: m.id });
    notifyMatched();
  };

  const waitingSince = app.search.waitingSince;
  const waitingRange =
    waitingSince !== null && me
      ? allowedRange(def, { pubkey: me, rating: mine?.rating ?? def.rating.initialRating, rangeChoice: range, rematchHours: 0, waitingSince, mannersTotal: 0 }, app.now())
      : null;
  const settingsReady = app.settingsStatus === 'loaded';
  const window_ = acceptsNewMatches(def, app.now());
  const seasonNow = currentSeason(def, app.now());

  return (
    <section>
      <div className="card">
        <p className="meta">
          <span>{me ? displayName(app, me) : ''}</span>
          {seasonNow && <span>シーズン {seasonNow.id}（{seasonTime(def, seasonNow.endsAt)} まで）</span>}
        </p>
        <div>
          <span className="muted">レート</span>
          <p className="rating" data-testid="my-rating">{(mine?.rating ?? def.rating.initialRating).toFixed(0)}</p>
        </div>
        <p className="meta">
          {rank > 0 && <span>{rank}位</span>}
          <span>
            {mine?.wins ?? 0}勝 {mine?.losses ?? 0}敗{(mine?.draws ?? 0) > 0 ? ` ${mine!.draws}分` : ''}
          </span>
          <span>
            マナーの目安: 未報告 {mine?.manners.noReport ?? 0} ／ 中止 {mine?.manners.cancel ?? 0} ／ 食い違い {mine?.manners.mismatch ?? 0}
          </span>
        </p>
        {(mine?.matches ?? 0) < 10 && <p className="hint">対戦数が少ないうちは、レートが大きく動きます。</p>}
      </div>

      <div className="card">
        <h2>対戦相手を探す</h2>
        {def.characters && (
          <div className="field">
            <label htmlFor={`${id}-fighter`}>1戦目に使うキャラ</label>
            <select id={`${id}-fighter`} value={chosenFighter} disabled={app.search.busy} onChange={(e) => setFighter(e.target.value)}>
              {def.characters.list.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor={`${id}-range`}>マッチングするレート差</label>
          <select
            id={`${id}-range`}
            value={range === null ? '' : String(range)}
            disabled={app.search.busy}
            onChange={(e) => setRange(e.target.value === '' ? null : Number(e.target.value))}
          >
            {def.matching.rangeChoices.map((c) => (
              <option key={String(c)} value={c === null ? '' : String(c)}>{rangeLabel(c)}</option>
            ))}
          </select>
        </div>
        {!window_.ok && (
          <p className="notice">
            シーズン {window_.next.id} は {seasonTime(def, window_.next.startsAt)} に始まります。
          </p>
        )}
        {!linked && (
          <p className="notice bad">
            <span>
              対戦するには X か GitHub の紐づけが必要です。<a href="#/onboarding">紐づけに進む</a>
            </span>
          </p>
        )}
        {/* 探す前と探している間で、同じ高さの場所を入れ替える */}
        <div className="search-area" role="status" aria-live="polite">
          {!app.search.busy ? (
            <button type="button" className="primary wide" disabled={!linked || !app.signer || !settingsReady || !window_.ok} onClick={() => void search()}>
              対戦相手を探す
            </button>
          ) : (
            <div className="waiting">
              <p>
                {waitingSince === null ? '準備中…' : `待機中… ${app.now() - waitingSince}秒`}
                {waitingRange !== null && <span className="muted">レート差 ±{waitingRange} まで</span>}
              </p>
              <button type="button" onClick={() => app.cancelSearch()}>やめる</button>
            </div>
          )}
        </div>
        <p className="hint">探している間は、ほかの画面に移っても探し続けます。アプリを閉じるとやめます。</p>
      </div>

      {open.map((m) => {
        const opp = m.p1 === me ? m.p2 : m.p1;
        return (
          <div key={m.id} className="notice">
            <p>結果を報告していない対戦があります。</p>
            <a href={`#/match/${m.id}`}>対戦ルームへ戻る（{displayName(app, opp)} さん）</a>
          </div>
        );
      })}

      {(app.syncError || app.settingsStatus === 'failed' || app.search.error) && (
        <Dock>
          {app.syncError && <p className="notice">ランキングの最新データを読み込めませんでした。表示が古い可能性があります。</p>}
          {app.settingsStatus === 'failed' && <p className="notice bad" role="alert">対戦設定を読み込めませんでした。電波のよい場所で再読み込みしてください。</p>}
          {app.search.error && <p className="notice bad" role="alert">{app.search.error}</p>}
        </Dock>
      )}
    </section>
  );
}
