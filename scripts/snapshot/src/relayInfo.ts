/**
 * NIP-11 で、1回に返す件数の上限（max_limit）がページの大きさより小さいと分かるリレー。
 * 上限で切られたページは、ページの大きさより短いので、取り切ったと見なしてしまう。
 * 上限を公開していないリレーと、情報を読めなかったリレーは数えない
 */
export async function relaysBelowPageSize(
  urls: string[],
  pageSize: number,
  fetchFn: typeof fetch = fetch,
): Promise<{ url: string; maxLimit: number }[]> {
  const out: { url: string; maxLimit: number }[] = [];
  for (const url of urls) {
    const http = new URL(url.replace(/^ws/, 'http'));
    try {
      const res = await fetchFn(http.href, { headers: { Accept: 'application/nostr+json' } });
      if (!res.ok) continue;
      const maxLimit = ((await res.json()) as { limitation?: { max_limit?: unknown } }).limitation?.max_limit;
      if (typeof maxLimit === 'number' && maxLimit < pageSize) out.push({ url, maxLimit });
    } catch {
      // 読めなければ分からないので数えない
    }
  }
  return out;
}
