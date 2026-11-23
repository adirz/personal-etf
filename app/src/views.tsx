import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { parseSymbols } from '../../src/core/symbols';
import { api, fmtMoney, label, num, pct, type BulkResult, type ImportPreview, type ImportResult, type TradesPreview, type TradesResult, type LinkReview, type ClassificationReview, type Data, type RebalanceResult, type Report, type Tx, type Instrument, type ExposureSpec } from './api';
import { Bullet, HBars, Heatmap, LineChart, RiskBars } from './charts';
import { specFromSimple, type SimpleClassification } from '../../src/core/classification';
import { ALL_PROFILES, EQUITY_TILTS, profileRules, shareToMove, type EquityTilt } from '../../src/core/profiles';
import { bandPP, setWeight } from '../../src/core/targets';
import type { TargetRule, Targets as TargetsData } from '../../src/core/types';

type Ctx = { data: Data; report: Report; reload: () => Promise<void> };
const money = (r: Report) => (v: number, compact = false) => fmtMoney(v, r.base, compact);

function Sheet({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  return (
    <div className="sheet-bg" onClick={e => { e.stopPropagation(); close(); }}><div className="sheet stack" onClick={e => e.stopPropagation()}>
      <div className="row between"><h3 style={{ margin: 0 }}>{title}</h3><button className="icon-btn" aria-label="Close" onClick={close}>✕</button></div>
      {children}
    </div></div>
  );
}

// ───────────────────────── Overview ─────────────────────────
export function Overview({ report: r }: Ctx) {
  const m = money(r);
  const dims = Object.keys(r.breakdowns);
  const [dim, setDim] = useState('assetClass');
  const a = r.analytics;
  const bd = Object.entries(r.breakdowns[dim] ?? {}).filter(([, v]) => Math.abs(v) > 0.5).sort((x, y) => y[1] - x[1]);
  const weights = r.holdings.filter(h => h.inTargets && (h.kind === 'security' || h.kind === 'crypto'));
  const wTot = weights.reduce((s, h) => s + h.value, 0);
  const byInst: Record<string, number> = {};
  for (const h of weights) byInst[h.instrument] = (byInst[h.instrument] ?? 0) + h.value / (wTot || 1);
  const riskRows = Object.entries(a?.riskContribution ?? {}).map(([id, risk]) => ({ id, risk, weight: byInst[id] ?? 0 })).sort((x, y) => y.risk - x.risk);
  return (
    <>
      <div className="card hero">
        <div className="muted small">Net worth · {r.asOf}</div>
        <div className="n">{m(r.netWorth)}</div>
        <div className="sub">
          <span>Investable {m(r.investable, true)}</span>
          {r.debt !== 0 && <span>Debt {m(r.debt, true)}</span>}
          <span>Exception sleeve {pct(r.sleeve.actual / 100)} / {r.sleeve.target}%</span>
          <span>Deferred tax ≈ {m(r.deferredTax, true)}</span>
        </div>
      </div>
      {a && <div className="card">
        <h2>Performance & risk</h2>
        <div className="kpis">
          {([['TWR', pct(a.twr)], ['XIRR', pct(a.xirr)], ['CAGR', pct(a.cagr)], ['Volatility', pct(a.vol)],
            ['Sharpe', num(a.sharpe)], ['Sortino', num(a.sortino)], ['Max drawdown', pct(a.maxDrawdown)], ['Beta', num(a.beta)]] as const)
            .map(([l, v]) => <div className="kpi" key={l}><div className="l">{l}</div><div className="v">{v}</div></div>)}
        </div>
        <div style={{ marginTop: 14 }}><LineChart points={a.series} fmt={v => m(v)} /></div>
      </div>}
      <div className="card">
        <h2>Breakdown (investable)</h2>
        <div className="chips" style={{ marginBottom: 12 }}>{dims.map(d => <button key={d} className={`chip ${d === dim ? 'on' : ''}`} onClick={() => setDim(d)}>{label(d)}</button>)}</div>
        <HBars data={bd} total={r.investable || 1} fmt={v => m(v, true)} />
      </div>
      {riskRows.length > 0 && <div className="card">
        <h2>Where the risk comes from</h2>
        <RiskBars rows={riskRows} />
        <div className="small muted" style={{ marginTop: 8 }}>Ex-ante volatility of priced holdings: {pct(a?.exAnteVol)}{a?.unpricedForRisk.length ? ` · no history: ${a.unpricedForRisk.join(', ')}` : ''}</div>
      </div>}
      {(a?.correlation.ids.length ?? 0) > 1 && <div className="card"><h2>Correlation (1y daily, base ccy)</h2><Heatmap ids={a!.correlation.ids} m={a!.correlation.m} /></div>}
      {(r.warnings.length > 0 || r.targetErrors.length > 0) && <div className="card stack">{[...r.targetErrors, ...r.warnings].map((w, i) => <div key={i} className="warnbox">{w}</div>)}</div>}
    </>
  );
}

// ───────────────────────── Targets / drift ─────────────────────────
export function Targets({ data, report: r, reload }: Ctx) {
  const [editing, setEditing] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [draft, setDraft] = useState<TargetsData | null>(null);
  const [held, setHeld] = useState<Set<string>>(new Set());
  const [saveMsg, setSaveMsg] = useState('');
  const latest = useRef<TargetsData | null>(null);
  const grabbed = useRef<Record<string, number>>({});
  const original = useRef<TargetsData | null>(null);
  const saves = useRef<Promise<void>>(Promise.resolve());
  const m = money(r);
  if (editing) return <TargetsEditor data={data} done={async () => { setEditing(false); await reload(); }} />;

  const apply = (next: TargetsData | null) => { latest.current = next; setDraft(next); };
  const persist = (next: TargetsData) => {
    setSaveMsg('Saving…');
    saves.current = saves.current
      .then(async () => { await api.put('targets', next); await reload(); setSaveMsg('Saved'); })
      .catch(e => setSaveMsg(`Could not save: ${(e as Error).message}`));
  };
  const unlock = () => { const c = structuredClone(data.targets); original.current = structuredClone(c); apply(c); setSaveMsg(''); };
  const lock = () => { apply(null); setHeld(new Set()); setSaveMsg(''); };
  const undo = () => { const c = structuredClone(original.current!); apply(c); persist(c); };
  const changed = !!draft && JSON.stringify(draft) !== JSON.stringify(original.current);
  const commit = () => { if (latest.current) persist(latest.current); };
  const moveWeight = (ruleId: string, key: string, v: number) => {
    const cur = latest.current!;
    const keep = [...held].filter(h => h.startsWith(`${ruleId}|`)).map(h => h.slice(ruleId.length + 1));
    apply({ ...cur, rules: cur.rules.map(x => (x.id === ruleId ? { ...x, weights: setWeight(grabbed.current, key, v, keep) } : x)) });
  };
  const toggleHold = (k: string) => setHeld(s => { const n = new Set(s); if (!n.delete(k)) n.add(k); return n; });

  const sleeveTarget = draft ? draft.excludedPct ?? 0 : r.sleeve.target;
  const sleeveBand = bandPP(sleeveTarget, (draft ?? data.targets).defaultBand);
  const sleeveOut = Math.abs(r.sleeve.actual - sleeveTarget) > sleeveBand;
  const rowView = (d: Report['drift'][number], x: Report['drift'][number]['rows'][number]) => {
    const rule = draft?.rules.find(y => y.id === d.rule.id);
    const target = rule ? rule.weights[x.value] ?? 0 : x.target;
    const band = rule ? bandPP(target, rule.band ?? draft!.defaultBand) : x.band;
    return { target, band, out: Math.abs(x.actual - target) > band + 1e-9, dev: ((x.actual - target) / 100) * d.scopeValue, rule };
  };
  const outCount = r.drift.reduce((s, d) => s + d.rows.filter(x => rowView(d, x).out && x.value !== 'unclassified').length, 0);
  return (
    <>
      <div className="row between" style={{ marginBottom: 10 }}>
        <span className={`status ${outCount ? 'out' : 'ok'}`}>{outCount ? `⚠ ${outCount} out of band` : '✓ All within bands'}</span>
        <div className="row">
          {draft
            ? <>{changed && <button className="btn ghost" onClick={undo}>Undo</button>}<button className="btn" onClick={lock}>Done</button></>
            : <><button className="btn ghost" onClick={unlock}>Unlock to drag</button><button className="btn ghost" onClick={() => setEditing(true)}>Edit</button></>}
        </div>
      </div>
      <ClassifyPrompt data={data} report={r} reload={reload} />
      {!draft && <button className="btn block" style={{ marginBottom: 12 }} onClick={() => setChoosing(true)}>Choose a portfolio profile</button>}
      {choosing && <ProfilePicker data={data} report={r} reload={reload} close={() => setChoosing(false)} />}
      {draft && <div className="warnbox" style={{ marginBottom: 12 }}>Drag a round handle to set a target. The others in that group adjust to keep 100%, and changes save automatically. Use <b>Hold</b> to keep a value fixed. {saveMsg && <b>{saveMsg}</b>}</div>}
      {(sleeveTarget > 0 || draft) && <div className="card">
        <div className="row between"><h3>Exception sleeve</h3><span className={`status ${sleeveOut ? 'out' : 'ok'}`}>{sleeveOut ? '⚠ Out' : '✓ OK'}</span></div>
        <Bullet actual={r.sleeve.actual} target={sleeveTarget} band={sleeveBand} out={sleeveOut}
          drag={draft ? { name: 'Exception sleeve', onStart: () => {}, onMove: v => apply({ ...latest.current!, excludedPct: Math.max(0, Math.min(100, Math.round(v * 2) / 2)) }), onEnd: commit } : undefined} />
        <div className="small ink2 num" style={{ marginTop: 4 }}>{r.sleeve.actual.toFixed(1)}% vs {sleeveTarget}% · {m(r.sleeve.value, true)} · not traded by the rebalancer</div>
      </div>}
      {r.drift.map(d => (
        <div className="card" key={d.rule.id}>
          <div className="row between" style={{ marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>{scopeLabel(d.rule.scope)} <span className="muted">by</span> {label(d.rule.dimension)}</h3>
            <span className="small muted num">{m(d.scopeValue, true)}</span>
          </div>
          <div className="stack">
            {d.rows.map((x, _i, all) => {
              const v = rowView(d, x);
              const holdKey = `${d.rule.id}|${x.value}`;
              const isHeld = held.has(holdKey);
              const canEdit = !!draft && x.value !== 'unclassified';
              const othersFree = !!v.rule && Object.keys(v.rule.weights).some(k => k !== x.value && !held.has(`${d.rule.id}|${k}`));
              return (
                <div key={x.value}>
                  <div className="row between small">
                    <span>{label(x.value)} {v.out && x.value !== 'unclassified' && <span className="status out" style={{ marginLeft: 4 }}>⚠</span>}
                      {canEdit && <button className={`chip hold ${isHeld ? 'on' : ''}`} aria-pressed={isHeld} onClick={() => toggleHold(holdKey)}>{isHeld ? 'Held' : 'Hold'}</button>}</span>
                    <span className="num ink2">{x.actual.toFixed(1)}% / {v.target}% <span className="muted" style={{ marginLeft: 6 }}>{v.dev > 0 ? '+' : ''}{m(v.dev, true)}</span></span>
                  </div>
                  <div style={{ marginTop: 4 }}><Bullet actual={x.actual} target={v.target} band={v.band} out={v.out && x.value !== 'unclassified'} max={Math.max(...all.map(y => Math.max(y.actual, y.target + y.band)))}
                    drag={canEdit ? { name: label(x.value), disabled: isHeld || !othersFree, onStart: () => { grabbed.current = { ...latest.current!.rules.find(y => y.id === d.rule.id)!.weights }; }, onMove: p => moveWeight(d.rule.id, x.value, p), onEnd: commit } : undefined} /></div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <div className="small muted">Bar = actual, tick = target, shaded = tolerance band. Percentages are of the scope's value.</div>
    </>
  );
}

const MIX_COLORS: Record<string, string> = { equity: 'var(--s1)', bond: 'var(--s2)', precious_metals: 'var(--cat-gold)', commodity: 'var(--cat-earth)', cash: 'var(--cat-cash)' };
const MIX_LABELS: Record<string, string> = { equity: 'Stocks', bond: 'Bonds', precious_metals: 'Gold', commodity: 'Commodities', cash: 'Cash' };

function ProfilePicker({ data, report: r, reload, close }: { data: Data; report: Report; reload: () => Promise<void>; close: () => void }) {
  const [tilt, setTilt] = useState<EquityTilt>('global');
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [undo, setUndo] = useState<TargetsData | null>(null);
  const [previous, setPrevious] = useState<TargetsData | null>(null);
  useEffect(() => { api.previousTargets().then(x => setPrevious(x.targets)).catch(() => {}); }, [data.targets]);
  const m = money(r);
  const actual = r.breakdowns.assetClass ?? {};
  const previousMix = previous?.rules.find(x => x.dimension === 'assetClass' && !Object.keys(x.scope).length)?.weights;
  const cards = [
    ...(previous ? [{ id: 'previous', name: 'Your previous targets', summary: 'The targets you had before your last profile change.', risk: null, assetClass: previousMix ?? {}, rules: previous.rules }] : []),
    ...ALL_PROFILES.map(p => ({ id: p.id, name: p.name, summary: p.summary, risk: p.risk as number | null, assetClass: p.assetClass, rules: profileRules(p.id, tilt) })),
  ];
  const moves = ALL_PROFILES.map(p => ({ id: p.id, pct: shareToMove(actual, r.investable, p.assetClass) }));
  const closest = moves.reduce((a, b) => (b.pct < a.pct ? b : a)).id;
  const sameRules = (rules: TargetRule[]) => JSON.stringify(rules.map(x => [x.scope, x.dimension, x.weights])) === JSON.stringify(data.targets.rules.map(x => [x.scope, x.dimension, x.weights]));
  const apply = async () => {
    const profile = cards.find(p => p.id === selected);
    if (!profile || !confirm(`Replace your current targets with "${profile.name}"?\n\nThis changes targets only. No trades are made.`)) return;
    setBusy(true); setErr('');
    try { const before = structuredClone(data.targets); await api.applyProfile(selected, tilt); await reload(); setUndo(before); }
    catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  const revert = async () => {
    setBusy(true); setErr('');
    try { await api.put('targets', undo); await reload(); setUndo(null); setSelected(''); }
    catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  return (
    <Sheet title="Choose a portfolio profile" close={close}>
      <div className="small muted">Stock region</div>
      <div className="seg">{(Object.keys(EQUITY_TILTS) as EquityTilt[]).map(k => <button key={k} className={tilt === k ? 'on' : ''} onClick={() => setTilt(k)}>{EQUITY_TILTS[k].label}</button>)}</div>
      <div className="small muted">{EQUITY_TILTS[tilt].detail}: {Object.entries(EQUITY_TILTS[tilt].weights).map(([k, v]) => `${label(k === 'developed_ex_us' ? 'other developed' : k)} ${v}%`).join(' · ')}</div>
      {cards.map(p => {
        const move = p.id === 'previous' ? shareToMove(actual, r.investable, p.assetClass) : moves.find(x => x.id === p.id)!.pct;
        const active = sameRules(p.rules);
        return (
          <button key={p.id} className={`profile ${selected === p.id ? 'on' : ''}`} aria-pressed={selected === p.id} onClick={() => setSelected(p.id)}>
            <div className="row between">
              <b>{p.name}</b>
              <span className="row" style={{ gap: 4 }}>
                {active && <span className="status ok">Current</span>}
                {closest === p.id && !active && <span className="tag">Closest to you</span>}
                {p.risk !== null && <span className="small muted">Risk {p.risk}/5</span>}
              </span>
            </div>
            <div className="small ink2" style={{ marginTop: 2 }}>{p.summary}</div>
            <div className="mix" aria-hidden="true">{Object.entries(p.assetClass).map(([k, v]) => <span key={k} style={{ width: `${v}%`, background: MIX_COLORS[k] }} />)}</div>
            <div className="legend">{Object.entries(p.assetClass).map(([k, v]) => <span key={k}><i style={{ background: MIX_COLORS[k] }} />{MIX_LABELS[k]} {v}%</span>)}</div>
            <div className="small muted" style={{ marginTop: 4 }}>Reaching it means moving about {move.toFixed(0)}% of your portfolio ({m((move / 100) * r.investable, true)})</div>
            {selected === p.id && <div className="stack" style={{ marginTop: 8, borderTop: '1px solid var(--grid)', paddingTop: 8 }}>
              {p.rules.filter(x => Object.keys(x.scope).length > 0).map(x => (
                <div className="small" key={x.id}>
                  <b>{scopeLabel(x.scope)} by {label(x.dimension)}</b>
                  <div className="ink2 num">{Object.entries(x.weights).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k === 'developed_ex_us' ? 'Other developed' : label(k)} ${v}%`).join(' · ')}</div>
                </div>
              ))}
            </div>}
          </button>
        );
      })}
      <div className="small muted">These are generic model allocations, not personal financial advice. Applying one changes your targets only. Your previous targets stay available here.</div>
      {err && <div className="err">{err}</div>}
      {undo
        ? <div className="row"><span className="small ink2" role="status" style={{ flex: 1 }}>Targets updated.</span><button className="btn ghost" disabled={busy} onClick={revert}>Undo</button><button className="btn" onClick={close}>Done</button></div>
        : <button className="btn block" disabled={!selected || busy} onClick={apply}>{selected ? `Use ${cards.find(p => p.id === selected)?.name ?? 'profile'}` : 'Select a profile'}</button>}
    </Sheet>
  );
}

const scopeLabel = (s: Record<string, string | string[]>) => Object.keys(s).length ? Object.values(s).map(v => Array.isArray(v) ? v.map(label).join('/') : label(v)).join(' › ') : 'Portfolio';

function TargetsEditor({ data, done }: { data: Data; done: () => void }) {
  const [t, setT] = useState(() => structuredClone(data.targets));
  const [err, setErr] = useState('');
  const upd = (i: number, f: (r: TargetRule) => void) => setT(x => { const y = structuredClone(x); f(y.rules[i]); return y; });
  const save = async () => {
    for (const r of t.rules) { const s = Object.values(r.weights).reduce((a, b) => a + b, 0); if (Math.abs(s - 100) > 0.01) return setErr(`"${r.id}" sums to ${s}`); }
    try { await api.put('targets', t); done(); } catch (e) { setErr(String(e)); }
  };
  return (
    <div className="stack">
      <button className="btn ghost" onClick={done}>← Back to targets</button>
      <div className="card grid2">
        <label className="f">Default band ± pp<input type="number" value={t.defaultBand.abs ?? ''} onChange={e => setT({ ...t, defaultBand: { ...t.defaultBand, abs: +e.target.value } })} /></label>
        <label className="f">Default band ± relative<input type="number" step="0.05" value={t.defaultBand.rel ?? ''} onChange={e => setT({ ...t, defaultBand: { ...t.defaultBand, rel: +e.target.value } })} /></label>
        <label className="f">Exception sleeve % of total<input type="number" value={t.excludedPct ?? 0} onChange={e => setT({ ...t, excludedPct: +e.target.value })} /></label>
      </div>
      {t.rules.map((r, i) => {
        const sum = Object.values(r.weights).reduce((a, b) => a + b, 0);
        return (
          <div className="card stack" key={i}>
            <div className="grid2">
              <label className="f">Scope (dim=value, …)<input value={Object.entries(r.scope).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`).join(', ')} placeholder="empty = whole portfolio"
                onChange={e => upd(i, x => { x.scope = Object.fromEntries(e.target.value.split(',').map(s => s.trim()).filter(Boolean).map(s => { const [k, v = ''] = s.split('='); return [k.trim(), v.includes('|') ? v.split('|').map(z => z.trim()) : v.trim()]; })); })} /></label>
              <label className="f">Split by dimension<input value={r.dimension} list="dims" onChange={e => upd(i, x => { x.dimension = e.target.value; })} /></label>
            </div>
            {Object.entries(r.weights).map(([k, w]) => (
              <div className="row" key={k}>
                <input value={k} onChange={e => upd(i, x => { const v = x.weights[k]; delete x.weights[k]; x.weights[e.target.value] = v; })} />
                <input type="number" style={{ width: 90 }} value={w} onChange={e => upd(i, x => { x.weights[k] = +e.target.value; })} />
                <button className="icon-btn" onClick={() => upd(i, x => { delete x.weights[k]; })}>✕</button>
              </div>
            ))}
            <div className="row between">
              <button className="btn ghost" onClick={() => upd(i, x => { x.weights[`new${Object.keys(x.weights).length}`] = 0; })}>+ value</button>
              <span className={`small num ${Math.abs(sum - 100) > 0.01 ? 'down' : 'muted'}`}>Σ {sum}%</span>
              <button className="btn danger" onClick={() => setT(x => ({ ...x, rules: x.rules.filter((_, j) => j !== i) }))}>Remove rule</button>
            </div>
          </div>
        );
      })}
      <datalist id="dims">{['assetClass', 'region', 'sector', 'credit', 'bondType', 'currency'].map(d => <option key={d} value={d} />)}</datalist>
      <button className="btn ghost block" onClick={() => setT(x => ({ ...x, rules: [...x.rules, { id: `rule-${Date.now()}`, scope: {}, dimension: 'region', weights: {} }] }))}>+ Add rule</button>
      {err && <div className="err">{err}</div>}
      <div className="row"><button className="btn ghost" onClick={done}>Cancel</button><button className="btn" style={{ flex: 1 }} onClick={save}>Save targets</button></div>
      <div className="small muted">Values used by auto-classification — assetClass: equity, bond, cash, commodity, precious_metals, crypto, debt · region: US, Israel, developed_ex_us, emerging · credit: government, AAA…below_B · bondType: government, corporate · sector: technology, financial_services, healthcare, real_estate, …</div>
    </div>
  );
}

// ───────────────────────── Rebalance ─────────────────────────
export function Rebalance({ data, report: r, reload }: Ctx) {
  const m = money(r);
  const [mode, setMode] = useState<'cashflow' | 'full'>('cashflow');
  const [contrib, setContrib] = useState<Record<string, string>>({});
  const [res, setRes] = useState<RebalanceResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const run = async () => {
    setBusy(true); setErr('');
    try {
      const c = Object.fromEntries(Object.entries(contrib).filter(([, v]) => +v).map(([k, v]) => [k, +v]));
      setRes(await api.rebalance({ mode, contributions: c }));
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };
  const record = async () => {
    if (!res) return;
    const date = new Date().toISOString().slice(0, 10);
    const txs: Partial<Tx>[] = [];
    for (const [a, v] of Object.entries(contrib)) if (+v > 0) txs.push({ date, type: 'deposit', account: a, amount: +v, currency: r.base });
    for (const o of res.orders) txs.push({ date, type: o.side, account: o.account, instrument: o.instrument, qty: o.units, price: o.price, fees: (o.fee / o.value) * o.units * o.price, lots: o.lots?.map(l => l.id) });
    await api.addTx(txs); setRes(null); await reload();
  };
  return (
    <>
      <div className="card stack">
        <div className="seg">
          <button className={mode === 'cashflow' ? 'on' : ''} onClick={() => setMode('cashflow')}>Buy only</button>
          <button className={mode === 'full' ? 'on' : ''} onClick={() => setMode('full')}>Buy & sell (tax-aware)</button>
        </div>
        <div className="small muted">{mode === 'cashflow' ? 'Invests new money and idle cash toward targets. No sales, no tax.' : 'May sell — prefers tax-exempt accounts and low-gain lots, and only trades when something is outside its band.'}</div>
        <div className="small ink2">New money ({r.base})</div>
        {data.accounts.map(a => (
          <label className="f" key={a.id}>{a.name} <span className="muted">· {a.taxStatus}</span>
            <input inputMode="decimal" value={contrib[a.id] ?? ''} placeholder="0" onChange={e => setContrib({ ...contrib, [a.id]: e.target.value })} /></label>
        ))}
        <button className="btn block" disabled={busy} onClick={run}>{busy ? 'Solving…' : 'Calculate trades'}</button>
        {err && <div className="err">{err}</div>}
      </div>
      {res && <>
        <div className="card">
          <div className="row between"><h2 style={{ margin: 0 }}>Orders</h2><span className="small muted">{res.status}</span></div>
          {res.orders.length === 0 && <div className="muted" style={{ marginTop: 8 }}>Nothing to do — within bands, or nothing worth the cost.</div>}
          <div className="list">
            {res.orders.map((o, i) => (
              <div className="item" key={i}>
                <div className="row between">
                  <span className="row"><span className={`side ${o.side}`}>{o.side.toUpperCase()}</span><b>{o.instrument}</b><span className="tag">{data.accounts.find(a => a.id === o.account)?.name ?? o.account}</span></span>
                  <b className="num">{m(o.value)}</b>
                </div>
                <div className="small ink2 num" style={{ marginTop: 3 }}>
                  {+o.units.toFixed(6)} × {o.price.toFixed(2)} {o.ccy} · fee {m(o.fee)}{o.side === 'sell' && <> · gain {m(o.gain)} · tax {m(o.tax)}</>}
                </div>
                {o.lots && o.lots.length > 0 && <div className="small muted">Lots: {o.lots.map(l => `${l.id} (${+l.units.toFixed(4)})`).join(', ')}</div>}
              </div>
            ))}
          </div>
          <table className="t" style={{ marginTop: 10 }}><tbody>
            <tr><td>Buys</td><td>{m(res.totals.buy)}</td></tr><tr><td>Sells</td><td>{m(res.totals.sell)}</td></tr>
            <tr><td>Fees</td><td>{m(res.totals.fees)}</td></tr><tr><td>Est. tax</td><td>{m(res.totals.tax)}</td></tr>
            {Object.entries(res.totals.cashLeft).map(([a, v]) => <tr key={a}><td>Cash left · {a}</td><td>{m(v)}</td></tr>)}
          </tbody></table>
          {res.notes.length > 0 && <div className="small muted" style={{ marginTop: 6 }}>{res.notes.join(' · ')}</div>}
        </div>
        <div className="card">
          <h2>Worst out-of-band, before → after</h2>
          <table className="t"><thead><tr><th>Rule</th><th>Before</th><th>After</th></tr></thead><tbody>
            {res.before.map((b, i) => <tr key={b.rule.id}><td>{scopeLabel(b.rule.scope)} › {label(b.rule.dimension)}</td><td>{b.maxOut.toFixed(1)}pp</td><td className={res.after[i].maxOut < b.maxOut ? 'up' : ''}>{res.after[i].maxOut.toFixed(1)}pp</td></tr>)}
          </tbody></table>
        </div>
        {res.orders.length > 0 && <button className="btn ghost block" onClick={record}>Record as executed (at these prices)</button>}
      </>}
    </>
  );
}

// ───────────────────────── Holdings ─────────────────────────
export function Holdings({ data, report: r, reload }: Ctx) {
  const m = money(r);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importingTrades, setImportingTrades] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const unlinked = r.holdings.filter(h => h.kind === 'manual' && /^\d+$/.test(h.instrument)).length;
  const groups = useMemo(() => {
    const g: Record<string, Report['holdings']> = {};
    for (const h of r.holdings) (g[h.account] ??= []).push(h);
    for (const k in g) g[k].sort((a, b) => b.value - a.value);
    return g;
  }, [r]);
  return (
    <>
      {unlinked > 0 && <div className="warnbox row between" style={{ marginBottom: 12 }}>
        <span>{unlinked} holding{unlinked === 1 ? ' has' : 's have'} no live price.</span>
        <button className="btn" style={{ whiteSpace: 'nowrap' }} onClick={() => setReviewing(true)}>Review tickers</button>
      </div>}
      {reviewing && <LinkReviewSheet reload={reload} close={() => setReviewing(false)} />}
      <ClassifyPrompt data={data} report={r} reload={reload} />
      <button className="btn block" style={{ marginBottom: 8 }} onClick={() => setAdding(true)}>+ Add holding</button>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn ghost" style={{ flex: 1 }} onClick={() => setImportingTrades(true)}>Import trade history</button>
        <button className="btn ghost" style={{ flex: 1 }} onClick={() => setImporting(true)}>Import broker file</button>
      </div>
      {adding && <AddHolding data={data} report={r} reload={reload} close={() => setAdding(false)} />}
      {importing && <BrokerImport data={data} report={r} reload={reload} close={() => setImporting(false)} />}
      {importingTrades && <TradesImport data={data} reload={reload} close={() => setImportingTrades(false)} next={() => { setImportingTrades(false); setImporting(true); }} />}
      {Object.entries(groups).map(([acct, hs]) => (
        <div className="card" key={acct}>
          <div className="row between"><h2 style={{ margin: 0 }}>{data.accounts.find(a => a.id === acct)?.name ?? acct}</h2><span className="num small ink2">{m(hs.reduce((s, h) => s + h.value, 0), true)}</span></div>
          <div className="list">
            {hs.map(h => (
              <div className="item" key={h.key} onClick={() => setOpen(open === h.key ? null : h.key)} style={{ cursor: 'pointer' }}>
                <div className="row between">
                  <div><b dir="auto">{hasTicker(h) ? h.instrument : h.name}</b> {h.excluded && <span className="tag">sleeve</span>}
                    {hasTicker(h) && h.name !== h.instrument && <div className="small ink2" dir="auto">{h.name}</div>} {h.kind === 'debt' && <span className="tag">debt</span>}
                    <div className="small muted num">{h.kind === 'cash' || h.kind === 'debt' ? h.ccy : `${+h.qty.toFixed(6)} × ${h.price.toFixed(2)} ${h.ccy}`}</div></div>
                  <div style={{ textAlign: 'right' }}><div className="num"><b>{m(h.value)}</b></div>
                    {h.unrealizedBase !== undefined && <div className={`small num ${h.unrealizedBase >= 0 ? 'up' : 'down'}`}>{h.unrealizedBase >= 0 ? '+' : ''}{m(h.unrealizedBase)}</div>}</div>
                </div>
                {open === h.key && <HoldingDetail h={h} data={data} reload={reload} m={m} />}
              </div>
            ))}
          </div>
        </div>
      ))}
      {r.holdings.length === 0 && <div className="card muted">No holdings yet. Use Add holding to enter what you own today.</div>}
    </>
  );
}

/** Israeli funds are identified by a security number rather than a ticker, so their name is shown instead. */
const hasTicker = (h: { kind: string; instrument: string }) => (h.kind === 'security' || h.kind === 'crypto') && !/^\d+(\.globes)?$/.test(h.instrument);
const dec = (v: number) => String(+v.toFixed(6));
const NEW_ACCOUNT = '__new';
const readBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(String(fr.result).split(',')[1] ?? '');
  fr.onerror = () => reject(new Error('Could not read the file.'));
  fr.readAsDataURL(file);
});

const CLASS_OPTIONS: [string, string][] = [['equity', 'Stocks'], ['bond', 'Bonds'], ['precious_metals', 'Gold and precious metals'], ['commodity', 'Commodities'], ['cash', 'Cash or money market'], ['crypto', 'Crypto']];
const REGION_OPTIONS: [string, string][] = [['US', 'US'], ['Israel', 'Israel'], ['developed_ex_us', 'Other developed'], ['emerging', 'Emerging markets'], ['global', 'Global']];
const SECTOR_OPTIONS = ['technology', 'financial_services', 'healthcare', 'energy', 'basic_materials', 'industrials', 'consumer_cyclical', 'consumer_defensive', 'communication_services', 'real_estate', 'utilities'];

/** Shown wherever missing classifications would make the numbers misleading. */
function ClassifyPrompt({ data, report, reload }: { data: Data; report: Report; reload: () => Promise<void> }) {
  const [review, setReview] = useState<ClassificationReview | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { let live = true; api.classificationReview().then(x => { if (live) setReview(x); }).catch(() => {}); return () => { live = false; }; }, [report]);
  if (!review?.items.length) return null;
  const total = review.items.reduce((s, i) => s + i.value, 0);
  return (
    <>
      <div className="warnbox row between" style={{ marginBottom: 12 }}>
        <span>{review.items.length} holding{review.items.length === 1 ? '' : 's'} ({fmtMoney(total, report.base, true)}) need{review.items.length === 1 ? 's' : ''} a classification.</span>
        <button className="btn" style={{ whiteSpace: 'nowrap' }} onClick={() => setOpen(true)}>Classify</button>
      </div>
      {open && <ClassifySheet data={data} review={review} base={report.base} reload={reload} close={() => setOpen(false)} />}
    </>
  );
}

function ClassifySheet({ data, review, base, reload, close }: { data: Data; review: ClassificationReview; base: string; reload: () => Promise<void>; close: () => void }) {
  const [forms, setForms] = useState<Record<string, Partial<SimpleClassification>>>(() => Object.fromEntries(review.items.map(i => [i.id, { ...i.current }])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const update = (id: string, patch: Partial<SimpleClassification>) => setForms(f => ({ ...f, [id]: { ...f[id], ...patch } }));
  const complete = (c: Partial<SimpleClassification>) => !!c.assetClass && (!['equity', 'bond'].includes(c.assetClass) || !!c.region);
  const ready = review.items.filter(i => complete(forms[i.id]));
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const chosen = new Map(ready.map(i => [i.id, specFromSimple(forms[i.id] as SimpleClassification)]));
      await api.put('instruments', data.instruments.map(i => (chosen.has(i.id) ? { ...i, exposureOverride: chosen.get(i.id) } : i)));
      await reload();
      close();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  const select = (name: string, title: string, value: string | undefined, options: [string, string][], set: (v: string) => void) => (
    <label className="f">{title}<select aria-label={`${title} for ${name}`} value={value ?? ''} onChange={e => set(e.target.value)}>
      <option value="">Choose…</option>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select></label>
  );
  return (
    <Sheet title="Classify holdings" close={close}>
      <div className="small muted">This tells the app what each holding is, so targets and rebalancing count it correctly. You can change it later in the holding's details.</div>
      {review.waitingForTicker > 0 && <div className="small ink2">{review.waitingForTicker} more will classify automatically once you approve their tickers.</div>}
      <div className="list">
        {review.items.map(i => {
          const c = forms[i.id];
          return (
            <div className="item stack" key={i.id}>
              <div className="row between"><b dir="auto">{i.name}</b><span className="small muted num">{fmtMoney(i.value, base, true)}</span></div>
              <div className="grid2">
                {select(i.name, 'Type', c.assetClass, CLASS_OPTIONS, v => update(i.id, { assetClass: v }))}
                {['equity', 'bond'].includes(c.assetClass ?? '') && select(i.name, 'Region', c.region, REGION_OPTIONS, v => update(i.id, { region: v }))}
                {c.assetClass === 'equity' && select(i.name, 'Sector (optional)', c.sector, SECTOR_OPTIONS.map(s => [s, label(s)]), v => update(i.id, { sector: v || undefined }))}
                {c.assetClass === 'bond' && select(i.name, 'Bond type (optional)', c.bondType, [['government', 'Government'], ['corporate', 'Corporate']], v => update(i.id, { bondType: v || undefined }))}
              </div>
            </div>
          );
        })}
      </div>
      {err && <div className="err">{err}</div>}
      <button className="btn block" disabled={busy || !ready.length} onClick={save}>{busy ? 'Saving…' : `Save ${ready.length} classification${ready.length === 1 ? '' : 's'}`}</button>
    </Sheet>
  );
}

const PRICE_GAP = 0.05;

function LinkReviewSheet({ reload, close }: { reload: () => Promise<void>; close: () => void }) {
  const [review, setReview] = useState<LinkReview | null>(null);
  const [tickers, setTickers] = useState<Record<string, string>>({});
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<{ linked: number; autoBackup: string } | null>(null);
  useEffect(() => {
    api.linkReview().then(x => { setReview(x); setTickers(Object.fromEntries(x.items.map(i => [i.id, i.suggestion?.ticker ?? '']))); }).catch(e => setErr((e as Error).message));
  }, []);
  const gap = (i: LinkReview['items'][number]) => !!i.suggestion && tickers[i.id] === i.suggestion.ticker && i.price !== null && i.suggestion.price !== null && Math.abs(i.suggestion.price / i.price - 1) > PRICE_GAP;
  const toggle = (id: string) => setApproved(s => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n; });
  const approveAll = () => setApproved(new Set(review!.items.filter(i => i.suggestion && tickers[i.id] === i.suggestion.ticker && !gap(i)).map(i => i.id)));
  const ready = [...approved].filter(id => tickers[id]?.trim());
  const apply = async () => {
    setBusy(true); setErr('');
    try { setDone(await api.applyLinks(Object.fromEntries(ready.map(id => [id, tickers[id]])))); await reload(); }
    catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  if (done) return (
    <Sheet title="Tickers linked" close={close}>
      <div className="ink2">{done.linked} holding{done.linked === 1 ? ' now updates' : 's now update'} from live prices. These links are remembered for future imports.</div>
      <div className="small muted">Previous data kept as backups/{done.autoBackup}.</div>
      <button className="btn block" onClick={close}>Done</button>
    </Sheet>
  );
  return (
    <Sheet title="Review tickers" close={close}>
      {!review && !err && <div className="small muted" role="status">Loading…</div>}
      {err && <div className="err">{err}</div>}
      {review && <>
        <div className="small muted">Check each suggestion. Nothing is linked until you tick it, and you only do this once.</div>
        <button className="btn ghost block" onClick={approveAll}>Approve all suggestions with matching prices</button>
        <datalist id="link-options">{review.options.map(o => <option key={o.ticker} value={o.ticker}>{o.name}</option>)}</datalist>
        <div className="list">
          {review.items.map(i => {
            const chosen = tickers[i.id] ?? '';
            const isSuggested = i.suggestion?.ticker === chosen;
            return (
              <div className="item" key={i.id}>
                <div className="row between">
                  <label className="row small" style={{ flex: 1, minWidth: 0 }}>
                    <input type="checkbox" style={{ width: 'auto', flex: 'none' }} aria-label={`Approve ${i.name}`} checked={approved.has(i.id)} disabled={!chosen.trim()} onChange={() => toggle(i.id)} />
                    <b dir="auto">{i.name}</b>
                  </label>
                  <input aria-label={`Ticker for ${i.name}`} list="link-options" style={{ width: 104, padding: '5px 8px', fontSize: 14, flex: 'none' }} placeholder="Ticker" spellCheck={false} autoCapitalize="characters"
                    value={chosen} onChange={e => { const v = e.target.value.toUpperCase(); setTickers({ ...tickers, [i.id]: v }); setApproved(s => { const n = new Set(s); n.delete(i.id); return n; }); }} />
                </div>
                <div className="small muted num" style={{ marginTop: 3 }}>Broker: {i.price?.toFixed(2) ?? '—'} {i.currency}{isSuggested && i.suggestion ? ` · ${i.suggestion.ticker}: ${i.suggestion.price?.toFixed(2) ?? '—'}` : ''}</div>
                {isSuggested && i.suggestion && <div className="small ink2" dir="auto">{i.suggestion.name}</div>}
                {!i.suggestion && <div className="small muted">No confident suggestion. Enter the ticker if you know it.</div>}
                {gap(i) && <div className="warnbox" style={{ marginTop: 4 }}>Prices differ by more than {PRICE_GAP * 100}%. Check this one before approving.</div>}
              </div>
            );
          })}
        </div>
        <button className="btn block" disabled={busy || !ready.length} onClick={apply}>{busy ? 'Linking and fetching prices…' : `Link ${ready.length} holding${ready.length === 1 ? '' : 's'}`}</button>
      </>}
    </Sheet>
  );
}

function TradesImport({ data, reload, close, next }: { data: Data; reload: () => Promise<void>; close: () => void; next: () => void }) {
  const [file, setFile] = useState('');
  const [preview, setPreview] = useState<TradesPreview | null>(null);
  const [account, setAccount] = useState(data.accounts.find(a => a.currency !== 'ILS')?.id ?? NEW_ACCOUNT);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [result, setResult] = useState<TradesResult | null>(null);
  const choose = async (f: File) => {
    setBusy('Reading the file…'); setErr('');
    try { const b64 = await readBase64(f); setPreview(await api.tradesPreview(b64)); setFile(b64); }
    catch (e) { setErr((e as Error).message); }
    setBusy('');
  };
  const apply = async () => {
    setBusy('Importing and fetching price history…'); setErr('');
    try { setResult(await api.tradesApply(file, account)); await reload(); }
    catch (e) { setErr((e as Error).message); }
    setBusy('');
  };
  if (result) return (
    <Sheet title="Trade history imported" close={close}>
      <table className="t"><tbody>
        <tr><td>Ledger entries</td><td>{result.transactions}</td></tr>
        <tr><td>Instruments added</td><td>{result.instrumentsAdded}</td></tr>
        <tr><td>Held before the file starts</td><td>{result.openings}</td></tr>
        {result.endingCash !== null && <tr><td>Cash balance</td><td>{fmtMoney(result.endingCash, result.baseCurrency)}</td></tr>}
      </tbody></table>
      <div className="warnbox"><b>Your holdings aren't complete yet.</b> This file only covers {preview?.from} to {preview?.to}, so anything bought earlier is missing or understated. Import the broker holdings file next.</div>
      {result.unavailable.length > 0 && <div className="warnbox">No market data found for: {result.unavailable.join(', ')}.</div>}
      <div className="small muted">Previous data kept as backups/{result.autoBackup}.</div>
      <button className="btn block" onClick={next}>Next: import holdings file</button>
      <button className="btn ghost block" onClick={close}>Close</button>
    </Sheet>
  );
  return (
    <Sheet title="Import trade history" close={close}>
      {!preview && <>
        <div className="small muted">Choose the Interactive Brokers transaction history CSV. Import it before the holdings file, so its tickers can identify your holdings.</div>
        <label className="btn block" style={{ textAlign: 'center', opacity: busy ? .5 : 1, pointerEvents: busy ? 'none' : undefined }}>Choose CSV file
          <input type="file" accept=".csv,text/csv" aria-label="Trade history file" style={{ display: 'none' }} disabled={!!busy} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) choose(f); }} />
        </label>
      </>}
      {busy && <div className="small ink2" role="status">{busy}</div>}
      {err && <div className="err">{err}</div>}
      {preview && <>
        <div className="small ink2">{preview.from} to {preview.to}</div>
        <table className="t"><tbody>
          <tr><td>Buys and sells</td><td>{preview.trades}</td></tr>
          <tr><td>Dividends</td><td>{preview.dividends}</td></tr>
          <tr><td>Dividend tax</td><td>{preview.taxes}</td></tr>
          <tr><td>Interest</td><td>{preview.interest}</td></tr>
          <tr><td>Deposits and withdrawals</td><td>{preview.deposits}</td></tr>
          {preview.endingCash !== null && <tr><td>Ending cash</td><td>{fmtMoney(preview.endingCash, preview.baseCurrency)}</td></tr>}
        </tbody></table>
        <div className="small muted">{preview.tickers.length} tickers: {preview.tickers.join(', ')}</div>
        {preview.warnings.map(w => <div className="warnbox" key={w}>{w}</div>)}
        <label className="f">Import into<select value={account} onChange={e => setAccount(e.target.value)}>
          {data.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          <option value={NEW_ACCOUNT}>+ New account</option>
        </select></label>
        <button className="btn block" disabled={!!busy} onClick={apply}>{busy ? 'Working…' : 'Import trade history'}</button>
      </>}
    </Sheet>
  );
}

function BrokerImport({ data, report, reload, close }: { data: Data; report: Report; reload: () => Promise<void>; close: () => void }) {
  const [file, setFile] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [symbols, setSymbols] = useState<Record<string, string>>({});
  const [foreign, setForeign] = useState(data.accounts.find(a => a.currency !== 'ILS')?.id ?? NEW_ACCOUNT);
  const [local, setLocal] = useState(data.accounts.find(a => a.currency === 'ILS')?.id ?? NEW_ACCOUNT);
  const [removeMissing, setRemoveMissing] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const ils = (v: number) => fmtMoney(v, 'ILS');

  const choose = async (f: File) => {
    setBusy('Reading the file and matching tickers…'); setErr(''); setPreview(null);
    try {
      const b64 = await readBase64(f);
      const p = await api.importPreview(b64);
      setFile(b64); setPreview(p);
      setSymbols(Object.fromEntries(p.rows.map(x => [x.id, x.symbol ?? ''])));
    } catch (e) { setErr((e as Error).message); }
    setBusy('');
  };
  const apply = async () => {
    setBusy('Importing and fetching price history…'); setErr('');
    try {
      const chosen = Object.fromEntries(Object.entries(symbols).map(([k, v]) => [k, v.trim() || 'manual']));
      setResult(await api.importApply({ file, symbols: chosen, accounts: { foreign, local }, removeMissing }));
      await reload();
    } catch (e) { setErr((e as Error).message); }
    setBusy('');
  };
  const statusOf = (x: ImportPreview['rows'][number]) => {
    const h = report.holdings.find(y => y.account === (x.listedInIls ? local : foreign) && y.instrument === x.instrumentId);
    if (!h) return 'New';
    const q = h.lots.reduce((s, l) => s + l.qty, 0);
    const cost = q ? h.lots.reduce((s, l) => s + l.qty * l.cost, 0) / q : 0;
    return Math.abs(h.qty - x.qty) < 1e-6 && Math.abs(cost / x.cost - 1) < 0.001 ? 'Same' : 'Update';
  };
  const accountSelect = (title: string, value: string, set: (v: string) => void) => (
    <label className="f">{title}<select value={value} onChange={e => set(e.target.value)}>
      {data.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      <option value={NEW_ACCOUNT}>+ New account</option>
    </select></label>
  );

  if (result) return (
    <Sheet title="Import complete" close={close}>
      <table className="t"><tbody>
        <tr><td>New holdings</td><td>{result.created}</td></tr>
        <tr><td>Updated</td><td>{result.updated}</td></tr>
        <tr><td>Unchanged</td><td>{result.unchanged}</td></tr>
        {result.removed > 0 && <tr><td>Removed</td><td>{result.removed}</td></tr>}
        <tr><td>Instruments added</td><td>{result.instrumentsAdded}</td></tr>
        <tr><td>Without live prices</td><td>{result.manual}</td></tr>
      </tbody></table>
      {result.manual > 0 && <div className="small muted">Holdings without live prices keep the broker's price until your next import.</div>}
      {result.priceNotices.map(n => <div className="warnbox" key={n}>{n}</div>)}
      <div className="small muted">Previous data kept as backups/{result.autoBackup}.</div>
      <button className="btn block" onClick={close}>Done</button>
    </Sheet>
  );

  const missing = preview?.rows.filter(x => !symbols[x.id]?.trim()).length ?? 0;
  return (
    <Sheet title="Import broker file" close={close}>
      {!preview && <>
        <div className="small muted">Choose the Excel holdings export from your broker. You'll see a preview before anything changes.</div>
        <label className="btn block" style={{ textAlign: 'center', opacity: busy ? .5 : 1, pointerEvents: busy ? 'none' : undefined }}>Choose Excel file
          <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="Broker file" style={{ display: 'none' }} disabled={!!busy}
            onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) choose(f); }} />
        </label>
      </>}
      {busy && <div className="small ink2" role="status">{busy}</div>}
      {err && <div className="err">{err}</div>}
      {preview && <>
        <div className="small ink2">{preview.rows.length} holdings · {ils(preview.totalIls)}{preview.asOf ? ` · as of ${preview.asOf}` : ''}</div>
        {preview.unlistedIls !== undefined && <div className="warnbox">The broker's percentages imply about <b>{ils(preview.unlistedIls)}</b> that isn't listed in this file, such as cash or a negative balance. It won't be imported. Add it in Holdings if it's real.</div>}
        {preview.warnings.map(w => <div className="warnbox" key={w}>{w}</div>)}
        <div className="grid2">
          {accountSelect('Foreign holdings go to', foreign, setForeign)}
          {accountSelect('Israeli holdings go to', local, setLocal)}
        </div>
        {missing > 0 && <div className="warnbox">{missing} couldn't be identified from the file. Choose each ticker once and it's remembered for future imports, or leave it empty to keep the broker's price.</div>}
        <datalist id="known-tickers">{preview.knownTickers.map(t => <option key={t} value={t} />)}</datalist>
        <div className="list">
          {preview.rows.map(x => (
            <div className="item" key={x.id}>
              <div className="row between">
                <b className="small" dir="auto">{x.name}</b>
                <span className="tag">{statusOf(x)}</span>
              </div>
              <div className="row between" style={{ marginTop: 4 }}>
                <span className="small muted num">{+x.qty.toFixed(4)} × {x.price.toFixed(2)} · cost {x.cost.toFixed(2)} · {ils(x.valueIls)}</span>
                <input aria-label={`Ticker for ${x.name}`} style={{ width: 112, padding: '5px 8px', fontSize: 14, flex: 'none' }} placeholder="No ticker" list="known-tickers" spellCheck={false} autoCapitalize="characters" disabled={x.via === 'globes'}
                  value={x.via === 'globes' ? `TASE ${x.id}` : symbols[x.id] ?? ''} onChange={e => setSymbols({ ...symbols, [x.id]: e.target.value.toUpperCase() })} />
              </div>
            </div>
          ))}
        </div>
        <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={removeMissing} onChange={e => setRemoveMissing(e.target.checked)} /> Remove holdings in these accounts that aren't in this file</label>
        <button className="btn block" disabled={!!busy} onClick={apply}>{busy ? 'Working…' : `Import ${preview.rows.length} holdings`}</button>
      </>}
    </Sheet>
  );
}

/** Enter a position as it stands today. Saved as one balance entry, so no past trades are needed. */
function HoldingFields({ data, account, instrument, h, reload, close }: { data: Data; account: string; instrument: string; h?: Report['holdings'][number]; reload: () => Promise<void>; close: () => void }) {
  const inst = data.instruments.find(i => i.id === instrument);
  const isCash = instrument.startsWith('CASH:');
  const isDebt = inst?.kind === 'debt';
  const isManual = !!inst && (inst.kind === 'manual' || inst.source?.provider === 'manual');
  const hasCost = !isCash && !isDebt;
  const initial = useMemo(() => {
    const lots = h?.lots ?? [];
    const q = lots.reduce((s, l) => s + l.qty, 0);
    return {
      qty: h ? dec(h.qty) : '',
      cost: q > 0 ? dec(lots.reduce((s, l) => s + l.qty * l.cost, 0) / q) : '',
      acquired: lots.map(l => l.date).sort()[0] ?? new Date().toISOString().slice(0, 10),
      price: h && isManual ? dec(h.price) : '',
    };
  }, [h, isManual]);
  const [f, setF] = useState(initial);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [dateHint, setDateHint] = useState('');
  const dateTouched = useRef(false);
  // Default "Bought on" to the last day the asset traded at the entered cost, unless the user picked a date.
  useEffect(() => {
    const cost = Number(f.cost);
    if (!hasCost || dateTouched.current || f.cost === initial.cost || !(cost > 0)) { setDateHint(''); return; }
    let live = true;
    const timer = setTimeout(async () => {
      const { date } = await api.priceDate(instrument, cost).catch(() => ({ date: null }));
      if (!live || dateTouched.current) return;
      if (date) { setF(x => ({ ...x, acquired: date })); setDateHint(`Last traded near this price on ${date}.`); }
      else setDateHint('No price history found, so please set the date yourself.');
    }, 400);
    return () => { live = false; clearTimeout(timer); };
  }, [f.cost, hasCost, instrument, initial.cost]);
  const send = async (body: Parameters<typeof api.setHolding>[0]) => {
    setBusy(true); setErr('');
    try { await api.setHolding(body); await reload(); close(); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  const parse = (s: string) => (s.trim() === '' ? NaN : Number(s));
  const save = () => {
    const qty = parse(f.qty);
    if (!(qty >= 0)) return setErr(isCash || isDebt ? 'Enter a balance of 0 or more.' : 'Enter a quantity of 0 or more.');
    if (isCash) return send({ account, currency: instrument.slice(5), amount: qty });
    const body: Parameters<typeof api.setHolding>[0] = { account, instrument, qty };
    if (hasCost && (!h || f.cost !== initial.cost || f.acquired !== initial.acquired)) {
      const cost = parse(f.cost);
      if (!(cost >= 0)) return setErr('Enter your average cost per unit.');
      body.cost = cost; body.acquired = f.acquired;
    }
    if (isManual) {
      if (f.price.trim() !== '' && f.price !== initial.price) { const price = parse(f.price); if (!(price >= 0)) return setErr('Enter a valid price.'); body.price = price; }
      else if (!h && body.cost !== undefined) body.price = body.cost;
    }
    return send(body);
  };
  const remove = () => {
    if (!confirm(`Remove ${h?.name ?? instrument} from this account? Your earlier transactions stay in Activity.`)) return;
    send(isCash ? { account, currency: instrument.slice(5), amount: 0 } : { account, instrument, qty: 0 });
  };
  const ccy = isCash ? instrument.slice(5) : inst?.currency ?? '';
  return (
    <>
      <div className="grid2">
        <label className="f">{isCash || isDebt ? `Balance (${ccy})` : 'Quantity'}<input inputMode="decimal" value={f.qty} onChange={e => setF({ ...f, qty: e.target.value })} /></label>
        {hasCost && <label className="f">Average cost per unit ({ccy})<input inputMode="decimal" value={f.cost} onChange={e => setF({ ...f, cost: e.target.value })} /></label>}
        {hasCost && <label className="f">Bought on (approx.)<input type="date" value={f.acquired} onChange={e => { dateTouched.current = true; setDateHint(''); setF({ ...f, acquired: e.target.value }); }} /></label>}
        {isManual && <label className="f">Current price ({ccy})<input inputMode="decimal" value={f.price} placeholder="same as cost" onChange={e => setF({ ...f, price: e.target.value })} /></label>}
      </div>
      {dateHint && <div className="small ink2" role="status">{dateHint}</div>}
      {hasCost && <div className="small muted">Cost and date are used to estimate tax. Changing either merges this holding's lots into one.</div>}
      {err && <div className="err">{err}</div>}
      <div className="row">
        {h && <button className="btn danger" disabled={busy} onClick={remove}>Remove</button>}
        <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </>
  );
}

function AddHolding({ data, report, reload, close }: { data: Data; report: Report; reload: () => Promise<void>; close: () => void }) {
  const [account, setAccount] = useState(data.accounts[0]?.id ?? '');
  const [what, setWhat] = useState('');
  const [ccy, setCcy] = useState(data.accounts[0]?.currency ?? report.base);
  const [creating, setCreating] = useState(false);
  if (creating) return <Sheet title="Add instrument" close={() => setCreating(false)}><InstrumentForm data={data} reload={reload} onUse={i => { setWhat(i.id); setCreating(false); }} done={async i => { await reload(); if (i) setWhat(i.id); setCreating(false); }} /></Sheet>;
  const instrument = what === 'cash' ? `CASH:${ccy}` : what;
  const existing = report.holdings.find(h => h.account === account && h.instrument === instrument);
  return (
    <Sheet title="Add holding" close={close}>
      {data.accounts.length === 0 && <div className="warnbox">Create an account in Settings first.</div>}
      <div className="grid2">
        <label className="f">Account<select value={account} onChange={e => setAccount(e.target.value)}>{data.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label className="f">Holding<select value={what} onChange={e => { if (e.target.value === '__new') setCreating(true); else setWhat(e.target.value); }}>
          <option value="">Choose…</option>
          <option value="__new">+ New instrument…</option>
          <option value="cash">Cash</option>
          {data.instruments.map(i => <option key={i.id} value={i.id}>{i.id}{i.name && i.name !== i.id ? ` · ${i.name}` : ''}</option>)}
        </select></label>
        {what === 'cash' && <label className="f">Currency<input value={ccy} maxLength={3} onChange={e => setCcy(e.target.value.toUpperCase())} /></label>}
      </div>
      {existing && <div className="warnbox">You already hold this in this account. Saving replaces the current balance.</div>}
      {account && what && (what !== 'cash' || ccy.length === 3) && <HoldingFields key={`${account}|${instrument}`} data={data} account={account} instrument={instrument} h={existing} reload={reload} close={close} />}
    </Sheet>
  );
}

function HoldingDetail({ h, data, reload, m }: { h: Report['holdings'][number]; data: Data; reload: () => Promise<void>; m: (v: number) => string }) {
  const inst = data.instruments.find(i => i.id === h.instrument);
  const [exp, setExp] = useState<ExposureSpec | null | undefined>(undefined);
  const [txt, setTxt] = useState('');
  const [msg, setMsg] = useState('');
  const [editingHolding, setEditingHolding] = useState(false);
  const load = async () => { const e = await api.exposure(h.instrument).catch(() => null); setExp(e); setTxt(JSON.stringify(inst?.exposureOverride ?? e ?? { classes: { equity: { weight: 1, dims: { region: { US: 1 } } } } }, null, 2)); };
  useEffect(() => { if (inst) load(); }, [h.instrument]);
  const saveInst = async (patch: Partial<Instrument>) => {
    await api.put('instruments', data.instruments.map(i => (i.id === h.instrument ? { ...i, ...patch } : i)));
    await reload();
  };
  return (
    <div className="stack" style={{ marginTop: 10, cursor: 'auto' }} onClick={e => e.stopPropagation()}>
      <button className="btn ghost block" onClick={() => setEditingHolding(true)}>Edit holding</button>
      {editingHolding && <Sheet title={`Edit ${h.name}`} close={() => setEditingHolding(false)}><HoldingFields data={data} account={h.account} instrument={h.instrument} h={h} reload={reload} close={() => setEditingHolding(false)} /></Sheet>}
      {h.lots.length > 0 && <table className="t"><thead><tr><th>Lot</th><th>Date</th><th>Qty</th><th>Cost</th></tr></thead>
        <tbody>{h.lots.map(l => <tr key={l.id}><td>{l.id}</td><td>{l.date}</td><td>{+l.qty.toFixed(6)}</td><td>{l.cost.toFixed(2)}</td></tr>)}</tbody></table>}
      {h.deferredTaxBase > 0 && <div className="small ink2">Tax if sold now ≈ {m(h.deferredTaxBase)}</div>}
      {inst && <>
        <div className="small muted">Exposure source: {inst.exposureOverride ? 'your override' : exp?.source ?? 'none (unclassified)'}{exp?.asOf ? ` · ${exp.asOf}` : ''}</div>
        <details><summary className="small" style={{ color: 'var(--s1-ink)' }}>Edit exposure override</summary>
          <textarea value={txt} onChange={e => setTxt(e.target.value)} />
          <div className="row"><button className="btn" onClick={async () => { try { await saveInst({ exposureOverride: JSON.parse(txt) }); setMsg('Saved'); } catch (e) { setMsg(String(e)); } }}>Save override</button>
            {inst.exposureOverride && <button className="btn ghost" onClick={() => saveInst({ exposureOverride: undefined })}>Use auto</button>}</div>
        </details>
        <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={!!inst.excluded} onChange={e => saveInst({ excluded: e.target.checked })} /> In exception sleeve (excluded from targets)</label>
        {(inst.kind === 'manual' || inst.source?.provider === 'manual') && <label className="f">Upload price CSV (date,price)
          <input type="file" accept=".csv,.txt" onChange={async e => { const f = e.target.files?.[0]; if (!f) return; try { const r = await api.uploadPrices(inst.id, await f.text()); setMsg(`${r.points} prices loaded`); await reload(); } catch (x) { setMsg(String(x)); } }} /></label>}
        <button className="btn danger block" onClick={async () => { try { if (await confirmDeleteInstrument(data, inst)) await reload(); } catch (e) { setMsg((e as Error).message); } }}>Delete instrument</button>
        {msg && <div className="small muted">{msg}</div>}
      </>}
    </div>
  );
}

// ───────────────────────── Activity ─────────────────────────
const TX_FIELDS: Record<string, (keyof Tx)[]> = {
  buy: ['instrument', 'qty', 'price', 'fees'], sell: ['instrument', 'qty', 'price', 'fees'], open: ['instrument', 'qty', 'price'],
  deposit: ['amount', 'currency'], withdraw: ['amount', 'currency'], dividend: ['instrument', 'amount', 'currency'], interest: ['amount', 'currency'], fee: ['amount', 'currency'],
  fx: ['amount', 'currency', 'toAmount', 'toCurrency'], split: ['instrument', 'ratio'],
  borrow: ['instrument', 'amount'], repay: ['instrument', 'amount'], debt_interest: ['instrument', 'amount'], valuation: ['instrument', 'price'],
};

export function Activity({ data, report: r, reload }: Ctx) {
  const [adding, setAdding] = useState<'tx' | 'inst' | null>(null);
  const [instErr, setInstErr] = useState('');
  const txs = [...data.transactions].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn" style={{ flex: 1 }} onClick={() => setAdding('tx')}>+ Transaction</button>
        <button className="btn ghost" style={{ flex: 1 }} onClick={() => setAdding('inst')}>+ Instrument</button>
      </div>
      <details className="card">
        <summary><b>Instruments ({data.instruments.length})</b> <span className="small muted">tap to view or delete</span></summary>
        {instErr && <div className="err" style={{ marginTop: 8 }}>{instErr}</div>}
        <div className="list" style={{ marginTop: 8 }}>
          {data.instruments.map(i => (
            <div className="item row between" key={i.id}>
              <div><b>{i.id}</b> <span className="tag">{i.kind}</span>{i.name && i.name !== i.id && <div className="small muted">{i.name}</div>}</div>
              <button className="icon-btn" aria-label={`Delete ${i.id}`} onClick={async () => { setInstErr(''); try { if (await confirmDeleteInstrument(data, i)) await reload(); } catch (e) { setInstErr((e as Error).message); } }}>✕</button>
            </div>
          ))}
          {data.instruments.length === 0 && <div className="muted small">No instruments yet.</div>}
        </div>
      </details>
      <div className="card"><div className="list">
        {txs.map(t => (
          <div className="item row between" key={t.id}>
            <div><div><span className="tag">{t.type}</span> <b>{t.instrument ?? t.currency}</b> <span className="muted small">{data.accounts.find(a => a.id === t.account)?.name ?? t.account}</span></div>
              <div className="small muted num">{t.date} · {t.type === 'adjust' ? `set to ${t.qty ?? t.amount}${t.price !== undefined ? ` at cost ${t.price}` : ''}${t.currency ? ` ${t.currency}` : ''}` : t.qty !== undefined ? `${t.qty} × ${t.price}` : t.amount !== undefined ? `${t.amount} ${t.currency ?? ''}${t.toAmount ? ` → ${t.toAmount} ${t.toCurrency}` : ''}` : t.ratio ? `ratio ${t.ratio}` : t.price}{t.note ? ` · ${t.note}` : ''}</div></div>
            <button className="icon-btn" aria-label="delete" onClick={async () => { if (confirm('Delete this transaction?')) { await api.delTx(t.id); await reload(); } }}>✕</button>
          </div>
        ))}
        {txs.length === 0 && <div className="muted">No transactions yet.</div>}
      </div></div>
      {adding && <Sheet title={adding === 'tx' ? 'New transaction' : 'Add instrument'} close={() => setAdding(null)}>
        {adding === 'tx' ? <TxForm data={data} base={r.base} done={async () => { setAdding(null); await reload(); }} /> : <InstrumentForm data={data} reload={reload} done={async () => { setAdding(null); await reload(); }} />}
      </Sheet>}
    </>
  );
}

function TxForm({ data, base, done }: { data: Data; base: string; done: () => void }) {
  const [t, setT] = useState<Partial<Tx>>({ type: 'buy', date: new Date().toISOString().slice(0, 10), account: data.accounts[0]?.id, currency: base });
  const [err, setErr] = useState('');
  const fields = TX_FIELDS[t.type!] ?? [];
  const set = (k: keyof Tx, v: string) => setT({ ...t, [k]: ['qty', 'price', 'fees', 'amount', 'toAmount', 'ratio'].includes(k) ? (v === '' ? undefined : +v) : v });
  const instOpts = data.instruments.filter(i => (['borrow', 'repay', 'debt_interest'].includes(t.type!) ? i.kind === 'debt' : i.kind !== 'debt'));
  return (
    <div className="stack">
      <div className="grid2">
        <label className="f">Type<select value={t.type} onChange={e => setT({ ...t, type: e.target.value as Tx['type'] })}>{Object.keys(TX_FIELDS).map(k => <option key={k}>{k}</option>)}</select></label>
        <label className="f">Date<input type="date" value={t.date} onChange={e => set('date', e.target.value)} /></label>
        <label className="f">Account<select value={t.account} onChange={e => set('account', e.target.value)}>{data.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        {fields.map(f => f === 'instrument'
          ? <label className="f" key={f}>Instrument<select value={t.instrument ?? ''} onChange={e => set('instrument', e.target.value)}><option value="">—</option>{instOpts.map(i => <option key={i.id} value={i.id}>{i.id}{i.name && i.name !== i.id ? ` · ${i.name}` : ''}</option>)}</select></label>
          : <label className="f" key={f}>{label(f)}{f.toLowerCase().includes('currency')
            ? <input value={(t[f] as string) ?? ''} onChange={e => set(f, e.target.value.toUpperCase())} />
            : <input inputMode="decimal" value={(t[f] as number | undefined) ?? ''} onChange={e => set(f, e.target.value)} />}</label>)}
      </div>
      <label className="f">Note<input value={t.note ?? ''} onChange={e => set('note', e.target.value)} /></label>
      {data.accounts.length === 0 && <div className="warnbox">Create an account in Settings first.</div>}
      {err && <div className="err">{err}</div>}
      <button className="btn block" onClick={async () => { try { const clean = Object.fromEntries(Object.entries(t).filter(([k]) => ['type', 'date', 'account', 'note', ...fields].includes(k))); await api.addTx(clean); done(); } catch (e) { setErr(String(e)); } }}>Save</button>
    </div>
  );
}

/** Confirms, then deletes an instrument and its transactions. Returns false if the user cancelled. */
async function confirmDeleteInstrument(data: Data, inst: Instrument) {
  const n = data.transactions.filter(t => t.instrument === inst.id).length;
  const detail = n ? `\n\nThis also deletes its ${n} transaction${n === 1 ? '' : 's'}, and account cash is recalculated without them.` : '';
  if (!confirm(`Delete ${inst.name ?? inst.id}?${detail}`)) return false;
  await api.delInstrument(inst.id);
  return true;
}

const BULK_LABEL: Record<BulkResult['status'], string> = { added: '✓ Added', exists: '✓ Already added', invalid: 'Not a valid ticker', failed: 'Not found' };

function BulkAdd({ reload }: { reload?: () => Promise<void> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [results, setResults] = useState<BulkResult[] | null>(null);
  const count = parseSymbols(text).valid.length;
  const run = async () => {
    setBusy(true); setErr(''); setResults(null);
    try {
      const r = await api.addInstruments(text);
      setResults(r);
      setText(r.filter(x => x.status === 'failed' || x.status === 'invalid').map(x => x.symbol).join(', '));
      await reload?.();
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  return (
    <>
      <label className="f">Tickers, separated by commas, spaces, or new lines
        <textarea aria-label="Tickers" style={{ minHeight: 90 }} value={text} placeholder="SPY, VT, META, TEVA.TA" autoCapitalize="characters" spellCheck={false} onChange={e => setText(e.target.value)} />
      </label>
      <button className="btn block" disabled={busy || !count} onClick={run}>{busy ? 'Adding…' : count ? `Add ${count} instrument${count === 1 ? '' : 's'}` : 'Add instruments'}</button>
      <div className="small muted">Israeli securities need the .TA ending, for example TEVA.TA.</div>
      {err && <div className="err">{err}</div>}
      {results && <div className="list" role="status">{results.map(x => (
        <div className="item row between small" key={x.symbol}>
          <span><b>{x.symbol}</b>{x.name ? ` · ${x.name}` : ''}</span>
          <span className={x.status === 'added' || x.status === 'exists' ? 'up' : 'down'} style={{ whiteSpace: 'nowrap' }}>{BULK_LABEL[x.status]}</span>
        </div>
      ))}</div>}
    </>
  );
}

function InstrumentForm({ data, done, onUse, reload }: { data: Data; done: (added?: Instrument) => void; onUse?: (existing: Instrument) => void; reload?: () => Promise<void> }) {
  const [mode, setMode] = useState<'search' | 'bulk'>('search');
  const [addingHit, setAddingHit] = useState('');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Awaited<ReturnType<typeof api.search>>>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [man, setMan] = useState<Partial<Instrument>>({ kind: 'manual', currency: 'ILS' });
  const modes = (
    <div className="seg">
      <button className={mode === 'search' ? 'on' : ''} onClick={() => setMode('search')}>Search</button>
      <button className={mode === 'bulk' ? 'on' : ''} onClick={() => setMode('bulk')}>Add several</button>
    </div>
  );
  if (mode === 'bulk') return <div className="stack">{modes}<BulkAdd reload={reload} /></div>;
  return (
    <div className="stack">
      {modes}
      <div className="row">
        <input placeholder="Search: SPY, VT, TEVA.TA, bitcoin…" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && (e.currentTarget.nextElementSibling as HTMLButtonElement)?.click()} />
        <button className="btn" disabled={busy || !q} onClick={async () => { setBusy(true); setErr(''); try { setHits(await api.search(q)); } catch (e) { setErr(String(e)); } setBusy(false); }}>Search</button>
      </div>
      <div className="list">{hits.map(h => {
        const key = `${h.provider}|${h.symbol}`;
        const existing = data.instruments.find(i => i.source?.provider === h.provider && i.source.symbol === h.symbol);
        const add = async () => {
          const wanted = h.provider === 'coingecko' ? h.name.match(/\((\w+)\)$/)?.[1] ?? h.symbol : h.symbol;
          // A different asset can share a ticker across providers, so keep its id unique.
          const id = data.instruments.some(i => i.id === wanted) ? `${wanted}.${h.provider}` : wanted;
          setAddingHit(key); setErr('');
          try { done(await api.addInstrument({ provider: h.provider, symbol: h.symbol, id })); }
          catch (e) { setErr((e as Error).message); setAddingHit(''); }
        };
        return (
          <div className="item row between" key={key}>
            <div><b>{h.symbol}</b> <span className="small muted">{h.exchange} · {h.type} · {h.provider}</span><div className="small">{h.name}</div></div>
            {existing
              ? (onUse ? <button className="btn ghost" style={{ whiteSpace: 'nowrap' }} onClick={() => onUse(existing)}>✓ Added · Use</button>
                : <button className="btn ghost" style={{ whiteSpace: 'nowrap' }} disabled>✓ Added</button>)
              : <button className="btn ghost" disabled={!!addingHit} onClick={add}>{addingHit === key ? 'Adding…' : 'Add'}</button>}
          </div>
        );
      })}</div>
      <details><summary className="small" style={{ color: 'var(--s1-ink)' }}>Manual instrument (Israeli fund, cash account, loan, property…)</summary>
        <div className="grid2" style={{ marginTop: 8 }}>
          <label className="f">ID<input value={man.id ?? ''} onChange={e => setMan({ ...man, id: e.target.value })} /></label>
          <label className="f">Name (used for auto-classification)<input value={man.name ?? ''} onChange={e => setMan({ ...man, name: e.target.value })} placeholder='e.g. מחקה ת"א 125' /></label>
          <label className="f">Kind<select value={man.kind} onChange={e => setMan({ ...man, kind: e.target.value as Instrument['kind'] })}>{['manual', 'debt', 'cash', 'security', 'crypto'].map(k => <option key={k}>{k}</option>)}</select></label>
          <label className="f">Currency<input value={man.currency ?? ''} onChange={e => setMan({ ...man, currency: e.target.value.toUpperCase() })} /></label>
        </div>
        <label className="row small" style={{ marginTop: 8 }}><input type="checkbox" style={{ width: 'auto' }} checked={!!man.tradable} onChange={e => setMan({ ...man, tradable: e.target.checked })} /> Can be bought/sold by the rebalancer (e.g. a fund, not a property)</label>
        {data.instruments.some(i => i.id === man.id)
          ? <button className="btn block" style={{ marginTop: 8 }} disabled>✓ Already added</button>
          : <button className="btn block" style={{ marginTop: 8 }} onClick={async () => { try { done(await api.addInstrument(man)); } catch (e) { setErr((e as Error).message); } }}>Add manual instrument</button>}
      </details>
      {err && <div className="err">{err}</div>}
    </div>
  );
}

// ───────────────────────── Settings ─────────────────────────
export function Settings({ data, reload, onServer, onDirty }: Omit<Ctx, 'report'> & { onServer: () => void; onDirty: (dirty: boolean) => void }) {
  const [s, setS] = useState(structuredClone(data.settings));
  const [accts, setAccts] = useState(structuredClone(data.accounts));
  useEffect(() => { onDirty(JSON.stringify(s) !== JSON.stringify(data.settings) || JSON.stringify(accts) !== JSON.stringify(data.accounts)); }, [s, accts, data]);
  const [fileBusy, setFileBusy] = useState(false);
  const [fileMsg, setFileMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [keepTickers, setKeepTickers] = useState(true);
  const clearApp = async () => {
    if (!confirm('Clear ALL accounts, holdings, transactions, targets and settings?\n\nA backup of your current data is kept on the server first.')) return;
    setFileBusy(true); setFileMsg(null);
    try {
      const { autoBackup } = await api.clearAll(keepTickers);
      const fresh = await api.data();
      setS(structuredClone(fresh.settings)); setAccts(structuredClone(fresh.accounts));
      await reload();
      setFileMsg({ ok: true, text: `App cleared. Previous data kept as backups/${autoBackup}.` });
    } catch (e) { setFileMsg({ ok: false, text: (e as Error).message }); }
    setFileBusy(false);
  };
  const saveToFile = async () => {
    setFileBusy(true); setFileMsg(null);
    try {
      const backup = await api.saveFile();
      const name = `personal-etf-${backup.savedAt.slice(0, 10)}.json`;
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setFileMsg({ ok: true, text: `Saved ${name} to your downloads.` });
    } catch (e) { setFileMsg({ ok: false, text: `Could not save: ${(e as Error).message}` }); }
    setFileBusy(false);
  };
  const loadFromFile = async (file: File) => {
    setFileBusy(true); setFileMsg(null);
    try {
      let backup: { savedAt?: string; data?: { accounts?: unknown[]; instruments?: unknown[]; transactions?: unknown[] } };
      try { backup = JSON.parse(await file.text()); } catch { throw new Error('This is not a Personal ETF save file.'); }
      const when = backup.savedAt ? new Date(backup.savedAt).toLocaleString() : 'unknown date';
      const d = backup.data;
      const summary = `${d?.accounts?.length ?? 0} accounts, ${d?.instruments?.length ?? 0} instruments, ${d?.transactions?.length ?? 0} transactions`;
      if (confirm(`Replace ALL current data with this save?\n\n${file.name}\nSaved: ${when}\n${summary}\n\nA backup of your current data is kept on the server first.`)) {
        const { autoBackup } = await api.loadFile(backup);
        const fresh = await api.data();
        setS(structuredClone(fresh.settings)); setAccts(structuredClone(fresh.accounts));
        await reload();
        setFileMsg({ ok: true, text: `Loaded ${file.name}. Previous data kept as backups/${autoBackup}.` });
      }
    } catch (e) { setFileMsg({ ok: false, text: (e as Error).message }); }
    setFileBusy(false);
  };
  const [log, setLog] = useState<{ item: string; ok: boolean; msg: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  return (
    <div className="stack">
      <div className="card stack">
        <h2>Data</h2>
        <button className="btn block" disabled={busy} onClick={async () => { setBusy(true); try { setLog(await api.refresh(false)); await reload(); } catch (e) { setMsg(String(e)); } setBusy(false); }}>{busy ? 'Refreshing…' : 'Refresh prices, FX & classifications'}</button>
        {log && <div className="small" style={{ maxHeight: 200, overflow: 'auto' }}>{log.map((l, i) => <div key={i} className={l.ok ? 'muted' : 'down'}>{l.ok ? '✓' : '✕'} {l.item} — {l.msg}</div>)}</div>}
        <button className="btn ghost" onClick={onServer}>Server & token…</button>
      </div>
      <div className="card stack">
        <h2>Save & load</h2>
        <div className="row">
          <button className="btn ghost" style={{ flex: 1 }} disabled={fileBusy} onClick={saveToFile}>Save to file</button>
          <label className="btn ghost" style={{ flex: 1, textAlign: 'center', opacity: fileBusy ? .5 : 1, pointerEvents: fileBusy ? 'none' : undefined }}>Load from file
            <input type="file" accept=".json,application/json" aria-label="Load from file" style={{ display: 'none' }} disabled={fileBusy} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) loadFromFile(f); }} />
          </label>
        </div>
        <div className="small muted">The file contains your whole portfolio, unencrypted, so keep it somewhere private.</div>
        <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={keepTickers} onChange={e => setKeepTickers(e.target.checked)} /> When clearing, remember confirmed tickers</label>
        <button className="btn danger block" disabled={fileBusy} onClick={clearApp}>Clear app and start over</button>
        {fileMsg && <div className={fileMsg.ok ? 'small ink2' : 'err'} role="status">{fileMsg.text}</div>}
      </div>
      <div className="card stack">
        <h2>General</h2>
        <div className="grid2">
          <label className="f">Base currency<input value={s.baseCurrency} onChange={e => setS({ ...s, baseCurrency: e.target.value.toUpperCase() })} /></label>
          <label className="f">Risk-free rate<input type="number" step="0.005" value={s.riskFreeRate} onChange={e => setS({ ...s, riskFreeRate: +e.target.value })} /></label>
          <label className="f">Benchmark (Yahoo symbol)<input value={s.benchmark ?? ''} onChange={e => setS({ ...s, benchmark: e.target.value || undefined })} placeholder="e.g. VT" /></label>
          <label className="f">Debt counts in targets<select value={String(s.debtInTargets)} onChange={e => setS({ ...s, debtInTargets: e.target.value === 'true' })}><option value="false">No</option><option value="true">Yes</option></select></label>
        </div>
        <h2>Tax</h2>
        <div className="grid2">
          <label className="f">Capital-gains rate<input type="number" step="0.01" value={s.tax.rate} onChange={e => setS({ ...s, tax: { ...s.tax, rate: +e.target.value } })} /></label>
          <label className="f">Gains computed in<input value={s.tax.currency} onChange={e => setS({ ...s, tax: { ...s.tax, currency: e.target.value.toUpperCase() } })} /></label>
          <label className="f">Lot method<select value={s.tax.lotMethod} onChange={e => setS({ ...s, tax: { ...s.tax, lotMethod: e.target.value as typeof s.tax.lotMethod } })}><option value="fifo">FIFO</option><option value="specific">Specific lot</option><option value="average">Average cost</option></select></label>
          <label className="f">Credit realized losses<select value={String(s.tax.lossCredit)} onChange={e => setS({ ...s, tax: { ...s.tax, lossCredit: e.target.value === 'true' } })}><option value="false">No</option><option value="true">Yes</option></select></label>
        </div>
        <h2>Trading</h2>
        <div className="grid2">
          <label className="f">Fee (bps)<input type="number" value={s.trading.feeBps} onChange={e => setS({ ...s, trading: { ...s.trading, feeBps: +e.target.value } })} /></label>
          <label className="f">FX conversion (bps)<input type="number" value={s.trading.fxBps} onChange={e => setS({ ...s, trading: { ...s.trading, fxBps: +e.target.value } })} /></label>
          <label className="f">Min trade ({s.baseCurrency})<input type="number" value={s.trading.minTrade} onChange={e => setS({ ...s, trading: { ...s.trading, minTrade: +e.target.value } })} /></label>
          <label className="f">Cash reserve (fraction)<input type="number" step="0.01" value={s.trading.minCashPct} onChange={e => setS({ ...s, trading: { ...s.trading, minCashPct: +e.target.value } })} /></label>
        </div>
      </div>
      <div className="card stack">
        <h2>Accounts</h2>
        {accts.map((a, i) => (
          <div className="grid2" key={i} style={{ borderTop: i ? '1px solid var(--grid)' : 0, paddingTop: i ? 10 : 0 }}>
            <label className="f">ID<input value={a.id} onChange={e => setAccts(accts.map((x, j) => j === i ? { ...x, id: e.target.value } : x))} /></label>
            <label className="f">Name<input value={a.name} onChange={e => setAccts(accts.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} /></label>
            <label className="f">Currency<input value={a.currency} onChange={e => setAccts(accts.map((x, j) => j === i ? { ...x, currency: e.target.value.toUpperCase() } : x))} /></label>
            <label className="f">Tax status<select value={a.taxStatus} onChange={e => setAccts(accts.map((x, j) => j === i ? { ...x, taxStatus: e.target.value as typeof a.taxStatus } : x))}><option value="taxable">Taxable</option><option value="exempt">Exempt (e.g. קרן השתלמות)</option><option value="deferred">Deferred</option></select></label>
          </div>
        ))}
        <button className="btn ghost" onClick={() => setAccts([...accts, { id: `acct${accts.length + 1}`, name: 'New account', currency: s.baseCurrency, taxStatus: 'taxable' }])}>+ Account</button>
      </div>
      {msg && <div className="small muted">{msg}</div>}
      <button className="btn block" onClick={async () => { try { await api.put('settings', s); await api.put('accounts', accts); await reload(); setMsg('Saved'); } catch (e) { setMsg(String(e)); } }}>Save settings</button>
    </div>
  );
}
