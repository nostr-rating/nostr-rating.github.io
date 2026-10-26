/// <reference lib="webworker" />
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

// opfs-sahpool VFS は COOP/COEP ヘッダーなしで動くので GitHub Pages でも使える
type Req = { id: number; op: 'init' | 'put' | 'query' | 'purge'; args?: any };

let db: any = null;

async function init(): Promise<void> {
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'nostr-rating' });
  db = new pool.OpfsSAHPoolDb('/events.sqlite3');
  db.exec(`CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, kind INTEGER NOT NULL, pubkey TEXT NOT NULL, created_at INTEGER NOT NULL, json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_kind_created ON events(kind, created_at);`);
}

function handle(op: Req['op'], args: any): unknown {
  switch (op) {
    case 'put':
      db.transaction(() => {
        for (const e of args as any[]) {
          db.exec({
            sql: 'INSERT OR IGNORE INTO events (id, kind, pubkey, created_at, json) VALUES (?, ?, ?, ?, ?)',
            bind: [e.id, e.kind, e.pubkey, e.created_at, JSON.stringify(e)],
          });
        }
      });
      return null;
    case 'query': {
      const where: string[] = [];
      const bind: unknown[] = [];
      if (args.kinds) {
        where.push(`kind IN (${args.kinds.map(() => '?').join(',')})`);
        bind.push(...args.kinds);
      }
      if (args.since !== undefined) {
        where.push('created_at >= ?');
        bind.push(args.since);
      }
      const rows = db.selectValues(`SELECT json FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, bind);
      return (rows as string[]).map((r) => JSON.parse(r));
    }
    case 'purge':
      db.exec({
        sql: `DELETE FROM events WHERE created_at < ? AND kind IN (${args.kinds.map(() => '?').join(',')})`,
        bind: [args.createdAt, ...args.kinds],
      });
      return db.changes();
    default:
      throw new Error(`unknown op ${op}`);
  }
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, op, args } = e.data;
  try {
    const result = op === 'init' ? await init() : handle(op, args);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) });
  }
};
