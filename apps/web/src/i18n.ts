import { isLocale, LOCALES, type Locale, type LocalizedText } from '@nostr-rating/core';
import { useSyncExternalStore } from 'react';
import { HELP_PAGES } from './recoveryLink.js';

/**
 * 画面の言語の切り替え。文言は使う場所の近くに言語ごとにまとめて置き（messages）、
 * 表示するときに今の言語の分を選ぶ。イベントや保存する値には言語によらない id だけを入れる
 */

export { LOCALES, type Locale };

const KEY = 'nostr-rating:locale';

/** 選んだ言語 → ブラウザの言語の順。日本語以外のブラウザでは英語にする */
function initial(): Locale {
  try {
    const saved = localStorage.getItem(KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // 保存できない環境ではブラウザの言語で決める
  }
  const langs = typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const l of langs) {
    const base = l?.toLowerCase().split('-')[0];
    if (isLocale(base)) return base;
  }
  return 'en';
}

let current: Locale = initial();
const listeners = new Set<() => void>();

function apply(): void {
  if (typeof document !== 'undefined') document.documentElement.lang = current;
}
apply();

export function locale(): Locale {
  return current;
}

export function setLocale(l: Locale): void {
  if (l === current) return;
  current = l;
  try {
    localStorage.setItem(KEY, l);
  } catch {
    // 次に開いたときはブラウザの言語に戻る
  }
  apply();
  for (const f of listeners) f();
}

function subscribe(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, locale, locale);
}

/** 言語ごとの文言。英語の分は日本語の分と同じ形でないと型が通らない */
export type Messages<T> = Record<Locale, T>;
export const messages = <T,>(m: { ja: T; en: NoInfer<T> }): Messages<T> => m;

/** 今の言語の文言（言語を切り替えると描き直す） */
export function useT<T>(m: Messages<T>): T {
  return m[useLocale()];
}

/** React の外（サービスなど）で使う、今の言語の文言 */
export function tr<T>(m: Messages<T>): T {
  return m[current];
}

/** 定義ファイルの表示名を今の言語で */
export function useText(): (t: LocalizedText) => string {
  const l = useLocale();
  return (t) => t[l];
}

/** ヘルプは言語ごとに別の HTML（public/help/） */
export const helpPage = (l: Locale): string => `${import.meta.env.BASE_URL}${HELP_PAGES[l]}`;

export const LOCALE_NAMES: Record<Locale, string> = { ja: '日本語', en: 'English' };
