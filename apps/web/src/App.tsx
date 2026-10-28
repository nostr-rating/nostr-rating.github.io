import { useEffect } from 'react';
import { Lobby } from './pages/Lobby.js';
import { MatchRoom } from './pages/MatchRoom.js';
import { Onboarding } from './pages/Onboarding.js';
import { Player, Ranking } from './pages/Ranking.js';
import { Settings } from './pages/Settings.js';
import { navigate, useRoute } from './router.js';
import { useApp } from './state/AppContext.js';

export function App() {
  const app = useApp();
  const route = useRoute();
  /** はじめにの手順の間は、まだ使えない画面へのリンクを出さない */
  const onboarding = route.name === 'onboarding';

  useEffect(() => {
    if (!app.account && route.name !== 'onboarding') navigate({ name: 'onboarding' });
  }, [app.account, route.name]);

  return (
    <div className="app">
      <header className="app-header">
        {onboarding ? <span className="brand">Nostr-Rating</span> : <a href="#/lobby" className="brand">Nostr-Rating</a>}
        {!onboarding && app.games.length > 1 && (
          <select aria-label="ゲーム" className="game-select" value={app.def.id} disabled={app.search.busy} onChange={(e) => app.setGame(e.target.value)}>
            {app.games.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        )}
        <nav>
          {!onboarding && (
            <>
              <a href="#/lobby">{app.search.waitingSince !== null ? '待機中' : 'ロビー'}</a>
              <a href="#/ranking">ランキング</a>
              <a href="#/settings">設定</a>
            </>
          )}
          <a href={`${import.meta.env.BASE_URL}help/account.html`}>ヘルプ</a>
        </nav>
      </header>
      {app.accountError && <p className="error" role="alert">{app.accountError}</p>}
      {app.unknownDevices.length > 0 && (
        <div className="notice stack" role="alert">
          <p>知らない端末が登録されました: {app.unknownDevices.map((d) => d.label).join('、')}</p>
          <p>
            自分で登録した覚えがなければ、<a href="#/settings">設定</a>の端末の一覧から取り消してください。自分の端末まで取り消されていたら、復活の言葉で戻してください。
          </p>
          <button type="button" onClick={() => void app.acknowledgeDevices()}>自分で登録した</button>
        </div>
      )}
      {!app.store.persistent && (
        <p className="notice">このブラウザでは対戦記録を保存できません。閉じると記録の控えが消えます（レートには影響しません）。</p>
      )}
      <main>
        {route.name === 'onboarding' && <Onboarding />}
        {route.name === 'settings' && <Settings />}
        {route.name === 'lobby' && <Lobby />}
        {route.name === 'match' && <MatchRoom key={route.id} matchId={route.id} />}
        {route.name === 'ranking' && <Ranking />}
        {route.name === 'player' && <Player pubkey={route.pubkey} />}
      </main>
    </div>
  );
}
