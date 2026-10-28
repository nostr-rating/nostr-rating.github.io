/**
 * 復活の道具の入手先。道具は Pages では配らずリリースに添付するので（docs/adr/0008「復活の道具」）、
 * ビルドのときに一番新しい recovery-v* のリリースのページを VITE_RECOVERY_URL で受け取る。
 * まだ出していなければリリースの一覧を指す
 */
export function recoveryUrl(env: { VITE_RECOVERY_URL?: string; VITE_REPO_URL?: string }): string | null {
  if (env.VITE_RECOVERY_URL) return env.VITE_RECOVERY_URL;
  return env.VITE_REPO_URL ? `${env.VITE_REPO_URL}/releases` : null;
}

/** ヘルプは手で書いた HTML なので、ビルドのときに印（<!-- recovery-link -->）をリンクに置き換える */
export function withRecoveryLink(html: string, url: string | null): string {
  const link = url
    ? `<p><a href="${url}" target="_blank" rel="noopener noreferrer">復活の道具を入手する</a>（リリースのページです。ファイルの sha256 もそこで確かめられます）</p>`
    : '';
  return html.replace('<!-- recovery-link -->', link);
}

/** アプリの中で使う入手先（vite.config.ts が recoveryUrl の結果を埋め込む） */
export function recoveryLink(): string | null {
  return import.meta.env.VITE_RECOVERY_URL || null;
}
