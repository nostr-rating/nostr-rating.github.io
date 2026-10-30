import type { Filter } from 'nostr-tools/filter';
import type { NostrEvent } from 'nostr-tools/pure';
import { parseMatch } from '../events/codec.js';
import { APP_TAG, gameTag, isValidEvent, KIND } from '../events/kinds.js';
import type { GameDefinition } from '../game/definition.js';
import { attributor, KelBook, type KelRecords } from '../kel/book.js';
import { certOf, SESSION_LIFETIME_SEC, verifyCert, type SignedCert } from '../kel/cert.js';
import { aidsIn, warmKelSignatures } from '../kel/warm.js';
import type { Pubkey } from '../types.js';
import { dedupeById, type RelayClient } from './client.js';

/** 多くのリレーが1回に返す件数の上限より小さくしておく */
export const RATING_PAGE_SIZE = 300;
/** authors / ids / #e に一度に並べる数（大きいとリレーに拒否される） */
const CHUNK = 100;
/** 同時に投げる問い合わせの数（docs/adr/0011）。リレーごとに分けて投げるので、1つのリレーにもこの数まで */
const CONCURRENCY = 4;

export interface FetchOptions {
  pageSize?: number;
  /**
   * 取り切れないときの扱い。true なら、そのアカウントを incomplete に入れる（スナップショット生成用）。
   * false なら取れた分だけを使う（クライアントの表示用）
   */
  strict?: boolean;
  /**
   * known にないアカウントの記録済みの KEL を読む（docs/adr/0011。クライアントが、出てきたアカウントの分だけを読むため）。
   * 記録のないアカウントは返さなくてよい。その KEL はリレーから探す
   */
  loadKels?: (aids: Pubkey[]) => Promise<KelRecords>;
}

export interface FetchResult {
  events: NostrEvent[];
  /** 取り切れなかったアカウント。その回の計算では、これらの報告と公開情報を使わない（docs/spec.md「取得」） */
  incomplete: Set<Pubkey>;
  /** incomplete のうち、KEL と証明書のお知らせを取り切れなかったアカウント。その回は記録済みの KEL で判定する */
  incompleteKel: Set<Pubkey>;
}

class Overflow extends Error {}

/** fn を同時に limit 個まで走らせる。結果は items の順 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** ids を CHUNK ずつに分けて、同時に CONCURRENCY 個まで問い合わせる（取りこぼしを許す問い合わせ用） */
async function queryChunked(relay: RelayClient, key: 'ids' | '#d', values: string[], filter: Filter, pageSize: number): Promise<NostrEvent[]> {
  const results = await mapLimit(chunks(values, CHUNK), CONCURRENCY, (vs) => queryAll(relay, { ...filter, [key]: vs }, pageSize, false));
  return results.flat();
}

