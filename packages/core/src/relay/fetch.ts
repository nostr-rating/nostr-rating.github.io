import type { Filter } from 'nostr-tools/filter';
import type { NostrEvent } from 'nostr-tools/pure';
import { parseMatch } from '../events/codec.js';
import { APP_TAG, isValidEvent, KIND } from '../events/kinds.js';
import type { GameDefinition } from '../game/definition.js';
import { attributor, buildKelBook, type KelRecords } from '../kel/book.js';
import { certOf, SESSION_LIFETIME_SEC, verifyCert, type SignedCert } from '../kel/cert.js';
import type { KelState } from '../kel/kel.js';
import type { Pubkey } from '../types.js';
import { dedupeById, type RelayClient } from './client.js';

/** 多くのリレーが1回に返す件数の上限より小さくしておく */
export const RATING_PAGE_SIZE = 300;
/** authors / ids / #e に一度に並べる数（大きいとリレーに拒否される） */
const CHUNK = 100;

export interface FetchOptions {
  pageSize?: number;
  /**
   * 取り切れないときの扱い。true なら、そのアカウントを incomplete に入れる（スナップショット生成用）。
   * false なら取れた分だけを使う（クライアントの表示用）
   */
  strict?: boolean;
}

export interface FetchResult {
  events: NostrEvent[];
  /** 取り切れなかったアカウント。その回の計算では、これらが署名したイベントを無視する */
  incomplete: Set<Pubkey>;
}

class Overflow extends Error {}

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
      if (strict) throw new Overflow(`more than ${pageSize} events at ${oldest}`);
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

/** そのアカウントの鍵の持ち主（掲載用の鍵と、今の次の鍵） */
function keyHolders(state: KelState): Pubkey[] {
  const out = new Set<Pubkey>(state.next.keys);
  for (const d of state.devices.values()) out.add(d.record.publisher);
  return [...out];
}

/**
 * docs/adr/0008「検索をあふれさせる攻撃」。レート計算に必要なイベントを集める。
 *
 * - 取り切る必要がある問い合わせは authors か ids だけにし、アカウントごとに分けて投げる。
 *   取り切れなければそのアカウントだけを incomplete にし、全体は止めない
 * - #t の問い合わせは、新しいアカウントと、そのアカウントの対戦を見つけるきっかけにだけ使う
 * - 見つけ方は下からたどる。KEL → 証明書のお知らせ → 使い捨ての鍵 → 対戦 → 申し込みと報告
 */
