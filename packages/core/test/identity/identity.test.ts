import { getPublicKey } from 'nostr-tools/pure';
import { describe, expect, test } from 'vitest';
import { decodeNsec, encodeNsec, generateSecretKey, npubOf } from '../../src/identity/keys.js';
import { parseClaim, parseProofUrl, proofUrl, verificationText, verifyClaim } from '../../src/identity/claims.js';
import { LocalSigner } from '../../src/identity/signer.js';

const SK = generateSecretKey();
const PK = getPublicKey(SK);
const AID = 'a'.repeat(64);
const TEXT = verificationText(AID);

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
  test('names the account id', () => {
    expect(TEXT).toBe(`Verifying my Nostr-Rating account: ${AID}`);
  });
});

describe('parseProofUrl', () => {
  test.each([
    ['https://gist.github.com/alice/abc123', { platform: 'github', identity: 'alice', proof: 'abc123' }],
    ['https://x.com/alice/status/123', { platform: 'twitter', identity: 'alice', proof: '123' }],
    ['https://twitter.com/alice/status/123?s=20', { platform: 'twitter', identity: 'alice', proof: '123' }],
    ['https://mstdn.jp/@alice/111', null],
    ['https://example.com/foo', null],
    ['not a url', null],
  ])('%s', (url, expected) => {
    expect(parseProofUrl(url)).toEqual(expected);
  });
});

describe('parseClaim', () => {
  test('accepts well-formed claims only', () => {
    expect(parseClaim({ platform: 'github', identity: 'alice', proof: 'abc' })).toEqual({ platform: 'github', identity: 'alice', proof: 'abc' });
    expect(parseClaim({ platform: 'github', identity: 'alice/../x', proof: '1' })).toBeNull();
    expect(parseClaim({ platform: 'twitter', identity: 'alice', proof: '12a' })).toBeNull();
    expect(parseClaim({ platform: 'mastodon', identity: 'mstdn.jp/@alice', proof: '1' })).toBeNull();
    expect(parseClaim(null)).toBeNull();
  });

  test('proofUrl', () => {
    expect(proofUrl({ platform: 'twitter', identity: 'alice', proof: '123' })).toBe('https://x.com/alice/status/123');
    expect(proofUrl({ platform: 'github', identity: 'alice', proof: 'abc' })).toBe('https://gist.github.com/alice/abc');
  });
});

describe('verifyClaim', () => {
  const gh = { platform: 'github', identity: 'Alice', proof: 'abc' } as const;
  const gistUrl = 'https://api.github.com/gists/abc';
  const x = { platform: 'twitter', identity: 'Alice', proof: '123' } as const;
  const oembed = `https://publish.x.com/oembed?omit_script=true&url=${encodeURIComponent('https://x.com/Alice/status/123')}`;

  test('github ok', async () => {
    const f = stubFetch({ [gistUrl]: { owner: { login: 'alice' }, files: { 'nostr.txt': { content: `${TEXT}\n` } } } });
    expect(await verifyClaim(gh, AID, f)).toBe('verified');
  });

  test('github owner mismatch', async () => {
    const f = stubFetch({ [gistUrl]: { owner: { login: 'mallory' }, files: { a: { content: TEXT } } } });
    expect(await verifyClaim(gh, AID, f)).toBe('failed');
  });

  test('github text for another account', async () => {
    const f = stubFetch({ [gistUrl]: { owner: { login: 'alice' }, files: { a: { content: verificationText('b'.repeat(64)) } } } });
    expect(await verifyClaim(gh, AID, f)).toBe('failed');
  });

  test('x ok through oEmbed, ignoring html', async () => {
    const f = stubFetch({
      [oembed]: {
        author_url: 'https://twitter.com/alice',
        html: `<blockquote class="twitter-tweet"><p lang="en" dir="ltr">${TEXT}</p>&mdash; alice (@alice)</blockquote>`,
      },
    });
    expect(await verifyClaim(x, AID, f)).toBe('verified');
  });

  test('x post by someone else is failed', async () => {
    const f = stubFetch({ [oembed]: { author_url: 'https://twitter.com/mallory', html: `<p>${TEXT}</p>` } });
    expect(await verifyClaim(x, AID, f)).toBe('failed');
  });

  test('network error is failed', async () => {
    const f = (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    expect(await verifyClaim(gh, AID, f)).toBe('failed');
    expect(await verifyClaim(x, AID, f)).toBe('failed');
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
