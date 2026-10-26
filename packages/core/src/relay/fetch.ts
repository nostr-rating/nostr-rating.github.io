import type { Filter } from 'nostr-tools/filter';
import type { NostrEvent } from 'nostr-tools/pure';
import { parseMatch } from '../events/codec.js';
import { APP_TAG, isValidEvent, KIND } from '../events/kinds.js';
import type { GameDefinition } from '../game/definition.js';
import type { Pubkey } from '../types.js';
import { dedupeById, type RelayClient } from './client.js';

/** 多くのリレーが1回に返す件数の上限より小さくしておく */
const DEFAULT_PAGE_SIZE = 300;
/** authors / ids / #e に一度に並べる数（大きいとリレーに拒否される） */
const CHUNK = 100;

export interface FetchOptions {
  pageSize?: number;
  /** 同じ秒のイベントが1ページを超えて取り切れないときに失敗させる（スナップショット生成用） */
  strict?: boolean;
  /** 対戦を作成者でも取り直すプレイヤー（#t で取れた分に加える） */
  knownPlayers?: Pubkey[];
  /** 作成者ごとの問い合わせで、一度に並べる作成者の数。1 にすると他人のスパムの影響を受けない */
  authorsPerQuery?: number;
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** 1つのリレーに対して、until を古い方へずらしながら取り切る */
async function pageOne(relay: RelayClient, filter: Filter, pageSize: number, strict: boolean): Promise<NostrEvent[]> {
  const out = new Map<string, NostrEvent>();
  let until = filter.until;
  for (;;) {
    const page = (await relay.query([{ ...filter, ...(until !== undefined ? { until } : {}), limit: pageSize }])).filter((e) =>
      isValidEvent(e),
    );
    let added = 0;
    for (const e of page) {
      if (!out.has(e.id)) {
        out.set(e.id, e);
        added++;
      }
    }
    if (page.length < pageSize) break;
    const oldest = Math.min(...page.map((e) => e.created_at));
    if (added === 0) {
      // 同じ秒のイベントが1ページを超えていて、この条件ではその秒を取り切れない
      if (strict) {
        throw new Error(`a relay returned more than ${pageSize} events created at ${oldest}; refusing to build a snapshot from a truncated result`);
      }
      until = oldest - 1;
    } else {
      until = oldest;
    }
    if (filter.since !== undefined && until < filter.since) break;
  }
  return [...out.values()];
}

/** リレーごとにページ送りしてから、まとめて重複を除く（浅いリレーの最古で全体を区切らない） */
async function queryAll(relay: RelayClient, filter: Filter, pageSize: number, strict: boolean): Promise<NostrEvent[]> {
  const relays = relay.perRelay?.() ?? [relay];
  const results = await Promise.all(relays.map((r) => pageOne(r, filter, pageSize, strict)));
  return dedupeById(results.flat());
}

/**
 * レート計算に必要なイベントを集める。スナップショット生成とクライアントの両方が同じ集め方をする。
 * 1. since〜until の対戦（#t と、分かっているプレイヤーの作成分）
 * 2. 対戦が参照する申し込み
 * 3. 結果報告は当事者が作成したものだけを、当事者ごとに取る（他人のスパムで押し出されない）
 * 4. 対戦に出た公開鍵の NIP-39
 */
export async function fetchRatingEvents(
  relay: RelayClient,
  def: GameDefinition,
  since: number,
  until: number,
  opts: FetchOptions = {},
): Promise<NostrEvent[]> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const strict = opts.strict ?? false;
  const perQuery = Math.max(1, opts.authorsPerQuery ?? 20);

  const matchEvents = await queryAll(relay, { kinds: [KIND.match], '#t': [APP_TAG], since, until }, pageSize, strict);
  // #t の結果は同じ秒のスパムで押し出されうるので、分かっているプレイヤーの作成分は作成者で取り直す。
  // #t の結果から見つけた作成者は混ぜない（スパムの送信者と同じ問い合わせにならないように）
  for (const authors of chunks([...new Set(opts.knownPlayers ?? [])], perQuery)) {
    matchEvents.push(...(await queryAll(relay, { kinds: [KIND.match], authors, since, until }, pageSize, strict)));
  }

  const matches = dedupeById(matchEvents)
    .map((e) => parseMatch(def.id, e))
    .filter((m) => m !== null);
  const players = new Set<Pubkey>();
  const matchesOf = new Map<Pubkey, string[]>();
  for (const m of matches) {
    for (const pk of [m.p1, m.p2]) {
      players.add(pk);
      matchesOf.set(pk, [...(matchesOf.get(pk) ?? []), m.id]);
    }
  }

  const extra: NostrEvent[] = [];
  for (const ids of chunks([...new Set(matches.map((m) => m.applicationId))], CHUNK)) {
    extra.push(...(await queryAll(relay, { kinds: [KIND.application], ids }, pageSize, strict)));
  }
  for (const authors of chunks([...players], perQuery)) {
    const matchIds = [...new Set(authors.flatMap((pk) => matchesOf.get(pk) ?? []))];
    for (const e of chunks(matchIds, CHUNK)) {
      extra.push(...(await queryAll(relay, { kinds: [KIND.report], authors, '#e': e, until }, pageSize, strict)));
    }
  }
  for (const authors of chunks([...players], CHUNK)) {
    extra.push(...(await queryAll(relay, { kinds: [KIND.identities], authors }, pageSize, strict)));
  }
  return dedupeById([...matchEvents, ...extra]);
}
