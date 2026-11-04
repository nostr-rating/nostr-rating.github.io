import { buildSettings, parseSettings, validRoomPassword, banGroupKey, type StageBans, type StageId } from '@nostr-rating/core';
import { useEffect, useState } from 'react';
import { Devices } from '../components/Devices.js';
import { currentOverrides, defaultRoomPassword, saveDefaultRoomPassword, saveOverrides } from '../services/config.js';
import { messages, tr, useT, useText } from '../i18n.js';
import { recoveryLink } from '../recoveryLink.js';
import { useStageBanErrors } from '../stageErrors.js';
import { useApp } from '../state/AppContext.js';

const M = messages({
  ja: {
    unlimited: '制限なし',
    saved: '保存しました',
    saveFailed: '保存できませんでした。電波のよい場所でもう一度押してください。',
    matchSettings: '対戦設定',
    stageBans: '拒否ステージ',
    stageBansHint: (n: number) => `相手のキャラごとに、戦いたくないステージを${n}つまで設定できます。変更は次の対戦から反映されます。`,
    opponentFighter: '相手のファイター',
    choose: '選んでください',
    savedBans: (n: number) => `設定済みの拒否ステージ: ${n}件`,
    none: 'まだありません。',
    fighterSep: '／',
    stageSep: '、',
    range: 'マッチングするレート差',
    rematch: '連戦',
    rematchAllowed: '連戦を許可する',
    rematchHours: (h: number) => `${h}時間以内に対戦した相手とはマッチしない`,
    defaultPassword: '部屋のパスワードの初期値',
    passwordHint: (n: number) => `空にしておくと、対戦ごとに数字${n}桁を作ります。この端末にだけ保存し、公開はしません。`,
    passwordError: (min: number, max: number) => `数字${min}〜${max}桁で入力してください。`,
    save: '設定を保存',
    devices: '端末',
    recoveryHint: '端末を全部失くしたときは、復活の言葉を復活の道具に入力して復元します。',
    getRecoveryTool: '復活の道具を入手する',
    advanced: '詳細設定',
    advancedHint: 'ふつうは変えません。リレーと、スナップショットの取得元を差し替えるときに使います。',
    relays: 'リレー URL',
    relaysHint: '1行に1つ書きます。空なら既定のリレーを使います。',
    snapshotBase: 'スナップショットの取得元',
    snapshotBaseHint: '空なら既定の取得元を使います。',
    overridesSaved: '保存しました。再読み込みすると反映されます',
    saveOverrides: '取得元を保存',
  },
  en: {
    unlimited: 'No limit',
    saved: 'Saved',
    saveFailed: 'Could not save. Press it again in a place with a better connection.',
    matchSettings: 'Match settings',
    stageBans: 'Stage bans',
    stageBansHint: (n: number) => `For each opponent fighter, you can ban up to ${n} stages you do not want to play on. Changes apply from your next match.`,
    opponentFighter: 'Opponent fighter',
    choose: 'Choose one',
    savedBans: (n: number) => `Saved stage bans: ${n}`,
    none: 'None yet.',
    fighterSep: ' / ',
    stageSep: ', ',
    range: 'Rating gap to match within',
    rematch: 'Rematches',
    rematchAllowed: 'Allow rematches',
    rematchHours: (h: number) => `Do not match opponents I played within ${h} ${h === 1 ? 'hour' : 'hours'}`,
    defaultPassword: 'Default room password',
    passwordHint: (n: number) => `If left empty, a ${n}-digit number is made for each match. It is saved only on this device and never published.`,
    passwordError: (min: number, max: number) => `Enter ${min} to ${max} digits.`,
    save: 'Save settings',
    devices: 'Devices',
    recoveryHint: 'If you lose all your devices, restore your account by entering your recovery words in the recovery tool.',
    getRecoveryTool: 'Get the recovery tool',
    advanced: 'Advanced settings',
    advancedHint: 'You normally do not change these. Use them to replace the relays or the snapshot source.',
    relays: 'Relay URLs',
    relaysHint: 'One per line. If empty, the default relays are used.',
    snapshotBase: 'Snapshot source',
    snapshotBaseHint: 'If empty, the default source is used.',
    overridesSaved: 'Saved. Reload to apply.',
    saveOverrides: 'Save sources',
  },
});

