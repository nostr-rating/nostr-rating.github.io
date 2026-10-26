import type { NostrEvent } from 'nostr-tools/pure';

export interface EventQuery {
  kinds?: number[];
  since?: number;
}

/** リレーから取得したイベントの手元キャッシュ */
export interface EventStore {
  put(evs: NostrEvent[]): Promise<void>;
  query(q: EventQuery): Promise<NostrEvent[]>;
  /** 指定 kind のうち created_at が指定時刻より前のものを消し、消した件数を返す */
  purgeBefore(createdAt: number, kinds: number[]): Promise<number>;
  /** false ならブラウザを閉じると消える */
  readonly persistent: boolean;
}
