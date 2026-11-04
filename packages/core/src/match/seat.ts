import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * 先後を決める乱数（docs/adr/0013）。募集した側は乱数のハッシュを募集に載せ、マッチ成立で乱数を明かす。
 * 申し込んだ側は申し込みに自分の乱数を載せる。どちらも相手の乱数を知る前に自分の乱数を決めるので、片方だけでは先後を選べない
 */

const HEX64 = /^[0-9a-f]{64}$/;

const sha256Hex = (s: string) => bytesToHex(sha256(utf8ToBytes(s)));

/** 32バイトの乱数（16進数64文字） */
export function newSeed(): string {
  return bytesToHex(randomBytes(32));
}

export function isSeed(v: unknown): v is string {
  return typeof v === 'string' && HEX64.test(v);
}

/** 募集と申し込みに載せる、募集した側の乱数のハッシュ */
export function seedCommit(seed: string): string {
  return sha256Hex(seed);
}

/**
 * 対戦の先後。0 なら1つ目の側。SHA256(p1 の乱数 ‖ p2 の乱数) の最後の16進数が偶数なら p1 が1つ目の側。
 * 乱数は有効な対戦の条件（seedCommit(p1Seed) が申し込みの seedHash と一致）を満たしたものを渡すこと
 */
export function sideOf(p1Seed: string, p2Seed: string, role: 'p1' | 'p2'): 0 | 1 {
  const p1First = parseInt(sha256Hex(p1Seed + p2Seed).slice(-1), 16) % 2 === 0;
  return (role === 'p1') === p1First ? 0 : 1;
}
