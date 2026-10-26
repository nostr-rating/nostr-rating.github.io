import type { EventTemplate, NostrEvent } from 'nostr-tools/pure';
import { claimToTag, tagToClaim, type IdentityClaim } from '../identity/nip39.js';
import type { StageBans } from '../match/stages.js';
import type { FighterId, Pubkey, StageId } from '../types.js';
import { appTags, isAppEvent, isValidEvent, KIND, recruitmentAddr, settingsD, tagValue, tagValues } from './kinds.js';

export interface Settings {
  pubkey: Pubkey;
  eventId: string;
  createdAt: number;
  stageBans: StageBans;
  rangeChoice: number | null;
  rematchHours: number;
}

export interface Recruitment {
  pubkey: Pubkey;
  eventId: string;
  createdAt: number;
  firstFighter: FighterId;
  /** 自己申告。マッチ判定には使わず、各クライアントが計算した値を使う */
  rating: number;
  rangeChoice: number | null;
  rematchHours: number;
  settingsId: string;
  waitingSince: number;
  status: 'open' | 'closed';
  expiresAt: number;
}

export interface Application {
  eventId: string;
  pubkey: Pubkey;
  createdAt: number;
  recruiter: Pubkey;
  recruitmentAddr: string;
  firstFighter: FighterId;
  settingsId: string;
  /** 募集側が canMatch を判定するための申込者の条件 */
  rangeChoice: number | null;
  rematchHours: number;
  waitingSince: number;
}

export interface MatchRecord {
  id: string;
  createdAt: number;
  p1: Pubkey;
  p2: Pubkey;
  p1Fighter: FighterId;
  p2Fighter: FighterId;
  p1SettingsId: string;
  p2SettingsId: string;
  applicationId: string;
}

export type ReportResult = 'win' | 'lose' | 'cancel';

export interface ResultReport {
  id: string;
  matchId: string;
  reporter: Pubkey;
  result: ReportResult;
  createdAt: number;
}

export interface Identities {
  pubkey: Pubkey;
  createdAt: number;
  claims: IdentityClaim[];
}

