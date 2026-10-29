import type { Filter } from 'nostr-tools/filter';
import { AbstractSimplePool } from 'nostr-tools/abstract-pool';
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

/** strict のときに1つの問い合わせを試す回数 */
const STRICT_ATTEMPTS = 3;

export function dedupeById(events: NostrEvent[]): NostrEvent[] {
  const seen = new Map<string, NostrEvent>();
  for (const e of events) if (!seen.has(e.id)) seen.set(e.id, e);
  return [...seen.values()];
}

/** EOSE を待つのに使うリレーの形（nostr-tools の AbstractRelay の一部） */
export interface EoseRelay {
  subscribe(
    filters: Filter[],
    params: { onevent?(ev: NostrEvent): void; oneose?(): void; onclose?(reason: string): void; eoseTimeout?: number },
  ): { close(reason?: string): void };
}

/**
 * EOSE までに届いたイベントを返す。時間切れのときと、EOSE の前に購読を閉じられたとき（rate-limited など）は失敗にする。
 * nostr-tools の querySync はどちらの場合もそれまでに届いた分を返すので、取りこぼしと「無い」を区別できない
 */
export function queryUntilEose(relay: EoseRelay, filter: Filter, maxWait: number): Promise<NostrEvent[]> {
  return new Promise((resolve, reject) => {
    const events: NostrEvent[] = [];
    let done = false;
    const finish = (err: Error | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(events);
    };
    const timer = setTimeout(() => {
      finish(new Error(`no EOSE within ${maxWait}ms`));
      sub.close();
    }, maxWait);
    const sub = relay.subscribe([filter], {
      // nostr-tools は時間切れも EOSE として扱うので、こちらの時間切れが先に来るようにする
      eoseTimeout: maxWait * 2,
      onevent: (e) => events.push(e),
      oneose: () => {
        finish(null);
        sub.close();
      },
      onclose: (reason) => finish(new Error(`closed before EOSE: ${reason}`)),
    });
  });
}

/** 失敗したら、待つ時間を延ばしながら attempts 回まで試す */
export async function withRetries<T>(fn: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }
}

/**
 * nostr-tools のプールは、署名を確かめる前に id を「受け取り済み」にする。
 * そのため、偽の中身を付けた同じ id を先に返すリレーがあると、正直なリレーの本物が捨てられる。
 * これを避けるため、リレーごとに問い合わせ、署名を確かめてから重複を除く。
 *
 * strict にすると、どれかのリレーから取り切れなかった問い合わせは、数回試し直したうえで失敗にする（スナップショット生成用）。
 * 既定では、つながらないリレーや時間切れの分は、届いた分だけを使う（画面の表示用）
 */
export function createNostrRelayClient(urls: string[], opts: { maxWaitMs?: number; strict?: boolean } = {}): RelayClient {
  // スマホで画面が消えると接続が切れるので、再接続と購読の張り直しを有効にする
  // 届いたイベントの署名は、こちらの控えを使う検証で確かめる（同じイベントを2回確かめない。docs/adr/0011）
  const pool = new AbstractSimplePool({
    enableReconnect: true,
    enablePing: true,
    maxWaitForConnection: 3000,
    websocketImplementation: globalThis.WebSocket,
    verifyEvent: (ev) => isValidEvent(ev),
  });
  const maxWait = opts.maxWaitMs ?? 4000;
  const one = (url: string): RelayClient => ({
    async publish(ev) {
      await Promise.any(pool.publish([url], ev, { maxWait }));
    },
    async query(filters) {
      const one = (f: Filter) =>
        opts.strict
          ? withRetries(() => pool.ensureRelay(url, { connectionTimeout: maxWait }).then((r) => queryUntilEose(r, f, maxWait)), STRICT_ATTEMPTS, 2000).catch(
              (e: unknown) => {
                throw new Error(`${url}: ${e instanceof Error ? e.message : String(e)}`);
              },
            )
          : pool.querySync([url], f, { maxWait });
      const results = await Promise.all(filters.map(one));
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
