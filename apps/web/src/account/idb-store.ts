import { idbDelete, idbGet, idbSet } from '../services/idb.js';
import type { KeyStore } from './account.js';

/** IndexedDB に置く。WebCrypto の鍵（CryptoKey）は、取り出せないまま保存できる */
export const idbKeyStore: KeyStore = {
  get: idbGet,
  set: idbSet,
  delete: idbDelete,
};
