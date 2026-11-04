import type { Locale } from '@nostr-rating/core';

/**
 * 復活の道具の入手先。道具は Pages では配らずリリースに添付するので（docs/adr/0008「復活の道具」）、
 * ビルドのときに一番新しい recovery-v* のリリースのページを VITE_RECOVERY_URL で受け取る。
 * まだ出していなければリリースの一覧を指す
 */
export function recoveryUrl(env: { VITE_RECOVERY_URL?: string; VITE_REPO_URL?: string }): string | null {
  if (env.VITE_RECOVERY_URL) return env.VITE_RECOVERY_URL;
  return env.VITE_REPO_URL ? `${env.VITE_REPO_URL}/releases` : null;
}

const LINK: Record<Locale, (url: string) => string> = {
  ja: (url) => `<p><a href="${url}" target="_blank" rel="noopener noreferrer">復活の道具を入手する</a>（リリースのページです。ファイルの sha256 もそこで確かめられます）</p>`,
  en: (url) => `<p><a href="${url}" target="_blank" rel="noopener noreferrer">Get the recovery tool</a> (this is the release page, where you can also check the file's sha256)</p>`,
};

/** 言語ごとのヘルプのページ（public/ の下）。日本語版が元で、ほかの言語はその訳 */
export const HELP_PAGES: Record<Locale, string> = { ja: 'help/account.html', en: 'help/account.en.html' };

/** ヘルプは手で書いた HTML なので、ビルドのときに印（<!-- recovery-link -->）をそのページの言語のリンクに置き換える */
export function withRecoveryLink(html: string, url: string | null, locale: Locale): string {
  return html.replace('<!-- recovery-link -->', url ? LINK[locale](url) : '');
}

/** アプリの中で使う入手先（vite.config.ts が recoveryUrl の結果を埋め込む） */
export function recoveryLink(): string | null {
  return import.meta.env.VITE_RECOVERY_URL || null;
}
