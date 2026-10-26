import { describe, expect, test } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { clearLocalKey, isBackedUp, loadLocalSigner, markBackedUp, saveLocalSigner } from '../src/services/signer-local.js';

describe('local signer storage', () => {
  test('returns null before a key is saved', async () => {
    await clearLocalKey();
    expect(await loadLocalSigner()).toBeNull();
  });

  test('saves, loads and tracks backup', async () => {
    await clearLocalKey();
    const sk = generateSecretKey();
    await saveLocalSigner(sk);
    const s = await loadLocalSigner();
    expect(await s?.getPublicKey()).toBe(getPublicKey(sk));
    expect(await isBackedUp()).toBe(false);
    await markBackedUp();
    expect(await isBackedUp()).toBe(true);
  });

  test('saving a new key resets the backup flag', async () => {
    await markBackedUp();
    await saveLocalSigner(generateSecretKey());
    expect(await isBackedUp()).toBe(false);
  });
});
