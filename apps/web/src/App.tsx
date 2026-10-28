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

  useEffect(() => {
    if (!app.signer && route.name !== 'onboarding') navigate({ name: 'onboarding' });
  }, [app.signer, route.name]);

  return (
    <div className="app">
      <header className="app-header">
        <a href="#/lobby" className="brand">Nostr-Rating</a>
        <nav>
          <a href="#/lobby">{app.search.waitingSince !== null ? '待機中' : 'ロビー'}</a>
          <a href="#/ranking">ランキング</a>
          <a href="#/settings">設定</a>
          <a href={`${import.meta.env.BASE_URL}help/account.html`}>ヘルプ</a>
        </nav>
      </header>
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
