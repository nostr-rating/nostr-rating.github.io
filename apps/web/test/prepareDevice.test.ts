import { decodeDeviceRequest } from '@nostr-rating/core';
import { getPublicKey, generateSecretKey } from 'nostr-tools/pure';
import { describe, expect, test, vi } from 'vitest';
import { Account, memoryKeyStore } from '../src/account/account.js';
import type { ExternalDevice } from '../src/account/external.js';

// 署名アプリごとに別の鍵を返す（NIP-46 の接続先には実際にはつながない）
const keys = vi.hoisted(() => new Map<string, string>());
vi.mock('../src/account/external.js', async (original) => ({
  ...(await original<object>()),
  externalSigner: async (ext: ExternalDevice) => ({ getPublicKey: async () => keys.get(ext.kind)! }),
}));

describe('Account.prepareDevice', () => {
  test('makes a new request when the signer app changes from NIP-07 to NIP-46', async () => {
    keys.set('nip07', getPublicKey(generateSecretKey()));
    keys.set('nip46', getPublicKey(generateSecretKey()));
    const store = memoryKeyStore();
    const nip46: ExternalDevice = { kind: 'nip46', clientSk: '1'.repeat(64), bunker: { pubkey: '2'.repeat(64), relays: ['wss://relay.example'], secret: null } };
    const first = decodeDeviceRequest(await Account.prepareDevice(store, 'x', { kind: 'nip07' }))!;
    const second = decodeDeviceRequest(await Account.prepareDevice(store, 'x', nip46))!;
    expect([first.key, second.key]).toEqual([
      { type: 'schnorr', pub: keys.get('nip07') },
      { type: 'schnorr', pub: keys.get('nip46') },
    ]);
  });

  test('keeps the request while the same signer app is used', async () => {
    keys.set('nip07', getPublicKey(generateSecretKey()));
    const store = memoryKeyStore();
    const first = await Account.prepareDevice(store, 'x', { kind: 'nip07' });
    expect(await Account.prepareDevice(store, 'x', { kind: 'nip07' })).toBe(first);
  });
});
