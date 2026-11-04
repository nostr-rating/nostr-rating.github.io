import { useEffect, type ReactNode } from 'react';
import { helpPage, LOCALE_NAMES, LOCALES, messages, setLocale, useLocale, useT, useText, type Locale } from './i18n.js';
import { Lobby } from './pages/Lobby.js';
import { MatchRoom } from './pages/MatchRoom.js';
import { Onboarding } from './pages/Onboarding.js';
import { Player, Ranking } from './pages/Ranking.js';
import { Settings } from './pages/Settings.js';
import { navigate, useRoute } from './router.js';
import { useApp } from './state/AppContext.js';

const M = messages({
  ja: {
    help: 'ヘルプ',
    language: '言語',
    game: 'ゲーム',
    screens: '画面',
    waiting: '待機中',
    lobby: 'ロビー',
    ranking: 'ランキング',
    settings: '設定',
    notPersistent: 'このブラウザでは対戦記録を保存できません。閉じると記録の控えが消えます（レートには影響しません）。',
    loading: '読み込み中…',
    unknownDevices: (labels: string[]) => `知らない端末が登録されました: ${labels.join('、')}`,
    unknownDevicesHelp: (settings: ReactNode) => (
      <>自分で登録した覚えがなければ、{settings}の端末の一覧から取り消してください。自分の端末まで取り消されていたら、復活の言葉で復元してください。</>
    ),
    acknowledge: '自分で登録した',
  },
  en: {
    help: 'Help',
    language: 'Language',
    game: 'Game',
    screens: 'Screens',
    waiting: 'Waiting',
    lobby: 'Lobby',
    ranking: 'Ranking',
    settings: 'Settings',
    notPersistent: 'This browser cannot save your match records. Your local copy will be lost when you close it (your rating is not affected).',
    loading: 'Loading…',
    unknownDevices: (labels: string[]) => `An unknown device was registered: ${labels.join(', ')}`,
    unknownDevicesHelp: (settings: ReactNode) => (
      <>If you did not register it yourself, revoke it from the device list in {settings}. If your own devices were revoked too, restore your account with your recovery words.</>
    ),
    acknowledge: 'I registered it',
  },
});

export function App() {
  const app = useApp();
  const t = useT(M);
  const l = useLocale();
  const text = useText();
  const route = useRoute();
  /** はじめにの手順の間は、まだ使えない画面へのリンクを出さない */
  const onboarding = route.name === 'onboarding';

  useEffect(() => {
    if (!app.account && route.name !== 'onboarding') navigate({ name: 'onboarding' });
  }, [app.account, route.name]);

  const usesRatings = route.name === 'lobby' || route.name === 'match' || route.name === 'ranking' || route.name === 'player';
  const shown = app.loaded || (route.name === 'lobby' && app.lastView !== null);

  const tab = (name: 'lobby' | 'ranking' | 'settings') => (route.name === name || (name === 'ranking' && route.name === 'player') ? 'page' : undefined);

  return (
    <div className="app">
      <header className="app-header">
        <div className="top">
          {onboarding ? <span className="brand">Nostr-Rating</span> : <a href="#/lobby" className="brand">Nostr-Rating</a>}
          <select aria-label={t.language} className="locale-select" value={l} onChange={(e) => setLocale(e.target.value as Locale)}>
            {LOCALES.map((x) => (
              <option key={x} value={x} lang={x}>{LOCALE_NAMES[x]}</option>
            ))}
          </select>
          <a className="help" href={helpPage(l)}>{t.help}</a>
        </div>
        {!onboarding && (
          <div className="bar">
            {app.games.length > 1 && (
              <select aria-label={t.game} className="game-select" value={app.def.id} disabled={app.search.busy} onChange={(e) => app.setGame(e.target.value)}>
                {app.games.map((g) => (
                  <option key={g.id} value={g.id}>{text(g.name)}</option>
                ))}
              </select>
            )}
            <nav className="tabs" aria-label={t.screens}>
              <a href="#/lobby" aria-current={tab('lobby')}>{app.search.waitingSince !== null ? t.waiting : t.lobby}</a>
              <a href="#/ranking" aria-current={tab('ranking')}>{t.ranking}</a>
              <a href="#/settings" aria-current={tab('settings')}>{t.settings}</a>
            </nav>
          </div>
        )}
      </header>
      {!app.store.persistent && (
        <p className="notice">{t.notPersistent}</p>
      )}
      <main>
        {route.name === 'onboarding' && <Onboarding />}
        {route.name === 'settings' && <Settings />}
        {/* レートと紐づけを使う画面は、最初の同期が終わるまで初期値を見せない。ロビーは前回の値を出せるときは先に出す */}
        {usesRatings && !shown && <p className="loading">{t.loading}</p>}
        {usesRatings && shown && (
          <>
            {route.name === 'lobby' && <Lobby />}
            {route.name === 'match' && <MatchRoom key={route.id} matchId={route.id} />}
            {route.name === 'ranking' && <Ranking />}
            {route.name === 'player' && <Player pubkey={route.pubkey} />}
          </>
        )}
      </main>
      {/* あとから届く知らせは、画面の下に留める（上の要素を押し出さない） */}
      <div className="dock">
        <div id="dock-slot" />
        {app.accountError && <p className="notice bad" role="alert">{app.accountError}</p>}
        {app.unknownDevices.length > 0 && (
          <div className="notice" role="alert">
            <p>{t.unknownDevices(app.unknownDevices.map((d) => d.label))}</p>
            <p>{t.unknownDevicesHelp(<a href="#/settings">{t.settings}</a>)}</p>
            <button type="button" onClick={() => void app.acknowledgeDevices()}>{t.acknowledge}</button>
          </div>
        )}
      </div>
    </div>
  );
}
