import { LocalSigner } from '@nostr-rating/core';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { idbDelete, idbGet, idbSet } from './idb.js';

const SK = 'secretKey';
const BACKED_UP = 'backedUp';

export async function loadLocalSigner(): Promise<LocalSigner | null> {
  const hex = await idbGet<string>(SK);
  return hex ? new LocalSigner(hexToBytes(hex)) : null;
}

export async function loadLocalSecretKey(): Promise<Uint8Array | null> {
  const hex = await idbGet<string>(SK);
  return hex ? hexToBytes(hex) : null;
}

export async function saveLocalSigner(sk: Uint8Array): Promise<LocalSigner> {
  await idbSet(SK, bytesToHex(sk));
  await idbSet(BACKED_UP, false);
  return new LocalSigner(sk);
}

export async function clearLocalKey(): Promise<void> {
  await idbDelete(SK);
  await idbDelete(BACKED_UP);
}

export async function markBackedUp(): Promise<void> {
  await idbSet(BACKED_UP, true);
}

export async function isBackedUp(): Promise<boolean> {
  return (await idbGet<boolean>(BACKED_UP)) === true;
}
