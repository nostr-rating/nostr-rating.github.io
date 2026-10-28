import { buildSettings, parseSettings, validateStageBans, banGroupKey, type StageBans, type StageId } from '@nostr-rating/core';
import { useEffect, useState } from 'react';
import { Devices } from '../components/Devices.js';
import { RecoveryWords } from '../components/RecoveryWords.js';
import { currentOverrides, saveOverrides } from '../services/config.js';
import { useApp } from '../state/AppContext.js';

export function rangeLabel(v: number | null): string {
  return v === null ? '制限なし' : `±${v}`;
}

export function Settings() {
  const app = useApp();
  const { def } = app;
  const [bans, setBans] = useState<StageBans>(app.mySettings?.stageBans ?? {});
  const [range, setRange] = useState<number | null>(app.mySettings?.rangeChoice ?? null);
  const [rematch, setRematch] = useState<number>(app.mySettings?.rematchHours ?? 0);
  const [fighter, setFighter] = useState<string>('');
  const [message, setMessage] = useState<string | null>(null);
  const [overrideMessage, setOverrideMessage] = useState<string | null>(null);
  const overrides = currentOverrides();
  const [relays, setRelays] = useState((overrides.relays ?? []).join('\n'));
  const [snapBase, setSnapBase] = useState(overrides.snapshotBase ?? '');

  useEffect(() => {
    if (!app.mySettings) return;
    setBans(app.mySettings.stageBans);
    setRange(app.mySettings.rangeChoice);
    setRematch(app.mySettings.rematchHours);
  }, [app.mySettings]);

  const key = fighter ? banGroupKey(def, fighter) : '';
  const current = key ? (bans[key] ?? []) : [];
  const toggle = (stage: StageId) => {
    const next = current.includes(stage) ? current.filter((s) => s !== stage) : [...current, stage];
    const updated = { ...bans, [key]: next };
    if (next.length === 0) delete updated[key];
    setBans(updated);
  };
  const errors = validateStageBans(def, bans);

  const save = async () => {
    if (!app.signer) return;
    setMessage(null);
    try {
      const ev = await app.signer.signEvent(buildSettings(def.id, { stageBans: bans, rangeChoice: range, rematchHours: rematch }, app.now()));
      await app.relay.publish(ev);
      await app.store.put([ev]);
      const parsed = parseSettings(def.id, ev, app.pubkey);
      if (parsed) app.setMySettings(parsed);
      setMessage('保存しました');
    } catch {
      setMessage('保存できませんでした。電波のよい場所でもう一度押してください。');
    }
  };

  // 拒否ステージは、ステージとキャラのあるゲームだけ（docs/adr/0010）
  const { stages, characters } = def;
  const fighterName = (id: string) => characters?.list.find((f) => f.id === id)?.name ?? id;
  const stageName = (id: string) => stages?.all.find((s) => s.id === id)?.name ?? id;

  const banCount = Object.keys(bans).length;

  return (
    <section>
      <div className="card">
        <h2>対戦設定</h2>
        {stages && characters && (
          <div className="stack">
            <h3>拒否ステージ</h3>
            <p className="hint">相手のキャラごとに、戦いたくないステージを{stages.maxBansPerFighter}つまで設定できます。変更は次の対戦から反映されます。</p>
            <div className="field">
              <label htmlFor="ban-fighter">相手のファイター</label>
              <select id="ban-fighter" value={fighter} onChange={(e) => setFighter(e.target.value)}>
                <option value="">選んでください</option>
                {characters.list.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </div>
            {key && (
              <div className="chips">
                {stages.counterpick.map((s) => {
                  const on = current.includes(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      className={`chip ${on ? 'on' : ''}`}
                      aria-pressed={on}
                      disabled={!on && current.length >= stages.maxBansPerFighter}
                      onClick={() => toggle(s)}
                    >
                      {stageName(s)}
                    </button>
                  );
                })}
              </div>
            )}
            {errors.map((e) => (
              <p key={e} className="error">{e}</p>
            ))}
            <details>
              <summary>設定済みの拒否ステージ: {banCount}件</summary>
              {banCount === 0 ? (
                <p className="muted">まだありません。</p>
              ) : (
                <table>
                  <tbody>
                    {Object.entries(bans).map(([f, ss]) => (
                      <tr key={f}>
                        <td>{[f, ...(characters.sharedBanGroups.find((g) => g[0] === f)?.slice(1) ?? [])].map(fighterName).join('／')}</td>
                        <td>{ss.map(stageName).join('、')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </details>
          </div>
        )}
        <div className="field">
          <label htmlFor="range">マッチングするレート差</label>
          <select id="range" value={range === null ? '' : String(range)} onChange={(e) => setRange(e.target.value === '' ? null : Number(e.target.value))}>
            {def.matching.rangeChoices.map((c) => (
              <option key={String(c)} value={c === null ? '' : String(c)}>{rangeLabel(c)}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rematch">連戦</label>
          <select id="rematch" value={String(rematch)} onChange={(e) => setRematch(Number(e.target.value))}>
            {def.matching.rematchHourChoices.map((h) => (
              <option key={h} value={String(h)}>{h === 0 ? '連戦を許可する' : `${h}時間以内に対戦した相手とはマッチしない`}</option>
            ))}
          </select>
        </div>
        <button type="button" className="primary wide" disabled={errors.length > 0 || !app.signer} onClick={() => void save()}>
          設定を保存
        </button>
        <p className="slot" role="status">{message ?? ''}</p>
      </div>

      <div className="card">
        <h2>端末</h2>
        <Devices />
        <p className="hint">
          端末を全部失くしたときは、復活の言葉を復活の道具に入力して戻します。
          {import.meta.env.VITE_REPO_URL && (
            <>
              {' '}
              <a href={`${import.meta.env.VITE_REPO_URL}/releases/latest`} target="_blank" rel="noopener noreferrer">
                復活の道具を入手する
              </a>
            </>
          )}
        </p>
      </div>

      {app.pendingWords && (
        <div className="card">
          <h2>復活の言葉</h2>
          <RecoveryWords key={app.pendingWords} words={app.pendingWords} onConfirmed={() => void app.confirmWords()} onSplit={app.splitWords} />
        </div>
      )}

      <details className="card">
        <summary>詳細設定</summary>
        <div className="stack">
          <p className="hint">ふつうは変えません。リレーと、スナップショットの取得元を差し替えるときに使います。</p>
          <div className="field">
            <label htmlFor="relays">リレー URL</label>
            <textarea id="relays" rows={4} value={relays} onChange={(e) => setRelays(e.target.value)} />
            <p className="hint">1行に1つ書きます。空なら既定のリレーを使います。</p>
          </div>
          <div className="field">
            <label htmlFor="snap-base">スナップショットの取得元</label>
            <input id="snap-base" value={snapBase} onChange={(e) => setSnapBase(e.target.value)} />
            <p className="hint">空なら既定の取得元を使います。</p>
          </div>
          <button
            type="button"
            onClick={() => {
              const list = relays.split('\n').map((s) => s.trim()).filter(Boolean);
              saveOverrides({ relays: list.length ? list : undefined, snapshotBase: snapBase.trim() || undefined });
              setOverrideMessage('保存しました。再読み込みすると反映されます');
            }}
          >
            取得元を保存
          </button>
          <p className="slot" role="status">{overrideMessage ?? ''}</p>
        </div>
      </details>
    </section>
  );
}
