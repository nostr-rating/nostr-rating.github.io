import { validateStageBans, type GameDefinition, type StageBanError, type StageBans } from '@nostr-rating/core';
import { messages, useLocale, type Locale } from './i18n.js';

const M = messages({
  ja: {
    noStages: 'このゲームには拒否ステージがありません',
    unknownFighter: (f: string) => `${f}: 不明なファイター`,
    useGroupKey: (f: string, key: string) => `${f}: ${key} として設定してください`,
    tooMany: (f: string, max: number) => `${f}: 拒否ステージは${max}つまでです`,
    unknownStage: (f: string, s: string) => `${f}: 不明なステージ ${s}`,
    duplicate: (f: string) => `${f}: 同じステージが重複しています`,
  },
  en: {
    noStages: 'This game has no stage bans',
    unknownFighter: (f: string) => `${f}: unknown fighter`,
    useGroupKey: (f: string, key: string) => `${f}: set this as ${key}`,
    tooMany: (f: string, max: number) => `${f}: up to ${max} stage bans`,
    unknownStage: (f: string, s: string) => `${f}: unknown stage ${s}`,
    duplicate: (f: string) => `${f}: the same stage is listed twice`,
  },
});

/** 拒否ステージの誤り（core の StageBanError）を、指定の言語の文にする */
export function stageBanErrorText(e: StageBanError, l: Locale): string {
  const t = M[l];
  switch (e.code) {
    case 'no_stages':
      return t.noStages;
    case 'unknown_fighter':
      return t.unknownFighter(e.fighter);
    case 'use_group_key':
      return t.useGroupKey(e.fighter, e.key);
    case 'too_many':
      return t.tooMany(e.fighter, e.max);
    case 'unknown_stage':
      return t.unknownStage(e.fighter, e.stage);
    case 'duplicate_stage':
      return t.duplicate(e.fighter);
  }
}

/** 拒否ステージの設定を確かめ、誤りを今の言語の文で返す */
export function useStageBanErrors(def: GameDefinition, bans: StageBans): string[] {
  const l = useLocale();
  return validateStageBans(def, bans).map((e) => stageBanErrorText(e, l));
}
