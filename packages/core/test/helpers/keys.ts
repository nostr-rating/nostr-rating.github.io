import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { LocalSigner } from '../../src/identity/signer.js';

export function newUser() {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk), signer: new LocalSigner(sk) };
}
