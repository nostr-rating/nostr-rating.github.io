import type { Pubkey } from '../types.js';
import { npubOf } from './keys.js';

export type Platform = 'github' | 'twitter' | 'mastodon';
export interface IdentityClaim {
  platform: Platform;
  identity: string;
  proof: string;
}
export type VerifyStatus = 'verified' | 'link_only' | 'failed';

const PLATFORMS: readonly Platform[] = ['github', 'twitter', 'mastodon'];

/** 主張の identity と proof の形。リンク先を任意の URL にされないよう、サービスごとに絞る */
const FORMAT: Record<Platform, { identity: RegExp; proof: RegExp }> = {
  github: { identity: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, proof: /^[0-9a-f]{1,64}$/i },
  twitter: { identity: /^[A-Za-z0-9_]{1,15}$/, proof: /^\d{1,25}$/ },
  mastodon: { identity: /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+\/@[A-Za-z0-9_]{1,30}$/i, proof: /^\d{1,25}$/ },
};

function wellFormed(c: IdentityClaim): boolean {
  return FORMAT[c.platform].identity.test(c.identity) && FORMAT[c.platform].proof.test(c.proof);
}

export function verificationText(pubkey: Pubkey): string {
  return `Verifying that I control the following Nostr public key: ${npubOf(pubkey)}`;
}

export function parseProofUrl(url: string): IdentityClaim | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  const host = u.hostname.toLowerCase();
  if (host === 'gist.github.com' && parts.length === 2) {
    return checked({ platform: 'github', identity: parts[0]!, proof: parts[1]! });
  }
  if (['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com', 'mobile.twitter.com'].includes(host)) {
    if (parts.length === 3 && parts[1] === 'status' && /^\d+$/.test(parts[2]!)) {
      return checked({ platform: 'twitter', identity: parts[0]!, proof: parts[2]! });
    }
    return null;
  }
  if (parts.length === 2 && parts[0]!.startsWith('@') && /^\d+$/.test(parts[1]!)) {
    return checked({ platform: 'mastodon', identity: `${host}/${parts[0]}`, proof: parts[1]! });
  }
  return null;
}

const checked = (c: IdentityClaim): IdentityClaim | null => (wellFormed(c) ? c : null);

export function claimToTag(c: IdentityClaim): string[] {
  return ['i', `${c.platform}:${c.identity}`, c.proof];
}

export function tagToClaim(tag: string[]): IdentityClaim | null {
  if (tag[0] !== 'i' || tag.length < 3) return null;
  const sep = tag[1]!.indexOf(':');
  if (sep <= 0) return null;
  const platform = tag[1]!.slice(0, sep) as Platform;
  if (!PLATFORMS.includes(platform)) return null;
  const identity = tag[1]!.slice(sep + 1);
  return checked({ platform, identity, proof: tag[2]! });
}

export function proofUrl(c: IdentityClaim): string {
  switch (c.platform) {
    case 'github':
      return `https://gist.github.com/${c.identity}/${c.proof}`;
    case 'twitter':
      return `https://x.com/${c.identity}/status/${c.proof}`;
    case 'mastodon':
      return `https://${c.identity}/${c.proof}`;
  }
}

function normalize(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchJson(fetchFn: typeof fetch, url: string): Promise<Record<string, any> | null> {
  try {
    const res = await fetchFn(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, any>;
  } catch {
    return null;
  }
}

export async function verifyClaim(c: IdentityClaim, pubkey: Pubkey, fetchFn: typeof fetch): Promise<VerifyStatus> {
  const text = verificationText(pubkey);
  switch (c.platform) {
    case 'twitter':
      return 'link_only';
    case 'github': {
      const gist = await fetchJson(fetchFn, `https://api.github.com/gists/${encodeURIComponent(c.proof)}`);
      if (gist === null) return 'failed';
      const owner = String(gist.owner?.login ?? '');
      if (owner.toLowerCase() !== c.identity.toLowerCase()) return 'failed';
      const files = Object.values((gist.files ?? {}) as Record<string, { content?: string }>);
      return files.some((f) => normalize(f.content ?? '').includes(text)) ? 'verified' : 'failed';
    }
    case 'mastodon': {
      const [instance, handle] = c.identity.split('/@');
      if (!instance || !handle) return 'failed';
      const status = await fetchJson(fetchFn, `https://${instance}/api/v1/statuses/${encodeURIComponent(c.proof)}`);
      if (status === null) return 'failed';
      // 連合先（ほかのインスタンス）の同名アカウントの投稿も返るので、acct と URL のホストで本人のインスタンスか確かめる
      const acct = String(status.account?.acct ?? '');
      let urlHost = '';
      try {
        urlHost = new URL(String(status.account?.url ?? '')).hostname.toLowerCase();
      } catch {
        urlHost = '';
      }
      if (acct.toLowerCase() !== handle.toLowerCase() || urlHost !== instance.toLowerCase()) return 'failed';
      return normalize(String(status.content ?? '')).includes(text) ? 'verified' : 'failed';
    }
  }
}