export async function fetchRatingEvents(
  relay: RelayClient,
  def: GameDefinition,
  known: KelRecords,
  since: number,
  until: number,
  opts: FetchOptions = {},
): Promise<FetchResult> {
  const pageSize = opts.pageSize ?? RATING_PAGE_SIZE;
  const strict = opts.strict ?? false;
  const incomplete = new Set<Pubkey>();
  const all: NostrEvent[] = [];

  /** アカウント1つ分の問い合わせ。取り切れなければそのアカウントを incomplete にする */
  const perAccount = async (aid: Pubkey, filter: Filter): Promise<NostrEvent[]> => {
    if (incomplete.has(aid)) return [];
    try {
      return await queryAll(relay, filter, pageSize, strict);
    } catch (e) {
      if (!(e instanceof Overflow)) throw e;
      incomplete.add(aid);
      return [];
    }
  };

  // 1. KEL と証明書のお知らせ。既知のアカウントは鍵の持ち主ごとに、新しいアカウントは #t から見つける
  const from = since - SESSION_LIFETIME_SEC;
  all.push(...(await queryAll(relay, { kinds: [KIND.kel, KIND.match], '#t': [APP_TAG], since: from, until }, pageSize, false)));
  let book = buildKelBook(known, all, -Infinity, until);
  const visited = new Set<Pubkey>();
  // 2周目は、1周目で鍵が増えたアカウント（新しい端末・入れ替え）を取り直す
  for (let round = 0; round < 2; round++) {
    for (const [aid, state] of book.states) {
      const holders = keyHolders(state).filter((k) => !visited.has(`${aid}:${k}`));
      holders.forEach((k) => visited.add(`${aid}:${k}`));
      for (const authors of chunks(holders, CHUNK)) {
        all.push(...(await perAccount(aid, { kinds: [KIND.kel, KIND.cert], authors, since: from, until })));
      }
    }
    book = buildKelBook(known, all, -Infinity, until);
  }

  /** イベントが持ち歩く証明書のうち、まだ知らないアカウントの KEL を掲載用の鍵から探す（作成が昔でも見つかる） */
  const discoverFrom = async (events: NostrEvent[]) => {
    const unknown = new Map<Pubkey, Pubkey>();
    for (const ev of events) {
      const c = certOf(ev);
      if (c?.cert && !book.states.has(c.cert.aid) && typeof c.cert.publisher === 'string') unknown.set(c.cert.publisher, c.cert.aid);
    }
    if (unknown.size === 0) return;
    for (const [publisher, aid] of unknown) {
      all.push(...(await perAccount(aid, { kinds: [KIND.kel], authors: [publisher], until })));
    }
    book = buildKelBook(known, all, -Infinity, until);
    for (const [aid, state] of book.states) {
      const holders = keyHolders(state).filter((k) => !visited.has(`${aid}:${k}`));
      holders.forEach((k) => visited.add(`${aid}:${k}`));
      for (const authors of chunks(holders, CHUNK)) {
        all.push(...(await perAccount(aid, { kinds: [KIND.kel, KIND.cert], authors, until })));
      }
    }
    book = buildKelBook(known, all, -Infinity, until);
  };
  await discoverFrom(all.filter((e) => e.kind === KIND.match));

  // 2. アカウントごとの使い捨ての鍵（お知らせの証明書と、イベントが持ち歩く証明書の両方から）
  const sessions = new Map<Pubkey, Set<Pubkey>>();
  const addSession = (signed: SignedCert | null) => {
    if (!signed?.cert) return;
    const state = book.states.get(signed.cert.aid);
    if (!state || !verifyCert(state, signed, { pubkey: signed.cert.session, created_at: signed.cert.from })) return;
    const set = sessions.get(signed.cert.aid) ?? new Set<Pubkey>();
    set.add(signed.cert.session);
    sessions.set(signed.cert.aid, set);
  };
  for (const ev of all) {
    if (ev.kind === KIND.cert) {
      try {
        addSession(JSON.parse(ev.content) as SignedCert);
      } catch {
        // 形の合わないお知らせは無視する
      }
    } else if (ev.kind === KIND.match) {
      addSession(certOf(ev));
    }
  }

  // 3. 対戦・報告・紐づけ。使い捨ての鍵ごとに取り切る
  for (const [aid, keys] of sessions) {
    for (const authors of chunks([...keys], CHUNK)) {
      all.push(...(await perAccount(aid, { kinds: [KIND.match, KIND.report, KIND.account], authors, since: from, until })));
    }
  }

  // 4. 対戦が指す申し込み（ids）。申し込みの使い捨ての鍵が新しければ、その鍵の報告も取る
  const author = attributor(book.states);
  const matches = dedupeById(all)
    .map((e) => parseMatch(def.id, e, author(e)))
    .filter((m) => m !== null);
  const applications: NostrEvent[] = [];
  for (const ids of chunks([...new Set(matches.map((m) => m.applicationId))], CHUNK)) {
    applications.push(...(await queryAll(relay, { kinds: [KIND.application], ids }, pageSize, false)));
  }
  all.push(...applications);
  await discoverFrom(applications);
  const before = new Map([...sessions].map(([aid, s]) => [aid, new Set(s)]));
  for (const ev of applications) addSession(certOf(ev));
  for (const [aid, keys] of sessions) {
    const added = [...keys].filter((k) => !before.get(aid)?.has(k));
    for (const authors of chunks(added, CHUNK)) {
      all.push(...(await perAccount(aid, { kinds: [KIND.report], authors, since: from, until })));
    }
  }

  // 5. 紐づけは古い使い捨ての鍵で出したこともあるので、d（aid）でも探す（取りこぼしを許す）
  const players = [...new Set(matches.flatMap((m) => [m.p1, m.p2]))];
  for (const d of chunks(players, CHUNK)) {
    all.push(...(await queryAll(relay, { kinds: [KIND.account], '#d': d }, pageSize, false)));
  }

  return { events: dedupeById(all), incomplete };
}