export interface Profile {
  pubkey: Pubkey;
  createdAt: number;
  name: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

function json(ev: NostrEvent): Record<string, unknown> | null {
  try {
    const v = JSON.parse(ev.content) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v !== '';
const isHex = (v: unknown): v is string => typeof v === 'string' && HEX64.test(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isRange = (v: unknown): v is number | null => v === null || isNum(v);

function isStageBans(v: unknown): v is StageBans {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v).every((s) => Array.isArray(s) && s.every(isStr));
}

// ---- settings (kind 30078) ----

export function buildSettings(
  game: string,
  s: Pick<Settings, 'stageBans' | 'rangeChoice' | 'rematchHours'>,
  now: number,
): EventTemplate {
  return {
    kind: KIND.settings,
    created_at: now,
    tags: [['d', settingsD(game)], ...appTags(game)],
    content: JSON.stringify({ stageBans: s.stageBans, rangeChoice: s.rangeChoice, rematchHours: s.rematchHours }),
  };
}

export function parseSettings(game: string, ev: NostrEvent): Settings | null {
  if (!isAppEvent(ev, KIND.settings, game) || tagValue(ev, 'd') !== settingsD(game)) return null;
  const c = json(ev);
  if (!c || !isStageBans(c.stageBans) || !isRange(c.rangeChoice) || !isNum(c.rematchHours)) return null;
  return {
    pubkey: ev.pubkey,
    eventId: ev.id,
    createdAt: ev.created_at,
    stageBans: c.stageBans as Record<string, StageId[]>,
    rangeChoice: c.rangeChoice,
    rematchHours: c.rematchHours,
  };
}

// ---- recruitment (kind 31751) ----

export function buildRecruitment(
  game: string,
  r: Pick<Recruitment, 'firstFighter' | 'rating' | 'rangeChoice' | 'rematchHours' | 'settingsId' | 'waitingSince' | 'status'>,
  now: number,
  ttlSec: number,
): EventTemplate {
  return {
    kind: KIND.recruitment,
    created_at: now,
    tags: [['d', game], ...appTags(game), ['expiration', String(now + ttlSec)]],
    content: JSON.stringify({
      firstFighter: r.firstFighter,
      rating: r.rating,
      rangeChoice: r.rangeChoice,
      rematchHours: r.rematchHours,
      settingsId: r.settingsId,
      waitingSince: r.waitingSince,
      status: r.status,
    }),
  };
}

export function parseRecruitment(game: string, ev: NostrEvent): Recruitment | null {
  if (!isAppEvent(ev, KIND.recruitment, game) || tagValue(ev, 'd') !== game) return null;
  const c = json(ev);
  const expiresAt = Number(tagValue(ev, 'expiration'));
  if (!c || !Number.isFinite(expiresAt)) return null;
  if (!isStr(c.firstFighter) || !isNum(c.rating) || !isRange(c.rangeChoice) || !isNum(c.rematchHours)) return null;
  if (!isHex(c.settingsId) || !isNum(c.waitingSince) || (c.status !== 'open' && c.status !== 'closed')) return null;
  return {
    pubkey: ev.pubkey,
    eventId: ev.id,
    createdAt: ev.created_at,
    firstFighter: c.firstFighter,
    rating: c.rating,
    rangeChoice: c.rangeChoice,
    rematchHours: c.rematchHours,
    settingsId: c.settingsId,
    waitingSince: c.waitingSince,
    status: c.status,
    expiresAt,
  };
}

// ---- application (kind 3751) ----

export function buildApplication(
  game: string,
  a: Pick<Application, 'recruiter' | 'firstFighter' | 'settingsId' | 'rangeChoice' | 'rematchHours' | 'waitingSince'>,
  now: number,
): EventTemplate {
  return {
    kind: KIND.application,
    created_at: now,
    tags: [['a', recruitmentAddr(a.recruiter, game)], ['p', a.recruiter], ...appTags(game)],
    content: JSON.stringify({
      firstFighter: a.firstFighter,
      settingsId: a.settingsId,
      rangeChoice: a.rangeChoice,
      rematchHours: a.rematchHours,
      waitingSince: a.waitingSince,
    }),
  };
}

export function parseApplication(game: string, ev: NostrEvent): Application | null {
  if (!isAppEvent(ev, KIND.application, game)) return null;
  const recruiter = tagValue(ev, 'p');
  const addr = tagValue(ev, 'a');
  const c = json(ev);
  if (!isHex(recruiter) || addr !== recruitmentAddr(recruiter, game) || recruiter === ev.pubkey) return null;
  if (!c || !isStr(c.firstFighter) || !isHex(c.settingsId)) return null;
  if (!isRange(c.rangeChoice) || !isNum(c.rematchHours) || !isNum(c.waitingSince)) return null;
  return {
    eventId: ev.id,
    pubkey: ev.pubkey,
    createdAt: ev.created_at,
    recruiter,
    recruitmentAddr: addr,
    firstFighter: c.firstFighter,
    settingsId: c.settingsId,
    rangeChoice: c.rangeChoice,
    rematchHours: c.rematchHours,
    waitingSince: c.waitingSince,
  };
}

// ---- match (kind 3752) ----

export function buildMatch(game: string, m: Omit<MatchRecord, 'id' | 'createdAt'>, now: number): EventTemplate {
  return {
    kind: KIND.match,
    created_at: now,
    tags: [['e', m.applicationId], ['p', m.p1], ['p', m.p2], ...appTags(game)],
    content: JSON.stringify({
      p1: m.p1,
      p2: m.p2,
      p1Fighter: m.p1Fighter,
      p2Fighter: m.p2Fighter,
      p1SettingsId: m.p1SettingsId,
      p2SettingsId: m.p2SettingsId,
    }),
  };
}

export function parseMatch(game: string, ev: NostrEvent): MatchRecord | null {
  if (!isAppEvent(ev, KIND.match, game)) return null;
  const c = json(ev);
  const applicationId = tagValue(ev, 'e');
  if (!c || !isHex(applicationId) || c.p1 !== ev.pubkey || !isHex(c.p2) || c.p2 === c.p1) return null;
  // 相手が購読で気づけるよう、p タグに双方を必ず含める
  const pTags = tagValues(ev, 'p');
  if (!pTags.includes(c.p1) || !pTags.includes(c.p2)) return null;
  if (!isStr(c.p1Fighter) || !isStr(c.p2Fighter) || !isHex(c.p1SettingsId) || !isHex(c.p2SettingsId)) return null;
  return {
    id: ev.id,
    createdAt: ev.created_at,
    p1: ev.pubkey,
    p2: c.p2,
    p1Fighter: c.p1Fighter,
    p2Fighter: c.p2Fighter,
    p1SettingsId: c.p1SettingsId,
    p2SettingsId: c.p2SettingsId,
    applicationId,
  };
}

// ---- report (kind 3754) ----

export function buildReport(
  game: string,
  r: { matchId: string; opponent: Pubkey; result: ReportResult },
  now: number,
): EventTemplate {
  return {
    kind: KIND.report,
    created_at: now,
    tags: [['e', r.matchId], ['p', r.opponent], ...appTags(game)],
    content: JSON.stringify({ result: r.result }),
  };
}

export function parseReport(game: string, ev: NostrEvent): ResultReport | null {
  if (!isAppEvent(ev, KIND.report, game)) return null;
  const c = json(ev);
  const matchId = tagValue(ev, 'e');
  if (!c || !isHex(matchId)) return null;
  if (c.result !== 'win' && c.result !== 'lose' && c.result !== 'cancel') return null;
  return { id: ev.id, matchId, reporter: ev.pubkey, result: c.result, createdAt: ev.created_at };
}

// ---- identities (kind 10011, NIP-39) ----

export function buildIdentities(claims: IdentityClaim[], now: number): EventTemplate {
  return { kind: KIND.identities, created_at: now, tags: claims.map(claimToTag), content: '' };
}

export function parseIdentities(ev: NostrEvent): Identities | null {
  if (!isValidEvent(ev) || ev.kind !== KIND.identities) return null;
  const claims = ev.tags.map(tagToClaim).filter((c): c is IdentityClaim => c !== null);
  return { pubkey: ev.pubkey, createdAt: ev.created_at, claims };
}

// ---- profile (kind 0) ----

export function buildProfile(p: { name: string }, now: number): EventTemplate {
  return { kind: KIND.profile, created_at: now, tags: [], content: JSON.stringify({ name: p.name }) };
}

export function parseProfile(ev: NostrEvent): Profile | null {
  if (!isValidEvent(ev) || ev.kind !== KIND.profile) return null;
  const c = json(ev);
  if (!c) return null;
  const name = typeof c.name === 'string' ? c.name : typeof c.display_name === 'string' ? c.display_name : '';
  return { pubkey: ev.pubkey, createdAt: ev.created_at, name };
}
