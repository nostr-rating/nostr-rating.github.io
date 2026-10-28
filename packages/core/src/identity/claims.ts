/** 外部アカウント（X・GitHub）の紐づけ。docs/adr/0008「外部アカウントの紐づけ」 */
export type Platform = 'github' | 'twitter';
export interface IdentityClaim {
  platform: Platform;
  identity: string;
  proof: string;
}
export type VerifyStatus = 'verified' | 'failed';

const PLATFORMS: readonly Platform[] = ['github', 'twitter'];

/** 主張の identity と proof の形。リンク先を任意の URL にされないよう、サービスごとに絞る */
const FORMAT: Record<Platform, { identity: RegExp; proof: RegExp }> = {
  github: { identity: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, proof: /^[0-9a-f]{1,64}$/i },
  twitter: { identity: /^[A-Za-z0-9_]{1,15}$/, proof: /^\d{1,25}$/ },
};

const checked = (c: IdentityClaim): IdentityClaim | null => (FORMAT[c.platform].identity.test(c.identity) && FORMAT[c.platform].proof.test(c.proof) ? c : null);

/** X の投稿や Gist に書いてもらう文 */
export function verificationText(aid: string): string {
  return `Verifying my Nostr-Rating account: ${aid}`;
}

export function parseClaim(v: unknown): IdentityClaim | null {
  if (typeof v !== 'object' || v === null) return null;
  const c = v as Record<string, unknown>;
  if (!PLATFORMS.includes(c.platform as Platform) || typeof c.identity !== 'string' || typeof c.proof !== 'string') return null;
  return checked({ platform: c.platform as Platform, identity: c.identity, proof: c.proof });
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
  }
  return null;
}

export function proofUrl(c: IdentityClaim): string {
  return c.platform === 'github' ? `https://gist.github.com/${c.identity}/${c.proof}` : `https://x.com/${c.identity}/status/${c.proof}`;
}

function normalize(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
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

/**
 * 投稿の本人と本文を確かめる。X は oEmbed（認証なし）で、そのときの投稿者の名前を返すので、
 * 名前を変えたあとは新しい名前で確かめ直す必要がある。
 */
export async function verifyClaim(c: IdentityClaim, aid: string, fetchFn: typeof fetch): Promise<VerifyStatus> {
  const text = verificationText(aid);
  if (c.platform === 'twitter') {
    const o = await fetchJson(fetchFn, `https://publish.x.com/oembed?omit_script=true&url=${encodeURIComponent(proofUrl(c))}`);
    if (o === null) return 'failed';
    let author = '';
    try {
      author = new URL(String(o.author_url ?? '')).pathname.split('/').filter(Boolean)[0] ?? '';
    } catch {
      return 'failed';
    }
    if (author.toLowerCase() !== c.identity.toLowerCase()) return 'failed';
    return normalize(String(o.html ?? '')).includes(text) ? 'verified' : 'failed';
  }
  const gist = await fetchJson(fetchFn, `https://api.github.com/gists/${encodeURIComponent(c.proof)}`);
  if (gist === null) return 'failed';
  if (String(gist.owner?.login ?? '').toLowerCase() !== c.identity.toLowerCase()) return 'failed';
  const files = Object.values((gist.files ?? {}) as Record<string, { content?: string }>);
  return files.some((f) => normalize(f.content ?? '').includes(text)) ? 'verified' : 'failed';
}

/** 同じ外部アカウントかを比べるためのキー（ユーザー名の大文字小文字は区別しない） */
export function claimKey(c: Pick<IdentityClaim, 'platform' | 'identity'>): string {
  return `${c.platform}:${c.identity.toLowerCase()}`;
}

/**
 * aid と同じ外部アカウントを紐づけた、ほかのアカウント。復活の言葉を失くして作り直した人の、
 * 前のアカウントを見つけるのに使う。紐づけが本物かは、呼び出し側が双方を verifyClaim で確かめる
 */
export function accountsSharingClaims(
  accounts: Record<string, { claims: IdentityClaim[] }>,
  aid: string,
): { aid: string; claims: IdentityClaim[] }[] {
  const mine = new Set((accounts[aid]?.claims ?? []).map(claimKey));
  if (mine.size === 0) return [];
  return Object.entries(accounts)
    .filter(([other]) => other !== aid)
    .map(([other, a]) => ({ aid: other, claims: a.claims.filter((c) => mine.has(claimKey(c))) }))
    .filter((x) => x.claims.length > 0)
    .sort((a, b) => (a.aid < b.aid ? -1 : 1));
}
