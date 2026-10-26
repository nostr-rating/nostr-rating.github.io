import type { Filter } from 'nostr-tools/filter';
import { SimplePool } from 'nostr-tools/pool';
import type { NostrEvent } from 'nostr-tools/pure';
import { isValidEvent } from '../events/kinds.js';

export type { Filter };

export interface RelayClient {
  /** 少なくとも1つのリレーが受け取れば成功 */
  publish(ev: NostrEvent): Promise<void>;
  /** 保存済みのイベントを取得する。ID で重複除去済み */
  query(filters: Filter[]): Promise<NostrEvent[]>;
  /** 保存済みと以後のイベントを受け取る。戻り値で購読をやめる */
  subscribe(filters: Filter[], onEvent: (ev: NostrEvent) => void): () => void;
  close(): void;
  /** リレーごとに問い合わせられる場合の、1リレーずつのクライアント（ページ送りはリレーごとに行う） */
  perRelay?(): RelayClient[];
}

export function dedupeById(events: NostrEvent[]): NostrEvent[] {
  const seen = new Map<string, NostrEvent>();
  for (const e of events) if (!seen.has(e.id)) seen.set(e.id, e);
  return [...seen.values()];
}

/**
 * nostr-tools のプールは、署名を確かめる前に id を「受け取り済み」にする。
 * そのため、偽の中身を付けた同じ id を先に返すリレーがあると、正直なリレーの本物が捨てられる。
 * これを避けるため、リレーごとに問い合わせ、署名を確かめてから重複を除く。
 */
export function createNostrRelayClient(urls: string[], opts: { maxWaitMs?: number } = {}): RelayClient {
  // スマホで画面が消えると接続が切れるので、再接続と購読の張り直しを有効にする
  const pool = new SimplePool({ enableReconnect: true, enablePing: true });
  const maxWait = opts.maxWaitMs ?? 4000;
  const one = (url: string): RelayClient => ({
    async publish(ev) {
      await Promise.any(pool.publish([url], ev, { maxWait }));
    },
    async query(filters) {
      const results = await Promise.all(filters.map((f) => pool.querySync([url], f, { maxWait }).catch(() => [])));
      return dedupeById(results.flat().filter((e) => isValidEvent(e)));
    },
    subscribe(filters, onEvent) {
      const subs = filters.map((f) => pool.subscribeMany([url], f, { onevent: (ev) => isValidEvent(ev) && onEvent(ev) }));
      return () => subs.forEach((s) => s.close());
    },
    close() {
      pool.close([url]);
    },
  });
  const relays = urls.map(one);
  return {
    async publish(ev) {
      await Promise.any(relays.map((r) => r.publish(ev)));
    },
    async query(filters) {
      return dedupeById((await Promise.all(relays.map((r) => r.query(filters)))).flat());
    },
    subscribe(filters, onEvent) {
      const seen = new Set<string>();
      const subs = relays.map((r) =>
        r.subscribe(filters, (ev) => {
          if (seen.has(ev.id)) return;
          seen.add(ev.id);
          onEvent(ev);
        }),
      );
      return () => subs.forEach((s) => s());
    },
    close() {
      pool.close(urls);
    },
    perRelay: () => relays,
  };
}
