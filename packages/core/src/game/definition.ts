import type { FighterId, StageId } from '../types.js';

export interface Season {
  id: number;
  startsAt: number;
  endsAt: number;
}

export interface Character {
  id: FighterId;
  name: string;
}

export interface GameDefinition {
  id: string;
  name: string;
  /** 何本先取か（bestOf は奇数）と、対戦ルームに出す試合の形式の説明 */
  format: { bestOf: number; notes: string[] };
  /** 報告できる結果。win・lose・cancel は必ずあり、draw はゲームによる（docs/adr/0010） */
  results: { draw: boolean };
  /** 先後の名前。対戦ごとにマッチの id で決め、1つ目の側が対戦の場所を用意する */
  sides: [string, string];
  /** キャラを選ぶゲームだけ。拒否ステージを共有するキャラの組も持つ */
  characters: { list: Character[]; sharedBanGroups: FighterId[][] } | null;
  /** ステージを拒否し合うゲームだけ（characters が必要） */
  stages: {
    all: { id: StageId; name: string }[];
    starter: StageId[];
    counterpick: StageId[];
    maxBansPerFighter: number;
  } | null;
  /** 対戦の場所の受け渡し。部屋 ID とパスワードか、招待リンク */
  room:
    | {
        kind: 'code';
        /** 部屋のパスワードは数字だけ。部屋を立てる人の端末が generatedDigits 桁で作り、送る前に書き換えられる */
        password: { minDigits: number; maxDigits: number; generatedDigits: number };
        roomIdPattern: string;
        maxPlayers: number;
        entryRestriction: string;
        /** 対戦ルームに表示する部屋の設定の注意書き */
        notes: string[];
      }
    | { kind: 'link'; notes: string[] };
  rating: {
    system: 'glicko2';
    initialRating: number;
    initialRd: number;
    initialVolatility: number;
    tau: number;
    inactivityPeriodSec: number;
  };
  rematchWeight: { windowSec: number; weights: number[] };
  matching: {
    rangeChoices: (number | null)[];
    unlimitedStart: number;
    unlimitedExpandPerMinute: number;
    rematchHourChoices: number[];
    mannersMaxDiff: number;
    recruitmentTtlSec: number;
    heartbeatSec: number;
    applicationTimeoutSec: number;
  };
  report: { deadlineSec: number };
  /** 起点から months か月ごとに区切る。一覧ではないので、誰も更新しなくてもシーズンは続く */
  seasons: { firstStartsAt: number; months: number; utcOffsetMinutes: number };
}

function fail(path: string, reason: string): never {
  throw new Error(`invalid game definition: ${path} ${reason}`);
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'must be an object');
  return v as Record<string, unknown>;
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string' || v === '') fail(path, 'must be a non-empty string');
  return v;
}

function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'must be a finite number');
  return v;
}

function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, 'must be an array');
  return v;
}

function numObj<K extends string>(v: unknown, path: string, keys: readonly K[]): Record<K, number> {
  const o = obj(v, path);
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = num(o[k], `${path}.${k}`);
  return out;
}

const strList = (v: unknown, path: string): string[] => arr(v, path).map((n, i) => str(n, `${path}[${i}]`));

function parseCharacters(v: unknown): GameDefinition['characters'] {
  if (v === undefined || v === null) return null;
  const o = obj(v, 'characters');
  const list = arr(o.list, 'characters.list').map((f, i) => {
    const c = obj(f, `characters.list[${i}]`);
    return { id: str(c.id, `characters.list[${i}].id`), name: str(c.name, `characters.list[${i}].name`) };
  });
  if (list.length === 0) fail('characters.list', 'must not be empty');
  const ids = new Set(list.map((f) => f.id));
  if (ids.size !== list.length) fail('characters.list', 'has duplicate ids');
  const sharedBanGroups = arr(o.sharedBanGroups ?? [], 'characters.sharedBanGroups').map((g, i) =>
    arr(g, `characters.sharedBanGroups[${i}]`).map((id, j) => {
      const s = str(id, `characters.sharedBanGroups[${i}][${j}]`);
      if (!ids.has(s)) fail(`characters.sharedBanGroups[${i}][${j}]`, `unknown character ${s}`);
      return s;
    }),
  );
  return { list, sharedBanGroups };
}

