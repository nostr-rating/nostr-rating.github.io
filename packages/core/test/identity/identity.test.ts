import { getPublicKey } from 'nostr-tools/pure';
import { describe, expect, test } from 'vitest';
import { decodeNsec, encodeNsec, generateSecretKey, npubOf } from '../../src/identity/keys.js';
import {
  claimToTag,
  parseProofUrl,
  proofUrl,
  tagToClaim,
  verificationText,
  verifyClaim,
} from '../../src/identity/nip39.js';
import { LocalSigner } from '../../src/identity/signer.js';

const SK = generateSecretKey();
const PK = getPublicKey(SK);
const TEXT = verificationText(PK);

function stubFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (!(url in routes)) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(routes[url]), { status: 200 });
  }) as typeof fetch;
}

describe('keys', () => {
  test('nsec roundtrip', () => {
    expect(decodeNsec(encodeNsec(SK))).toEqual(SK);
  });

  test('nsec with surrounding whitespace is accepted', () => {
    expect(decodeNsec(`  ${encodeNsec(SK)}\n`)).toEqual(SK);
  });

  test('invalid nsec throws', () => {
    expect(() => decodeNsec('nsec1xxx')).toThrow();
    expect(() => decodeNsec(npubOf(PK))).toThrow();
  });
});

describe('verificationText', () => {
  test('is the NIP-39 sentence', () => {
    expect(TEXT).toBe(`Verifying that I control the following Nostr public key: ${npubOf(PK)}`);
  });
});

describe('parseProofUrl', () => {
  test.each([
    ['https://gist.github.com/alice/abc123', { platform: 'github', identity: 'alice', proof: 'abc123' }],
    ['https://x.com/alice/status/123', { platform: 'twitter', identity: 'alice', proof: '123' }],
    ['https://twitter.com/alice/status/123?s=20', { platform: 'twitter', identity: 'alice', proof: '123' }],
    ['https://mstdn.jp/@alice/111', { platform: 'mastodon', identity: 'mstdn.jp/@alice', proof: '111' }],
    ['https://example.com/foo', null],
    ['not a url', null],
  ])('%s', (url, expected) => {
    expect(parseProofUrl(url)).toEqual(expected);
  });
});

describe('tags', () => {
  test('claim ↔ tag roundtrip', () => {
    const c = { platform: 'mastodon', identity: 'mstdn.jp/@alice', proof: '111' } as const;
    expect(claimToTag(c)).toEqual(['i', 'mastodon:mstdn.jp/@alice', '111']);
    expect(tagToClaim(claimToTag(c))).toEqual(c);
  });

  test('identities that do not match the platform format are ignored', () => {
    expect(tagToClaim(['i', 'mastodon:evil.example/phish?x=@a', '1'])).toBeNull();
    expect(tagToClaim(['i', 'mastodon:mstdn.jp/@alice/../x', '1'])).toBeNull();
    expect(tagToClaim(['i', 'github:alice/../x', '1'])).toBeNull();
    expect(tagToClaim(['i', 'twitter:alice', '12a'])).toBeNull();
    expect(tagToClaim(['i', 'github:alice', 'abc/def'])).toBeNull();
  });

  test('unknown platform tag is ignored', () => {
    expect(tagToClaim(['i', 'telegram:123', 'x/1'])).toBeNull();
    expect(tagToClaim(['p', 'github:alice', '1'])).toBeNull();
  });

  test('proofUrl', () => {
    expect(proofUrl({ platform: 'twitter', identity: 'alice', proof: '123' })).toBe('https://x.com/alice/status/123');
    expect(proofUrl({ platform: 'github', identity: 'alice', proof: 'abc' })).toBe('https://gist.github.com/alice/abc');
    expect(proofUrl({ platform: 'mastodon', identity: 'mstdn.jp/@alice', proof: '111' })).toBe('https://mstdn.jp/@alice/111');
  });
});

describe('verifyClaim', () => {
  const gh = { platform: 'github', identity: 'Alice', proof: 'abc' } as const;
  const gistUrl = 'https://api.github.com/gists/abc';

  test('github ok', async () => {
    const f = stubFetch({ [gistUrl]: { owner: { login: 'alice' }, files: { 'nostr.txt': { content: `${TEXT}\n` } } } });
    expect(await verifyClaim(gh, PK, f)).toBe('verified');
  });

  test('github owner mismatch', async () => {
    const f = stubFetch({ [gistUrl]: { owner: { login: 'mallory' }, files: { a: { content: TEXT } } } });
    expect(await verifyClaim(gh, PK, f)).toBe('failed');
  });

  test('github text missing', async () => {
    const f = stubFetch({ [gistUrl]: { owner: { login: 'alice' }, files: { a: { content: 'hello' } } } });
    expect(await verifyClaim(gh, PK, f)).toBe('failed');
  });

  test('mastodon strips html', async () => {
    const npub = npubOf(PK);
    const f = stubFetch({
      'https://mstdn.jp/api/v1/statuses/111': {
        account: { username: 'alice', acct: 'alice', url: 'https://mstdn.jp/@alice' },
        content: `<p>Verifying that I control the following Nostr public key: <a href="x">${npub}</a></p>`,
      },
    });
    expect(await verifyClaim({ platform: 'mastodon', identity: 'mstdn.jp/@alice', proof: '111' }, PK, f)).toBe('verified');
  });

  test('mastodon post from a remote account with the same username is failed', async () => {
    const f = stubFetch({
      'https://mstdn.jp/api/v1/statuses/111': {
        account: { username: 'alice', acct: 'alice@evil.example', url: 'https://evil.example/@alice' },
        content: `<p>${TEXT}</p>`,
      },
    });
    expect(await verifyClaim({ platform: 'mastodon', identity: 'mstdn.jp/@alice', proof: '111' }, PK, f)).toBe('failed');
  });

  test('network error is failed', async () => {
    const f = (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    expect(await verifyClaim(gh, PK, f)).toBe('failed');
  });

  test('twitter is link_only without fetching', async () => {
    let called = false;
    const f = (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch;
    expect(await verifyClaim({ platform: 'twitter', identity: 'alice', proof: '1' }, PK, f)).toBe('link_only');
    expect(called).toBe(false);
  });
});

describe('LocalSigner', () => {
  test('signs with its key', async () => {
    const s = new LocalSigner(SK);
    expect(await s.getPublicKey()).toBe(PK);
    const ev = await s.signEvent({ kind: 1, content: 'x', tags: [], created_at: 1 });
    expect(ev.pubkey).toBe(PK);
  });

  test('nip44 roundtrip between two keys', async () => {
    const a = new LocalSigner(SK);
    const bSk = generateSecretKey();
    const b = new LocalSigner(bSk);
    const cipher = await a.nip44Encrypt(getPublicKey(bSk), 'こんにちは');
    expect(await b.nip44Decrypt(PK, cipher)).toBe('こんにちは');
  });
});
