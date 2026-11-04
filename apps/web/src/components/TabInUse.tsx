import { messages, useT } from '../i18n.js';

const M = messages({
  ja: {
    title: '複数のタブでは使えません',
    body: 'Nostr-Rating は、複数のタブで同時に開くことはできません。すでに開いているタブでご利用ください。',
    hint: 'このタブで使うときは、ほかのタブを閉じてから押してください。',
    reload: 'このタブで開き直す',
  },
  en: {
    title: 'Open in another tab',
    body: 'Nostr-Rating cannot be open in more than one tab at a time. Please use the tab where it is already open.',
    hint: 'To use it in this tab, close the other tab first, then press the button.',
    reload: 'Reopen in this tab',
  },
});

/**
 * 保存先を別のタブが開いているとき（storage/db.ts の StorageInUseError）に、アプリの代わりに出す。
 * 2つのタブで同じアカウントの対戦や同期が動かないよう、ほかの画面は出さない
 */
export function TabInUse() {
  const t = useT(M);
  return (
    <div className="app">
      <main>
        <section className="card tab-in-use" role="alert">
          <h1>{t.title}</h1>
          <p>{t.body}</p>
          <p className="muted">{t.hint}</p>
          <button type="button" className="primary wide" onClick={() => location.reload()}>
            {t.reload}
          </button>
        </section>
      </main>
    </div>
  );
}
