import type { FighterId, StageId } from '../types.js';

export interface Season {
  id: number;
  startsAt: number;
  endsAt: number;
}

export interface GameDefinition {
  id: string;
  name: string;
  format: { bestOf: number; stock: number; timeLimitSec: number };
  room: {
    defaultPassword: string;
    roomIdPattern: string;
    maxPlayers: number;
    entryRestriction: string;
    /** 対戦ルームに表示する部屋の設定の注意書き */
    notes: string[];
  };
  fighters: { id: FighterId; name: string }[];
  sharedBanGroups: FighterId[][];
  stages: {
    all: { id: StageId; name: string }[];
    starter: StageId[];
    counterpick: StageId[];
    maxBansPerFighter: number;
  };
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
  seasons: Season[];
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

export function parseGameDefinition(json: unknown): GameDefinition {
  const root = obj(json, '$');

  const fighters = arr(root.fighters, 'fighters').map((f, i) => {
    const o = obj(f, `fighters[${i}]`);
    return { id: str(o.id, `fighters[${i}].id`), name: str(o.name, `fighters[${i}].name`) };
  });
  const fighterIds = new Set(fighters.map((f) => f.id));
  if (fighterIds.size !== fighters.length) fail('fighters', 'has duplicate ids');

  const sharedBanGroups = arr(root.sharedBanGroups, 'sharedBanGroups').map((g, i) =>
    arr(g, `sharedBanGroups[${i}]`).map((id, j) => {
      const s = str(id, `sharedBanGroups[${i}][${j}]`);
      if (!fighterIds.has(s)) fail(`sharedBanGroups[${i}][${j}]`, `unknown fighter ${s}`);
      return s;
    }),
  );

  const st = obj(root.stages, 'stages');
  const all = arr(st.all, 'stages.all').map((s, i) => {
    const o = obj(s, `stages.all[${i}]`);
    return { id: str(o.id, `stages.all[${i}].id`) as StageId, name: str(o.name, `stages.all[${i}].name`) };
  });
  const stageIds = new Set<string>(all.map((s) => s.id));
  const stageList = (v: unknown, path: string): StageId[] =>
    arr(v, path).map((s, i) => {
      const id = str(s, `${path}[${i}]`);
      if (!stageIds.has(id)) fail(`${path}[${i}]`, `unknown stage ${id}`);
      return id as StageId;
    });

  const starter = stageList(st.starter, 'stages.starter');
  const counterpick = stageList(st.counterpick, 'stages.counterpick');
  for (const s of starter) {
    if (!counterpick.includes(s)) fail('stages.starter', `${s} must also be a counterpick stage`);
  }
  const format = numObj(root.format, 'format', ['bestOf', 'stock', 'timeLimitSec'] as const);
  if (format.bestOf % 2 !== 1) fail('format.bestOf', 'must be odd');

  const rating = obj(root.rating, 'rating');
  if (rating.system !== 'glicko2') fail('rating.system', 'must be glicko2');

  const rw = obj(root.rematchWeight, 'rematchWeight');
  const weights = arr(rw.weights, 'rematchWeight.weights').map((w, i) => num(w, `rematchWeight.weights[${i}]`));
  if (weights.length === 0) fail('rematchWeight.weights', 'must not be empty');

  const m = obj(root.matching, 'matching');
  const room = obj(root.room, 'room');

  return {
    id: str(root.id, 'id'),
    name: str(root.name, 'name'),
    format,
    room: {
      defaultPassword: str(room.defaultPassword, 'room.defaultPassword'),
      roomIdPattern: str(room.roomIdPattern, 'room.roomIdPattern'),
      maxPlayers: num(room.maxPlayers, 'room.maxPlayers'),
      entryRestriction: str(room.entryRestriction, 'room.entryRestriction'),
      notes: arr(room.notes, 'room.notes').map((n, i) => str(n, `room.notes[${i}]`)),
    },
    fighters,
    sharedBanGroups,
    stages: {
      all,
      starter,
      counterpick,
      maxBansPerFighter: num(st.maxBansPerFighter, 'stages.maxBansPerFighter'),
    },
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
    seasons: arr(root.seasons, 'seasons').map((s, i) =>
      numObj(s, `seasons[${i}]`, ['id', 'startsAt', 'endsAt'] as const),
    ),
  };
}

/** 拒否ステージを共有するグループなら先頭のファイター、それ以外は自分自身 */
export function banGroupKey(def: GameDefinition, fighter: FighterId): FighterId {
  const group = def.sharedBanGroups.find((g) => g.includes(fighter));
  return group?.[0] ?? fighter;
}

export function currentSeason(def: GameDefinition, now: number): Season | null {
  return def.seasons.find((s) => s.startsAt <= now && now < s.endsAt) ?? null;
}