function parseStages(v: unknown, characters: GameDefinition['characters']): GameDefinition['stages'] {
  if (v === undefined || v === null) return null;
  // 拒否ステージは相手のキャラごとに決めるので、キャラのないゲームでは使えない
  if (!characters) fail('stages', 'needs characters');
  const st = obj(v, 'stages');
  const all = arr(st.all, 'stages.all').map((s, i) => {
    const o = obj(s, `stages.all[${i}]`);
    return { id: str(o.id, `stages.all[${i}].id`) as StageId, name: str(o.name, `stages.all[${i}].name`) };
  });
  const stageIds = new Set<string>(all.map((s) => s.id));
  const stageList = (x: unknown, path: string): StageId[] =>
    arr(x, path).map((s, i) => {
      const id = str(s, `${path}[${i}]`);
      if (!stageIds.has(id)) fail(`${path}[${i}]`, `unknown stage ${id}`);
      return id as StageId;
    });
  const starter = stageList(st.starter, 'stages.starter');
  const counterpick = stageList(st.counterpick, 'stages.counterpick');
  for (const s of starter) {
    if (!counterpick.includes(s)) fail('stages.starter', `${s} must also be a counterpick stage`);
  }
  return { all, starter, counterpick, maxBansPerFighter: num(st.maxBansPerFighter, 'stages.maxBansPerFighter') };
}

function parsePassword(v: unknown): { minDigits: number; maxDigits: number; generatedDigits: number } {
  const o = obj(v, 'room.password');
  const minDigits = num(o.minDigits, 'room.password.minDigits');
  const maxDigits = num(o.maxDigits, 'room.password.maxDigits');
  const generatedDigits = num(o.generatedDigits, 'room.password.generatedDigits');
  if (minDigits < 1 || maxDigits < minDigits) fail('room.password.maxDigits', 'must be at least minDigits');
  if (generatedDigits < minDigits || generatedDigits > maxDigits) fail('room.password.generatedDigits', 'must be between minDigits and maxDigits');
  return { minDigits, maxDigits, generatedDigits };
}

function parseRoom(v: unknown): GameDefinition['room'] {
  const room = obj(v, 'room');
  const notes = strList(room.notes ?? [], 'room.notes');
  if (room.kind === 'link') return { kind: 'link', notes };
  if (room.kind !== 'code') fail('room.kind', 'must be code or link');
  return {
    kind: 'code',
    password: parsePassword(room.password),
    roomIdPattern: str(room.roomIdPattern, 'room.roomIdPattern'),
    maxPlayers: num(room.maxPlayers, 'room.maxPlayers'),
    entryRestriction: str(room.entryRestriction, 'room.entryRestriction'),
    notes,
  };
}

export function parseGameDefinition(json: unknown): GameDefinition {
  const root = obj(json, '$');
  const characters = parseCharacters(root.characters);
  const stages = parseStages(root.stages, characters);

  const fmt = obj(root.format, 'format');
  const format = { bestOf: num(fmt.bestOf, 'format.bestOf'), notes: strList(fmt.notes ?? [], 'format.notes') };
  if (!Number.isInteger(format.bestOf) || format.bestOf < 1 || format.bestOf % 2 !== 1) fail('format.bestOf', 'must be a positive odd integer');

  const res = obj(root.results ?? {}, 'results');
  if (res.draw !== undefined && typeof res.draw !== 'boolean') fail('results.draw', 'must be a boolean');
  const sides = strList(root.sides, 'sides');
  if (sides.length !== 2 || sides[0] === sides[1]) fail('sides', 'must be two different names');

  const rating = obj(root.rating, 'rating');
  if (rating.system !== 'glicko2') fail('rating.system', 'must be glicko2');

  const rw = obj(root.rematchWeight, 'rematchWeight');
  const weights = arr(rw.weights, 'rematchWeight.weights').map((w, i) => num(w, `rematchWeight.weights[${i}]`));
  if (weights.length === 0) fail('rematchWeight.weights', 'must not be empty');

  const m = obj(root.matching, 'matching');
  const id = str(root.id, 'id');
  if (!/^[a-z0-9_]{1,32}$/.test(id)) fail('id', 'must be lowercase letters, digits and _');

  return {
    id,
    name: str(root.name, 'name'),
    format,
    results: { draw: res.draw === true },
    sides: [sides[0]!, sides[1]!],
    characters,
    stages,
    room: parseRoom(root.room),
    rating: {
      system: 'glicko2',
      ...numObj(rating, 'rating', ['initialRating', 'initialRd', 'initialVolatility', 'tau', 'inactivityPeriodSec'] as const),
    },
    rematchWeight: { windowSec: num(rw.windowSec, 'rematchWeight.windowSec'), weights },
    matching: {
      rangeChoices: arr(m.rangeChoices, 'matching.rangeChoices').map((c, i) =>
        c === null ? null : num(c, `matching.rangeChoices[${i}]`),
      ),
      rematchHourChoices: arr(m.rematchHourChoices, 'matching.rematchHourChoices').map((c, i) =>
        num(c, `matching.rematchHourChoices[${i}]`),
      ),
      ...numObj(m, 'matching', [
        'unlimitedStart', 'unlimitedExpandPerMinute', 'mannersMaxDiff',
        'recruitmentTtlSec', 'heartbeatSec', 'applicationTimeoutSec',
      ] as const),
    },
    report: numObj(root.report, 'report', ['deadlineSec'] as const),
    seasons: parseSeasons(root.seasons),
  };
}

