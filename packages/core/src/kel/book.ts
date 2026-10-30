import type { EventTemplate, NostrEvent } from 'nostr-tools/pure';
import type { Signer } from '../identity/signer.js';
import { isValidEvent, KIND } from '../events/kinds.js';
import type { Pubkey } from '../types.js';
import { certOf, certTags, verifyCert, type SignedCert } from './cert.js';
import { parseKelEvent } from './event.js';
import { digestOf, evaluateKel, type KelInput, type KelState } from './kel.js';

/** aid → KEL のイベント（先に見た順）。スナップショットに残し、全員の「先に見た版」にする */
export type KelRecords = Record<string, KelInput[]>;

/** aid → 評価した KEL。get したときに初めて評価する（Map もこの形を満たす） */
export interface KelStates {
  get(aid: string): KelState | undefined;
  has(aid: string): boolean;
}

interface Fresh {
  input: KelInput;
  id: string;
  createdAt: number;
}

/**
 * 記録済みの KEL に、イベントの中の kind 3753 を足して評価する（docs/adr/0011）。
 * 記録済みのアカウントへの新しいイベントは、created_at が (acceptAfter, acceptUntil] のものだけを受け付ける。
 * 日付を遡らせたイベントが効くのを、この幅の中に限るため（docs/adr/0008「時計」）。
 * まだ記録のないアカウントは、比べる先の版がないので、acceptUntil までのすべてを受け付ける。
 *
 * 評価はアカウントごとに、使うときに初めて行い、イベントが増えたアカウントだけを評価し直す。
 * 記録済みの KEL を確かめずに使うことはしない（偽の KEL で他人の端末を足せるため）
 */
export class KelBook {
  #recorded: KelRecords;
  readonly #fresh = new Map<string, Map<string, Fresh>>();
  readonly #evaluated = new Map<string, KelState | null>();

  readonly states: KelStates = {
    get: (aid) => this.#state(aid) ?? undefined,
    has: (aid) => this.#state(aid) !== null,
  };

  constructor(
    recorded: KelRecords,
    private readonly acceptAfter: number,
    private readonly acceptUntil: number,
  ) {
    this.#recorded = recorded;
  }

