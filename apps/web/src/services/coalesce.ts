/**
 * fn を同時に1つだけ走らせる。走っている間に呼ばれた分は、終わったあとに1回だけまとめて走らせ、
 * その結果を返す（docs/adr/0011「クライアントの同期を1本にする」）。後から始めた分が先に終わって、
 * 古い結果で新しい結果を上書きすることがない
 */
export function coalesce<T>(fn: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  let queued: Promise<T> | null = null;
  const start = (): Promise<T> => {
    const p = fn().finally(() => {
      running = null;
    });
    running = p;
    return p;
  };
  return () => {
    if (!running) return start();
    queued ??= running
      .catch(() => undefined)
      .then(() => {
        queued = null;
        return start();
      });
    return queued;
  };
}
