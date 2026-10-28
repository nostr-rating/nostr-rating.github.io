import type { EventTemplate, NostrEvent } from 'nostr-tools/pure';
import type { Signer } from '../identity/signer.js';
import { isValidEvent } from '../events/kinds.js';
import type { Pubkey } from '../types.js';
import { certOf, certTags, verifyCert, type SignedCert } from './cert.js';
import { parseKelEvent, seenOrder } from './event.js';
import { digestOf, evaluateKel, type KelInput, type KelState } from './kel.js';

/** aid → KEL のイベント（先に見た順）。スナップショットに残し、全員の「先に見た版」にする */
export type KelRecords = Record<string, KelInput[]>;

export interface KelBook {
  states: Map<string, KelState>;
  /** 記録済みの分に、今回採用した分を足したもの（sn の順） */
  records: KelRecords;
  /** 今回新しく採用した KEL のイベントの Nostr の id */
  usedEventIds: string[];
}

/**
 * 記録済みの KEL に、events の中の kind 3753 を足して評価する。
 * 記録済みのアカウントへの新しいイベントは、created_at が (acceptAfter, acceptUntil] のものだけを受け付ける。
 * 日付を遡らせたイベントが効くのを、この幅の中に限るため（docs/adr/0008「時計」）。
 * まだ記録のないアカウントは、比べる先の版がないので、acceptUntil までのすべてを受け付ける。
 */
export function buildKelBook(recorded: KelRecords, events: NostrEvent[], acceptAfter: number, acceptUntil: number): KelBook {
  const fresh = new Map<string, { input: KelInput; id: string }[]>();
  for (const ev of seenOrder(events)) {
    if (ev.created_at > acceptUntil) continue;
    const parsed = parseKelEvent(ev);
    if (!parsed || (recorded[parsed.aid] && ev.created_at <= acceptAfter)) continue;
    fresh.set(parsed.aid, [...(fresh.get(parsed.aid) ?? []), { input: parsed.input, id: ev.id }]);
  }
  const states = new Map<string, KelState>();
  const records: KelRecords = {};
  const usedEventIds: string[] = [];
  for (const aid of new Set([...Object.keys(recorded), ...fresh.keys()])) {
    const old = recorded[aid] ?? [];
    const added = fresh.get(aid) ?? [];
    const state = evaluateKel(aid, [...old, ...added.map((a) => a.input)]);
    if (!state) {
      if (old.length > 0) records[aid] = old;
      continue;
    }
    states.set(aid, state);
    const chain = new Set(state.digests);
    const byDigest = new Map<string, KelInput>();
    for (const i of [...old, ...added.map((a) => a.input)]) {
      const d = digestOfEntry(i);
      if (chain.has(d) && !byDigest.has(d)) byDigest.set(d, i);
    }
    records[aid] = state.digests.map((d) => byDigest.get(d)!);
    for (const a of added) if (chain.has(digestOfEntry(a.input))) usedEventIds.push(a.id);
  }
  return { states, records, usedEventIds };
}

const digestOfEntry = (i: KelInput) => digestOf(i.entry.body);

/** 使い捨ての鍵が署名したイベントを、証明書から aid に結び付ける。結び付かなければ null */
export type Attributor = (ev: NostrEvent) => Pubkey | null;

export function attributor(states: Map<string, KelState>, exclude: ReadonlySet<string> = new Set()): Attributor {
  const cache = new WeakMap<NostrEvent, Pubkey | null>();
  return (ev) => {
    if (cache.has(ev)) return cache.get(ev)!;
    // 証明書は署名したイベントの pubkey と時刻を見るので、イベントの署名も確かめる
    const signed = isValidEvent(ev) ? certOf(ev) : null;
    let aid: Pubkey | null = null;
    if (signed && !exclude.has(signed.cert.aid)) {
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
