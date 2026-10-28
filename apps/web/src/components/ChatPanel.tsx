import { useState } from 'react';

export interface ChatLine {
  mine: boolean;
  text: string;
  at: number;
}

export function ChatPanel({ lines, onSend, note }: { lines: ChatLine[]; onSend: (text: string) => Promise<void>; note: string }) {
  const [text, setText] = useState('');
  return (
    <div className="card stack">
      <h3>連絡</h3>
      <div className="chat">
        {lines.length === 0 && <p className="muted">メッセージはまだありません。</p>}
        {lines.map((l, i) => (
          <p key={i} className={l.mine ? '' : 'muted'}>
            {l.mine ? 'あなた' : '相手'}: {l.text}
          </p>
        ))}
      </div>
      <div className="row">
        <input aria-label="メッセージ" value={text} onChange={(e) => setText(e.target.value)} style={{ flex: 1 }} />
        <button
          type="button"
          disabled={text.trim() === ''}
          onClick={() => {
            const t = text.trim();
            setText('');
            void onSend(t);
          }}
        >
          送る
        </button>
      </div>
      <p className="muted" data-testid="chat-note">{note}</p>
    </div>
  );
}
