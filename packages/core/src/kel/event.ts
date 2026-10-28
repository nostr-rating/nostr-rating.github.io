import type { EventTemplate, NostrEvent } from 'nostr-tools/pure';
import { APP_TAG, isValidEvent, KIND } from '../events/kinds.js';
import { digestOf, type KelEntry, type KelInput } from './kel.js';

/** KEL のイベントを載せる Nostr のイベント。載せる鍵は icp・ixn なら端末の掲載用の鍵、rot なら次の鍵 */
export function kelEventTemplate(entry: KelEntry, createdAt: number): EventTemplate {
  const b = entry.body;
  const aid = b.t === 'icp' ? digestOf(b) : b.aid;
  return {
    kind: KIND.kel,
    created_at: createdAt,
    tags: [
      ['t', APP_TAG],
      ['aid', aid],
      ['sn', String(b.sn)],
    ],
    content: JSON.stringify(entry),
  };
}

export function parseKelEvent(ev: NostrEvent): { aid: string; input: KelInput } | null {
  if (ev.kind !== KIND.kel || !isValidEvent(ev)) return null;
  try {
    const entry = JSON.parse(ev.content) as KelEntry;
    if (!entry?.body || !Array.isArray(entry.sigs)) return null;
    const aid = entry.body.t === 'icp' ? digestOf(entry.body) : entry.body.aid;
    if (ev.tags.find((t) => t[0] === 'aid')?.[1] !== aid) return null;
    return { aid, input: { entry, at: ev.created_at } };
  } catch {
    return null;
  }
}

/** 「先に見た」順の既定: created_at, id の昇順 */
export function seenOrder(events: NostrEvent[]): NostrEvent[] {
  return [...events].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