  add(events: NostrEvent[]): this {
    for (const ev of events) {
      if (ev.kind !== KIND.kel || ev.created_at > this.acceptUntil) continue;
      const parsed = parseKelEvent(ev);
      if (!parsed || (this.#recorded[parsed.aid] && ev.created_at <= this.acceptAfter)) continue;
      const fresh = this.#fresh.get(parsed.aid) ?? new Map<string, Fresh>();
      if (fresh.has(ev.id)) continue;
      fresh.set(ev.id, { input: parsed.input, id: ev.id, createdAt: ev.created_at });
      this.#fresh.set(parsed.aid, fresh);
      this.#evaluated.delete(parsed.aid);
    }
    return this;
  }

  /**
   * 記録済みの KEL をあとから足す（クライアントが、必要なアカウントの分だけを読んだとき）。
   * すでに記録のあるアカウントは変えない。足したアカウントの新しいイベントは、受け付ける幅で選び直す
   */
  addRecorded(records: KelRecords): this {
    const added = Object.keys(records).filter((aid) => !this.#recorded[aid]);
    if (added.length === 0) return this;
    this.#recorded = { ...this.#recorded, ...Object.fromEntries(added.map((aid) => [aid, records[aid]!])) };
    for (const aid of added) {
      const fresh = this.#fresh.get(aid);
      if (fresh) for (const [id, f] of fresh) if (f.createdAt <= this.acceptAfter) fresh.delete(id);
      if (fresh?.size === 0) this.#fresh.delete(aid);
      this.#evaluated.delete(aid);
    }
    return this;
  }

  /** 記録済みか、新しいイベントのあるアカウント（まだ評価していないものも含む） */
  aids(): string[] {
    return [...new Set([...Object.keys(this.#recorded), ...this.#fresh.keys()])];
  }

  /**
   * そのアカウントの鍵の持ち主（掲載用の鍵と、今の次の鍵）。問い合わせの手がかりにだけ使う。
   * 新しいイベントのないアカウントは、記録済みの KEL を評価せずに読む（署名を確かめるのは使うときでよい）
   */
  holders(aid: string): Pubkey[] {
    const state = this.#fresh.has(aid) || this.#evaluated.has(aid) ? this.#state(aid) : null;
    if (state) return keyHolders(state);
    const out = new Set<Pubkey>();
    let next: Pubkey[] = [];
    for (const { entry } of this.#recorded[aid] ?? []) {
      const b = entry.body;
      for (const d of b.t === 'ixn' ? b.add : b.devices) out.add(d.publisher);
      if (b.t !== 'ixn') next = b.next.keys;
    }
    for (const k of next) out.add(k);
    return [...out];
  }

  /** 記録済みの分に、今回採用した分を足したもの（sn の順）。新しいイベントのないアカウントは評価しない */
  get records(): KelRecords {
    const out: KelRecords = {};
    for (const aid of this.aids()) {
      const old = this.#recorded[aid] ?? [];
      if (!this.#fresh.has(aid)) {
        out[aid] = old;
        continue;
      }
      const state = this.#state(aid);
      if (!state) {
        if (old.length > 0) out[aid] = old;
        continue;
      }
      const byDigest = new Map<string, KelInput>();
      for (const i of this.#inputs(aid)) {
        const d = digestOfEntry(i);
        if (!byDigest.has(d)) byDigest.set(d, i);
      }
      out[aid] = state.digests.map((d) => byDigest.get(d)!);
    }
    return out;
  }

  /** 今回新しく採用した KEL のイベントの Nostr の id */
  get usedEventIds(): string[] {
    const out: string[] = [];
    for (const [aid, fresh] of this.#fresh) {
      const state = this.#state(aid);
      if (!state) continue;
      const chain = new Set(state.digests);
      for (const f of fresh.values()) if (chain.has(digestOfEntry(f.input))) out.push(f.id);
    }
    return out;
  }

  /** 記録済みの KEL を全員分確かめる。記録したとおりに評価できないアカウントがあれば止める（スナップショットの生成用） */
  verifyRecorded(): void {
    for (const [aid, old] of Object.entries(this.#recorded)) {
      const state = evaluateKel(aid, old);
      const digests = old.map(digestOfEntry);
      if (!state || state.digests.length !== digests.length || state.digests.some((d, i) => d !== digests[i])) {
        throw new Error(`recorded KEL does not verify: ${aid}`);
      }
    }
  }

  /** 先に見た順: 記録済みの順、そのあとは created_at, id の順 */
  #inputs(aid: string): KelInput[] {
    const fresh = [...(this.#fresh.get(aid)?.values() ?? [])].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return [...(this.#recorded[aid] ?? []), ...fresh.map((f) => f.input)];
  }

  #state(aid: string): KelState | null {
    if (this.#evaluated.has(aid)) return this.#evaluated.get(aid)!;
    const state = this.#recorded[aid] || this.#fresh.has(aid) ? evaluateKel(aid, this.#inputs(aid)) : null;
    this.#evaluated.set(aid, state);
    return state;
  }
}

export function buildKelBook(recorded: KelRecords, events: NostrEvent[], acceptAfter: number, acceptUntil: number): KelBook {
  return new KelBook(recorded, acceptAfter, acceptUntil).add(events);
}

/** そのアカウントの鍵の持ち主（掲載用の鍵と、今の次の鍵） */
function keyHolders(state: KelState): Pubkey[] {
  const out = new Set<Pubkey>(state.next.keys);
  for (const d of state.devices.values()) out.add(d.record.publisher);
  return [...out];
}

const digestOfEntry = (i: KelInput) => digestOf(i.entry.body);

/** 使い捨ての鍵が署名したイベントを、証明書から aid に結び付ける。結び付かなければ null */
export type Attributor = (ev: NostrEvent) => Pubkey | null;

export function attributor(states: KelStates): Attributor {
  const cache = new WeakMap<NostrEvent, Pubkey | null>();
  return (ev) => {
    if (cache.has(ev)) return cache.get(ev)!;
    // 証明書は署名したイベントの pubkey と時刻を見るので、イベントの署名も確かめる
    const signed = isValidEvent(ev) ? certOf(ev) : null;
    let aid: Pubkey | null = null;
    if (signed) {
      const state = states.get(signed.cert.aid);
      if (state && verifyCert(state, signed, ev)) aid = signed.cert.aid;
    }
    cache.set(ev, aid);
    return aid;
  };
}

/** アカウントとして振る舞うための、使い捨ての鍵と証明書 */
export interface SessionIdentity {
  aid: Pubkey;
  signer: Signer;
  cert: SignedCert;
}

/** 証明書のタグを足して、使い捨ての鍵で署名する */
export async function signAs(id: SessionIdentity, t: EventTemplate): Promise<NostrEvent> {
  return id.signer.signEvent({ ...t, tags: [...t.tags, ...certTags(id.cert)] });
}
