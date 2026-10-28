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

  const fighterName = (id: string) => def.fighters.find((f) => f.id === id)?.name ?? id;
  const stageName = (id: string) => def.stages.all.find((s) => s.id === id)?.name ?? id;

  return (
    <section>
      <div className="card stack">
        <h2>拒否ステージ</h2>
        <p className="muted">相手のキャラごとに、戦いたくないステージを{def.stages.maxBansPerFighter}つまで設定できます。変更は次の対戦から反映されます。</p>
        <label htmlFor="ban-fighter">相手のファイター</label>
        <select id="ban-fighter" value={fighter} onChange={(e) => setFighter(e.target.value)}>
          <option value="">選んでください</option>
          {def.fighters.map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
        {key && (
          <div className="chips">
            {def.stages.counterpick.map((s) => {
              const on = current.includes(s);
              return (
                <button
                  key={s}
                  type="button"
                  className={`chip ${on ? 'on' : ''}`}
                  aria-pressed={on}
                  disabled={!on && current.length >= def.stages.maxBansPerFighter}
                  onClick={() => toggle(s)}
                >
                  {stageName(s)}
                </button>
              );
            })}
          </div>
        )}
        {Object.keys(bans).length > 0 && (
          <table>
            <tbody>
              {Object.entries(bans).map(([f, ss]) => (
                <tr key={f}>
                  <td>{[f, ...(def.sharedBanGroups.find((g) => g[0] === f)?.slice(1) ?? [])].map(fighterName).join('／')}</td>
                  <td>{ss.map(stageName).join('、')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {errors.map((e) => (
          <p key={e} className="error">{e}</p>
        ))}
      </div>

      <div className="card stack">
        <h2>対戦設定</h2>
        <label htmlFor="range">マッチングするレート差</label>
        <select id="range" value={range === null ? '' : String(range)} onChange={(e) => setRange(e.target.value === '' ? null : Number(e.target.value))}>
          {def.matching.rangeChoices.map((c) => (
            <option key={String(c)} value={c === null ? '' : String(c)}>{rangeLabel(c)}</option>
          ))}
        </select>
        <label htmlFor="rematch">連戦</label>
        <select id="rematch" value={String(rematch)} onChange={(e) => setRematch(Number(e.target.value))}>
          {def.matching.rematchHourChoices.map((h) => (
            <option key={h} value={String(h)}>{h === 0 ? '連戦を許可する' : `${h}時間以内に対戦した相手とはマッチしない`}</option>
          ))}
        </select>
      </div>

      <button type="button" className="primary" disabled={errors.length > 0 || !app.signer} onClick={() => void save()}>
        設定を保存
      </button>
      {message && <p>{message}</p>}

      <div className="card stack">
        <h2>端末</h2>
        <Devices />
        <p className="muted">
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
        <div className="card stack">
          <h2>復活の言葉</h2>
          <RecoveryWords words={app.pendingWords} onConfirmed={() => void app.confirmWords()} />
        </div>
      )}

      <details className="card">
        <summary>詳細設定（リレー・スナップショットの取得元）</summary>
        <div className="stack">
          <label htmlFor="relays">リレー URL（1行に1つ。空なら既定）</label>
          <textarea id="relays" rows={4} value={relays} onChange={(e) => setRelays(e.target.value)} />
          <label htmlFor="snap-base">スナップショットの取得元（空なら既定）</label>
          <input id="snap-base" value={snapBase} onChange={(e) => setSnapBase(e.target.value)} />
          <button
            type="button"
            onClick={() => {
              const list = relays.split('\n').map((s) => s.trim()).filter(Boolean);
              saveOverrides({ relays: list.length ? list : undefined, snapshotBase: snapBase.trim() || undefined });
              setMessage('保存しました。再読み込みすると反映されます');
            }}
          >
            取得元を保存
          </button>
        </div>
      </details>
    </section>
  );
}