/** 画面の描き直しのときに呼ぶので、今の言語で返す */
export function rangeLabel(v: number | null): string {
  return v === null ? tr(M).unlimited : `±${v}`;
}

export function Settings() {
  const app = useApp();
  const t = useT(M);
  const text = useText();
  const { def } = app;
  const [bans, setBans] = useState<StageBans>(app.mySettings?.stageBans ?? {});
  const [range, setRange] = useState<number | null>(app.mySettings?.rangeChoice ?? null);
  const [rematch, setRematch] = useState<number>(app.mySettings?.rematchHours ?? 0);
  const [fighter, setFighter] = useState<string>('');
  const [message, setMessage] = useState<string | null>(null);
  const [overrideMessage, setOverrideMessage] = useState<string | null>(null);
  const [fixedPassword, setFixedPassword] = useState(() => defaultRoomPassword(def.id));
  const overrides = currentOverrides();
  const [relays, setRelays] = useState((overrides.relays ?? []).join('\n'));
  const [snapBase, setSnapBase] = useState(overrides.snapshotBase ?? '');

  // ゲームを切り替えたら、そのゲームの設定を読み直す。保存したものが無ければ初期値に戻す
  useEffect(() => {
    setBans(app.mySettings?.stageBans ?? {});
    setRange(app.mySettings?.rangeChoice ?? null);
    setRematch(app.mySettings?.rematchHours ?? 0);
  }, [app.mySettings, def.id]);

  useEffect(() => {
    setFighter('');
    setFixedPassword(defaultRoomPassword(def.id));
  }, [def.id]);

  const key = fighter ? banGroupKey(def, fighter) : '';
  const current = key ? (bans[key] ?? []) : [];
  const toggle = (stage: StageId) => {
    const next = current.includes(stage) ? current.filter((s) => s !== stage) : [...current, stage];
    const updated = { ...bans, [key]: next };
    if (next.length === 0) delete updated[key];
    setBans(updated);
  };
  const errors = useStageBanErrors(def, bans);
  const passwordError = fixedPassword !== '' && !validRoomPassword(def, fixedPassword);

  const save = async () => {
    if (!app.signer) return;
    setMessage(null);
    try {
      const ev = await app.signer.signEvent(buildSettings(def.id, { stageBans: bans, rangeChoice: range, rematchHours: rematch }, app.now()));
      await app.relay.publish(ev);
      await app.store.put([ev]);
      const parsed = parseSettings(def.id, ev, app.pubkey);
      if (parsed) app.setMySettings(parsed);
      saveDefaultRoomPassword(def.id, fixedPassword);
      setMessage(t.saved);
    } catch {
      setMessage(t.saveFailed);
    }
  };

  // 拒否ステージは、ステージとキャラのあるゲームだけ（docs/adr/0010）
  const { stages, characters } = def;
  const fighterName = (id: string) => {
    const f = characters?.list.find((x) => x.id === id);
    return f ? text(f.name) : id;
  };
  const stageName = (id: string) => {
    const s = stages?.all.find((x) => x.id === id);
    return s ? text(s.name) : id;
  };

  const banCount = Object.keys(bans).length;

  return (
    <section>
      <div className="card">
        <h2>{t.matchSettings}</h2>
        {stages && characters && (
          <div className="stack">
            <h3>{t.stageBans}</h3>
            <p className="hint">{t.stageBansHint(stages.maxBansPerFighter)}</p>
            <div className="field">
              <label htmlFor="ban-fighter">{t.opponentFighter}</label>
              <select id="ban-fighter" value={fighter} onChange={(e) => setFighter(e.target.value)}>
                <option value="">{t.choose}</option>
                {characters.list.map((f) => (
                  <option key={f.id} value={f.id}>{text(f.name)}</option>
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
              <summary>{t.savedBans(banCount)}</summary>
              {banCount === 0 ? (
                <p className="muted">{t.none}</p>
              ) : (
                <table>
                  <tbody>
                    {Object.entries(bans).map(([f, ss]) => (
                      <tr key={f}>
                        <td>{[f, ...(characters.sharedBanGroups.find((g) => g[0] === f)?.slice(1) ?? [])].map(fighterName).join(t.fighterSep)}</td>
                        <td>{ss.map(stageName).join(t.stageSep)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </details>
          </div>
        )}
        <div className="field">
          <label htmlFor="range">{t.range}</label>
          <select id="range" value={range === null ? '' : String(range)} onChange={(e) => setRange(e.target.value === '' ? null : Number(e.target.value))}>
            {def.matching.rangeChoices.map((c) => (
              <option key={String(c)} value={c === null ? '' : String(c)}>{rangeLabel(c)}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rematch">{t.rematch}</label>
          <select id="rematch" value={String(rematch)} onChange={(e) => setRematch(Number(e.target.value))}>
            {def.matching.rematchHourChoices.map((h) => (
              <option key={h} value={String(h)}>{h === 0 ? t.rematchAllowed : t.rematchHours(h)}</option>
            ))}
          </select>
        </div>
        {def.room.kind === 'code' && (
          <div className="field">
            <label htmlFor="fixed-password">{t.defaultPassword}</label>
            <input
              id="fixed-password"
              inputMode="numeric"
              autoComplete="off"
              value={fixedPassword}
              maxLength={def.room.password.maxDigits}
              onChange={(e) => setFixedPassword(e.target.value.replace(/[^0-9]/g, ''))}
            />
            <p className="hint" data-testid="password-hint">
              {t.passwordHint(def.room.password.generatedDigits)}
            </p>
            <p className="slot error" data-testid="password-error">
              {passwordError ? t.passwordError(def.room.password.minDigits, def.room.password.maxDigits) : ''}
            </p>
          </div>
        )}
        <button type="button" className="primary wide" disabled={errors.length > 0 || passwordError || !app.signer} onClick={() => void save()}>
          {t.save}
        </button>
        <p className="slot" role="status">{message ?? ''}</p>
      </div>

      <div className="card">
        <h2>{t.devices}</h2>
        <Devices />
        <p className="hint">
          {t.recoveryHint}
          {recoveryLink() && (
            <>
              {' '}
              <a href={recoveryLink()!} target="_blank" rel="noopener noreferrer">
                {t.getRecoveryTool}
              </a>
            </>
          )}
        </p>
      </div>

      <details className="card">
        <summary>{t.advanced}</summary>
        <div className="stack">
          <p className="hint">{t.advancedHint}</p>
          <div className="field">
            <label htmlFor="relays">{t.relays}</label>
            <textarea id="relays" rows={4} value={relays} onChange={(e) => setRelays(e.target.value)} />
            <p className="hint">{t.relaysHint}</p>
          </div>
          <div className="field">
            <label htmlFor="snap-base">{t.snapshotBase}</label>
            <input id="snap-base" value={snapBase} onChange={(e) => setSnapBase(e.target.value)} />
            <p className="hint">{t.snapshotBaseHint}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              const list = relays.split('\n').map((s) => s.trim()).filter(Boolean);
              saveOverrides({ relays: list.length ? list : undefined, snapshotBase: snapBase.trim() || undefined });
              setOverrideMessage(t.overridesSaved);
            }}
          >
            {t.saveOverrides}
          </button>
          <p className="slot" role="status">{overrideMessage ?? ''}</p>
        </div>
      </details>
    </section>
  );
}
