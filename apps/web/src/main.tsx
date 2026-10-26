import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { boot } from './services/boot.js';
import { AppProvider } from './state/AppContext.js';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
root.render(<p className="loading">読み込み中…</p>);

boot().then(
  ({ deps, signer, backedUp }) =>
    root.render(
      <StrictMode>
        <AppProvider deps={deps} initialSigner={signer} initialBackedUp={backedUp}>
          <App />
        </AppProvider>
      </StrictMode>,
    ),
  (e) => root.render(<p className="error">起動できませんでした: {String(e)}</p>),
);
