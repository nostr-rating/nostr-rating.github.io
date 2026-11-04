import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { messages, tr } from './i18n.js';
import { boot } from './services/boot.js';
import { AppProvider } from './state/AppContext.js';
import './styles.css';

const M = messages({
  ja: { loading: '読み込み中…', failed: (e: string) => `起動できませんでした: ${e}` },
  en: { loading: 'Loading…', failed: (e: string) => `Could not start: ${e}` },
});

const root = createRoot(document.getElementById('root')!);
root.render(<p className="loading">{tr(M).loading}</p>);

boot().then(
  ({ deps, account }) =>
    root.render(
      <StrictMode>
        <AppProvider deps={deps} initialAccount={account}>
          <App />
        </AppProvider>
      </StrictMode>,
    ),
  (e) => root.render(<p className="error">{tr(M).failed(String(e))}</p>),
);