/** あるアカウントについて、ある鍵たちが署名したイベントを取り切る、という問い合わせの単位 */
interface Job {
  aid: Pubkey;
  authors: Pubkey[];
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

/**
 * docs/adr/0008「検索をあふれさせる攻撃」。レート計算に必要なイベントを集める。
 *
 * - 取り切る必要がある問い合わせは authors か ids だけにする。複数のアカウントをまとめて投げ、あふれたときだけ分ける。
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
  const incompleteKel = new Set<Pubkey>();
  const all: NostrEvent[] = [];

  /**
   * docs/adr/0011「問い合わせをまとめ、あふれたときだけ分ける」。複数のアカウントの鍵を authors に CHUNK まで並べて
   * 1回で問い合わせる。1つの秒に1ページを超えるイベントがあって取り切れなければ、アカウントを半分に分けて問い合わせ直し、
   * 1アカウントまで分けても取り切れないものだけを incomplete にする（アカウントごとに問い合わせたときと同じ結果になる）。
   * KEL は対戦の判定に使うので、ほかの種類を取り切れなかったアカウントでも取りに行き、別に数える
   */
  const perAccounts = async (jobs: Job[], filter: Filter): Promise<NostrEvent[]> => {
    const kel = filter.kinds?.includes(KIND.kel) ?? false;
    const skip = kel ? incompleteKel : incomplete;
    const run = async (batch: Job[]): Promise<NostrEvent[]> => {
      const live = batch.filter((j) => !skip.has(j.aid));
      if (live.length === 0) return [];
      try {
        return await queryAll(relay, { ...filter, authors: [...new Set(live.flatMap((j) => j.authors))] }, pageSize, strict);
      } catch (e) {
        if (!(e instanceof Overflow)) throw e;
        const aids = [...new Set(live.map((j) => j.aid))];
        if (aids.length === 1) {
          incomplete.add(aids[0]!);
          if (kel) incompleteKel.add(aids[0]!);
          return [];
        }
        const left = new Set(aids.slice(0, Math.ceil(aids.length / 2)));
        return [...(await run(live.filter((j) => left.has(j.aid)))), ...(await run(live.filter((j) => !left.has(j.aid))))];
      }
    };
    // 1アカウントの鍵が CHUNK を超えるときはそのアカウントだけで分け、残りは CHUNK に収まるまで詰める
    const batches: Job[][] = [];
    let cur: Job[] = [];
    let size = 0;
    for (const job of jobs.flatMap((j) => chunks(j.authors, CHUNK).map((authors) => ({ aid: j.aid, authors })))) {
      if (size + job.authors.length > CHUNK) {
        batches.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(job);
      size += job.authors.length;
    }
    if (cur.length > 0) batches.push(cur);
    return (await mapLimit(batches, CONCURRENCY, run)).flat();
  };

  // 1. KEL と証明書のお知らせ。既知のアカウントは鍵の持ち主ごとに、新しいアカウントは #t から見つける
  const from = since - SESSION_LIFETIME_SEC;
  // 対戦はこのゲームの分だけ。KEL はゲームに関係なくアカウントのもの
  all.push(...(await queryAll(relay, { kinds: [KIND.kel], '#t': [APP_TAG], since: from, until }, pageSize, false)));
  all.push(...(await queryAll(relay, { kinds: [KIND.match], '#t': [gameTag(def.id)], since: from, until }, pageSize, false)));
  // 1回の取得の中では同じ一覧にイベントを足していき、イベントが増えたアカウントだけを評価し直す
  const records: KelRecords = { ...known };
  const book = new KelBook(known, -Infinity, until);
  const asked = new Set<Pubkey>();
  /** 出てきたアカウントの記録済みの KEL を、まだ読んでいなければ読む */
  const recordFor = async (aids: Iterable<Pubkey>) => {
    if (!opts.loadKels) return;
    const want = [...new Set(aids)].filter((aid) => !records[aid] && !asked.has(aid));
    if (want.length === 0) return;
    want.forEach((aid) => asked.add(aid));
    const got = await opts.loadKels(want);
    for (const aid of want) if (got[aid]) records[aid] = got[aid];
    await warmKelSignatures(records, want);
    book.addRecorded(got);
  };
  /** 署名を先に速い実装で確かめてから、一覧に足す */
  const pushed = async (events: NostrEvent[]) => {
    await recordFor(aidsIn(events));
    await warmKelSignatures(records, aidsIn(events), events);
    if (events !== all) all.push(...events);
    book.add(events);
  };
  await pushed(all);
  const visited = new Set<Pubkey>();
  /** まだ問い合わせていない鍵の持ち主 */
  const newHolders = (): Job[] =>
    book
      .aids()
      .map((aid) => {
        const authors = book.holders(aid).filter((k) => !visited.has(`${aid}:${k}`));
        authors.forEach((k) => visited.add(`${aid}:${k}`));
        return { aid, authors };
      })
      .filter((j) => j.authors.length > 0);
  // 2周目は、1周目で鍵が増えたアカウント（新しい端末・入れ替え）を取り直す
  for (let round = 0; round < 2; round++) {
    await pushed(await perAccounts(newHolders(), { kinds: [KIND.kel, KIND.cert], since: from, until }));
  }

  /** イベントが持ち歩く証明書のうち、まだ知らないアカウントの KEL を掲載用の鍵から探す（作成が昔でも見つかる） */
  const discoverFrom = async (events: NostrEvent[]) => {
    const unknown = new Map<Pubkey, Pubkey>();
    for (const ev of events) {
      const c = certOf(ev);
      if (c?.cert && !book.states.has(c.cert.aid) && typeof c.cert.publisher === 'string') unknown.set(c.cert.publisher, c.cert.aid);
    }
    await recordFor(unknown.values());
    for (const [publisher, aid] of unknown) if (book.states.has(aid)) unknown.delete(publisher);
    if (unknown.size === 0) return pushed(await perAccounts(newHolders(), { kinds: [KIND.kel, KIND.cert], since: from, until }));
    await pushed(await perAccounts([...unknown].map(([publisher, aid]) => ({ aid, authors: [publisher] })), { kinds: [KIND.kel], until }));
    await pushed(await perAccounts(newHolders(), { kinds: [KIND.kel, KIND.cert], until }));
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
  /** お知らせの証明書と、イベントが持ち歩く証明書から、使い捨ての鍵を集める */
  const scanSessions = (events: NostrEvent[]) => {
    for (const ev of events) {
      if (ev.kind === KIND.cert) {
        try {
          addSession(JSON.parse(ev.content) as SignedCert);
        } catch {
          // 形の合わないお知らせは無視する
        }
      } else if (ev.kind === KIND.match || ev.kind === KIND.application) {
        addSession(certOf(ev));
      }
    }
  };
  scanSessions(all);

  // 3. 対戦・報告・紐づけ。使い捨ての鍵ごとに取り切る
  all.push(...(await perAccounts([...sessions].map(([aid, keys]) => ({ aid, authors: [...keys] })), { kinds: [KIND.match, KIND.report, KIND.account], since: from, until })));

  // 4. 報告が指す対戦のうち、まだ無いもの（ids）。相手の分を取り切れなくても、報告した側から対戦を見つける
  const have = new Set(all.map((e) => e.id));
  const pointed = new Set(all.filter((e) => e.kind === KIND.report).flatMap((e) => e.tags.filter((t) => t[0] === 'e' && t[1] && !have.has(t[1])).map((t) => t[1]!)));
  const referenced = await queryChunked(relay, 'ids', [...pointed], { kinds: [KIND.match] }, pageSize);
  all.push(...referenced);
  await discoverFrom(referenced);

  // 5. 対戦が指す申し込み（ids）。申し込みの使い捨ての鍵が新しければ、その鍵の報告も取る
  const author = attributor(book.states);
  const matches = dedupeById(all)
    .map((e) => parseMatch(def.id, e, author(e)))
    .filter((m) => m !== null);
  const applications = await queryChunked(relay, 'ids', [...new Set(matches.map((m) => m.applicationId))], { kinds: [KIND.application] }, pageSize);
  const before = new Map([...sessions].map(([aid, s]) => [aid, new Set(s)]));
  all.push(...applications);
  await discoverFrom(applications);
  // 対戦や申し込みから後で見つけたアカウントは、そのとき取った証明書のお知らせからも鍵を集める
  scanSessions(all);
  const added = [...sessions].map(([aid, keys]) => ({ aid, authors: [...keys].filter((k) => !before.get(aid)?.has(k)) })).filter((j) => j.authors.length > 0);
  all.push(...(await perAccounts(added, { kinds: [KIND.report], since: from, until })));

  // 6. 紐づけは古い使い捨ての鍵で出したこともあるので、d（aid）でも探す（取りこぼしを許す）
  const players = [...new Set(matches.flatMap((m) => [m.p1, m.p2]))];
  all.push(...(await queryChunked(relay, '#d', players, { kinds: [KIND.account], until }, pageSize)));

  return { events: dedupeById(all), incomplete, incompleteKel };
}
