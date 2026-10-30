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
    const maxLimit = await maxLimitOf(url, fetchFn);
    if (maxLimit !== null && maxLimit < pageSize) out.push({ url, maxLimit });
  }
  return out;
}

/**
 * 上限を公開していないか、情報を読めなかったリレー。上限がページの大きさより小さいと、取り切ったと見なしてしまうおそれがある
 */
export async function relaysWithoutLimit(urls: string[], fetchFn: typeof fetch = fetch): Promise<string[]> {
  const out: string[] = [];
  for (const url of urls) if ((await maxLimitOf(url, fetchFn)) === null) out.push(url);
  return out;
}

/** NIP-11 の max_limit。公開していないか、読めなければ null */
async function maxLimitOf(url: string, fetchFn: typeof fetch): Promise<number | null> {
  const http = new URL(url.replace(/^ws/, 'http'));
  try {
    const res = await fetchFn(http.href, { headers: { Accept: 'application/nostr+json' } });
    if (!res.ok) return null;
    const maxLimit = ((await res.json()) as { limitation?: { max_limit?: unknown } }).limitation?.max_limit;
    return typeof maxLimit === 'number' ? maxLimit : null;
  } catch {
    return null;
  }
}
