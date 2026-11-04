/** 画面の言語。定義ファイルの表示名は、この全部の言語で持つ */
export const LOCALES = ['ja', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

/** 言語ごとの表示の文字列。イベントやスナップショットには入れず、表示するときにだけ選ぶ */
export type LocalizedText = Record<Locale, string>;

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

/**
 * 定義ファイルの表示名を読む。文字列は全部の言語で同じ表記（「P1」など）、
 * オブジェクトは言語ごとの表記で、どの言語も欠かせない
 */
export function parseLocalizedText(v: unknown, fail: (reason: string) => never): LocalizedText {
  if (typeof v === 'string') {
    if (v === '') fail('must be a non-empty string');
    return Object.fromEntries(LOCALES.map((l) => [l, v])) as LocalizedText;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail('must be a string or an object with a string for each locale');
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!isLocale(k)) fail(`has unknown locale ${k}`);
  for (const l of LOCALES) if (typeof o[l] !== 'string' || o[l] === '') fail(`must have a non-empty string for ${l}`);
  return o as LocalizedText;
}
