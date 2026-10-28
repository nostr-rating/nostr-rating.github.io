import { useState } from 'react';

export interface ChatLine {
  mine: boolean;
  text: string;
  at: number;
}

export function ChatPanel({ lines, onSend, note }: { lines: ChatLine[]; onSend: (text: string) => Promise<void>; note: string }) {
  const [text, setText] = useState('');
  const submit = () => {
    const t = text.trim();
    if (t === '') return;
    setText('');
    void onSend(t);
  };
  return (
    <div className="card">
      <h3>連絡</h3>
      <div className="chat">
        {lines.length === 0 && <p className="muted">メッセージはまだありません。</p>}
        {lines.map((l, i) => (
          <p key={i} className={l.mine ? 'mine' : 'theirs'}>
            <span className="sr-only">{l.mine ? 'あなた' : '相手'}: </span>
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
        <input aria-label="メッセージ" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit" disabled={text.trim() === ''}>
          送る
        </button>
      </form>
      <p className="hint" data-testid="chat-note">{note}</p>
    </div>
  );
}