/**
 * 対戦の先後（docs/adr/0010）。マッチの id の最後の16進数が偶数なら p1 が1つ目の側。
 * どちらのクライアントも同じ結果を出せ、募集した側が選ぶこともできない
 */
export function sideOf(matchId: string, role: 'p1' | 'p2'): 0 | 1 {
  const p1First = parseInt(matchId.slice(-1), 16) % 2 === 0;
  return (role === 'p1') === p1First ? 0 : 1;
}

function parseSeasons(v: unknown): GameDefinition['seasons'] {
  const s = numObj(v, 'seasons', ['firstStartsAt', 'months', 'utcOffsetMinutes'] as const);
  if (!Number.isInteger(s.months) || s.months < 1) fail('seasons.months', 'must be a positive integer');
  // 29〜31日を起点にすると、月によってその日がない
  if (new Date((s.firstStartsAt + s.utcOffsetMinutes * 60) * 1000).getUTCDate() > 28) {
    fail('seasons.firstStartsAt', 'must be on day 1-28 of the month');
  }
  return s;
}

/** 起点から k 区切り目の開始時刻（指定の時差での暦の月で数える） */
function boundary(def: GameDefinition, k: number): number {
  const { firstStartsAt, months, utcOffsetMinutes } = def.seasons;
  const off = utcOffsetMinutes * 60;
  const l = new Date((firstStartsAt + off) * 1000);
  const t = Date.UTC(l.getUTCFullYear(), l.getUTCMonth() + months * k, l.getUTCDate(), l.getUTCHours(), l.getUTCMinutes(), l.getUTCSeconds());
  return t / 1000 - off;
}

/** 今、新しい対戦を始められるか（シーズンが始まっているか）。受け付けないときは最初のシーズンを返す */
export function acceptsNewMatches(def: GameDefinition, now: number): { ok: true } | { ok: false; next: Season } {
  return currentSeason(def, now) ? { ok: true } : { ok: false, next: seasonById(def, 1) };
}

/**
 * 対戦の報告の締め切り（docs/spec.md「結果の確定」）。作成から deadlineSec 後か、
 * 作成した時刻のシーズンの終わりの早いほう
 */
export function matchDeadline(def: GameDefinition, createdAt: number): number {
  const end = createdAt + def.report.deadlineSec;
  const season = currentSeason(def, createdAt);
  return season ? Math.min(end, season.endsAt) : end;
}

/** シーズン id は 1 から */
export function seasonById(def: GameDefinition, id: number): Season {
  return { id, startsAt: boundary(def, id - 1), endsAt: boundary(def, id) };
}

/** 拒否ステージを共有するグループなら先頭のキャラ、それ以外は自分自身 */
export function banGroupKey(def: GameDefinition, fighter: FighterId): FighterId {
  const group = def.characters?.sharedBanGroups.find((g) => g.includes(fighter));
  return group?.[0] ?? fighter;
}

export function currentSeason(def: GameDefinition, now: number): Season | null {
  if (now < def.seasons.firstStartsAt) return null;
  const { firstStartsAt, months, utcOffsetMinutes } = def.seasons;
  const off = utcOffsetMinutes * 60;
  const a = new Date((firstStartsAt + off) * 1000);
  const b = new Date((now + off) * 1000);
  // 月の差から見当を付け、境目の前後を確かめる
  let id = Math.floor(((b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth())) / months) + 1;
  while (id > 1 && now < seasonById(def, id).startsAt) id--;
  while (now >= seasonById(def, id).endsAt) id++;
  return seasonById(def, id);
}
