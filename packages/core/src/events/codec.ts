import type { EventTemplate, NostrEvent } from 'nostr-tools/pure';
import { parseClaim, type IdentityClaim } from '../identity/claims.js';
import type { StageBans } from '../match/stages.js';
import type { FighterId, Pubkey, StageId } from '../types.js';
import { appTags, isAppEvent, KIND, recruitmentAddr, settingsD, tagValue, tagValues } from './kinds.js';

/**
 * docs/adr/0008。アプリのイベントは使い捨ての鍵が署名し、証明書でアカウント（aid）に結び付く。
 * parse は、呼び出し側が証明書を確かめて求めた author（aid）を受け取る。null なら読まない。
 * 各レコードの pubkey・p1・p2・recruiter・reporter は aid で、session は署名した使い捨ての鍵。
 */

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
  session: Pubkey;
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
  session: Pubkey;
  createdAt: number;
  recruiter: Pubkey;
  /** 募集を署名した使い捨ての鍵 */
  recruiterSession: Pubkey;
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
  /** p タグの使い捨ての鍵（購読と DM の宛先） */
  sessions: Pubkey[];
}

export type ReportResult = 'win' | 'lose' | 'cancel';

export interface ResultReport {
  id: string;
  matchId: string;
  reporter: Pubkey;
  result: ReportResult;
  createdAt: number;
}

/** アカウントの公開情報（kind 30756、d は aid）。表示名と、外部アカウントの紐づけ */
export interface AccountInfo {
  pubkey: Pubkey;
  eventId: string;
  createdAt: number;
  name: string;
  claims: IdentityClaim[];
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

export function parseSettings(game: string, ev: NostrEvent, author: Pubkey | null): Settings | null {
  if (!author || !isAppEvent(ev, KIND.settings, game) || tagValue(ev, 'd') !== settingsD(game)) return null;
  const c = json(ev);
  if (!c || !isStageBans(c.stageBans) || !isRange(c.rangeChoice) || !isNum(c.rematchHours)) return null;
  return {
    pubkey: author,
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

export function parseRecruitment(game: string, ev: NostrEvent, author: Pubkey | null): Recruitment | null {
  if (!author || !isAppEvent(ev, KIND.recruitment, game) || tagValue(ev, 'd') !== game) return null;
  const c = json(ev);
  const expiresAt = Number(tagValue(ev, 'expiration'));
  if (!c || !Number.isFinite(expiresAt)) return null;
  if (!isStr(c.firstFighter) || !isNum(c.rating) || !isRange(c.rangeChoice) || !isNum(c.rematchHours)) return null;
  if (!isHex(c.settingsId) || !isNum(c.waitingSince) || (c.status !== 'open' && c.status !== 'closed')) return null;
  return {
    pubkey: author,
    session: ev.pubkey,
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
  a: Pick<Application, 'recruiter' | 'recruiterSession' | 'firstFighter' | 'settingsId' | 'rangeChoice' | 'rematchHours' | 'waitingSince'>,
  now: number,
): EventTemplate {
  return {
    kind: KIND.application,
    created_at: now,
    tags: [['a', recruitmentAddr(a.recruiterSession, game)], ['p', a.recruiterSession], ...appTags(game)],
    content: JSON.stringify({
      recruiter: a.recruiter,
      firstFighter: a.firstFighter,
      settingsId: a.settingsId,
      rangeChoice: a.rangeChoice,
      rematchHours: a.rematchHours,
      waitingSince: a.waitingSince,
    }),
  };
}

export function parseApplication(game: string, ev: NostrEvent, author: Pubkey | null): Application | null {
  if (!author || !isAppEvent(ev, KIND.application, game)) return null;
  const recruiterSession = tagValue(ev, 'p');
  const addr = tagValue(ev, 'a');
  const c = json(ev);
  if (!isHex(recruiterSession) || addr !== recruitmentAddr(recruiterSession, game)) return null;
  if (!c || !isHex(c.recruiter) || c.recruiter === author || !isStr(c.firstFighter) || !isHex(c.settingsId)) return null;
  if (!isRange(c.rangeChoice) || !isNum(c.rematchHours) || !isNum(c.waitingSince)) return null;
  return {
    eventId: ev.id,
    pubkey: author,
    session: ev.pubkey,
    createdAt: ev.created_at,
    recruiter: c.recruiter,
    recruiterSession,
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
    tags: [['e', m.applicationId], ...m.sessions.map((s) => ['p', s]), ...appTags(game)],
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

export function parseMatch(game: string, ev: NostrEvent, author: Pubkey | null): MatchRecord | null {
  if (!author || !isAppEvent(ev, KIND.match, game)) return null;
  const c = json(ev);
  const applicationId = tagValue(ev, 'e');
  if (!c || !isHex(applicationId) || c.p1 !== author || !isHex(c.p2) || c.p2 === c.p1) return null;
  // 相手が購読で気づけるよう、p タグに双方の使い捨ての鍵を入れる
  const sessions = tagValues(ev, 'p').filter(isHex);
  if (!sessions.includes(ev.pubkey) || sessions.length < 2) return null;
  if (!isStr(c.p1Fighter) || !isStr(c.p2Fighter) || !isHex(c.p1SettingsId) || !isHex(c.p2SettingsId)) return null;
  return {
    id: ev.id,
    createdAt: ev.created_at,
    p1: author,
    p2: c.p2,
    p1Fighter: c.p1Fighter,
    p2Fighter: c.p2Fighter,
    p1SettingsId: c.p1SettingsId,
    p2SettingsId: c.p2SettingsId,
    applicationId,
    sessions,
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

export function parseReport(game: string, ev: NostrEvent, author: Pubkey | null): ResultReport | null {
  if (!author || !isAppEvent(ev, KIND.report, game)) return null;
  const c = json(ev);
  const matchId = tagValue(ev, 'e');
  if (!c || !isHex(matchId)) return null;
  if (c.result !== 'win' && c.result !== 'lose' && c.result !== 'cancel') return null;
  return { id: ev.id, matchId, reporter: author, result: c.result, createdAt: ev.created_at };
}

// ---- account info (kind 30756) ----

export function buildAccountInfo(game: string, a: Pick<AccountInfo, 'pubkey' | 'name' | 'claims'>, now: number): EventTemplate {
  return {
    kind: KIND.account,
    created_at: now,
    tags: [['d', a.pubkey], ...appTags(game)],
    content: JSON.stringify({ name: a.name, claims: a.claims }),
  };
}

export function parseAccountInfo(game: string, ev: NostrEvent, author: Pubkey | null): AccountInfo | null {
  if (!author || !isAppEvent(ev, KIND.account, game) || tagValue(ev, 'd') !== author) return null;
  const c = json(ev);
  if (!c || typeof c.name !== 'string' || c.name.length > 64 || !Array.isArray(c.claims)) return null;
  const claims = c.claims.map(parseClaim).filter((x): x is IdentityClaim => x !== null);
  return { pubkey: author, eventId: ev.id, createdAt: ev.created_at, name: c.name, claims };
}
