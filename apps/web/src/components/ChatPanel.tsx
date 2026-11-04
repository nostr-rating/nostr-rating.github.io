import { useState } from 'react';
import { messages, useT } from '../i18n.js';

const M = messages({
  ja: { title: '連絡', empty: 'メッセージはまだありません。', you: 'あなた', opponent: '相手', message: 'メッセージ', send: '送る' },
  en: { title: 'Messages', empty: 'No messages yet.', you: 'You', opponent: 'Opponent', message: 'Message', send: 'Send' },
});

export interface ChatLine {
  mine: boolean;
  text: string;
  at: number;
}

export function ChatPanel({ lines, onSend, note }: { lines: ChatLine[]; onSend: (text: string) => Promise<void>; note: string }) {
  const t = useT(M);
  const [text, setText] = useState('');
  const submit = () => {
    const body = text.trim();
    if (body === '') return;
    setText('');
    void onSend(body);
  };
  return (
    <div className="card">
      <h3>{t.title}</h3>
      <div className="chat">
        {lines.length === 0 && <p className="muted">{t.empty}</p>}
        {lines.map((l, i) => (
          <p key={i} className={l.mine ? 'mine' : 'theirs'}>
            <span className="sr-only">{l.mine ? t.you : t.opponent}: </span>
            {l.text}
          </p>
        ))}
      </div>
      <form
        className="send-row"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input aria-label={t.message} value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit" disabled={text.trim() === ''}>
          {t.send}
        </button>
      </form>
      <p className="hint" data-testid="chat-note">{note}</p>
    </div>
  );
}
