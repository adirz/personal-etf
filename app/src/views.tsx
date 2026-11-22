import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, fmtMoney, label, num, pct, type Data, type RebalanceResult, type Report, type Tx, type Instrument, type ExposureSpec } from './api';
import { Bullet, HBars, Heatmap, LineChart, RiskBars } from './charts';
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
  const groups = useMemo(() => {
    const g: Record<string, Report['holdings']> = {};
    for (const h of r.holdings) (g[h.account] ??= []).push(h);
    for (const k in g) g[k].sort((a, b) => b.value - a.value);
    return g;
  }, [r]);
  return (
    <>
      <button className="btn block" style={{ marginBottom: 12 }} onClick={() => setAdding(true)}>+ Add holding</button>
      {adding && <AddHolding data={data} report={r} reload={reload} close={() => setAdding(false)} />}
      {Object.entries(groups).map(([acct, hs]) => (
        <div className="card" key={acct}>
          <div className="row between"><h2 style={{ margin: 0 }}>{data.accounts.find(a => a.id === acct)?.name ?? acct}</h2><span className="num small ink2">{m(hs.reduce((s, h) => s + h.value, 0), true)}</span></div>
          <div className="list">
            {hs.map(h => (
              <div className="item" key={h.key} onClick={() => setOpen(open === h.key ? null : h.key)} style={{ cursor: 'pointer' }}>
                <div className="row between">
                  <div><b>{h.name}</b> {h.excluded && <span className="tag">sleeve</span>} {h.kind === 'debt' && <span className="tag">debt</span>}
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

const dec = (v: number) => String(+v.toFixed(6));

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
        {hasCost && <label className="f">Bought on (approx.)<input type="date" value={f.acquired} onChange={e => setF({ ...f, acquired: e.target.value })} /></label>}
        {isManual && <label className="f">Current price ({ccy})<input inputMode="decimal" value={f.price} placeholder="same as cost" onChange={e => setF({ ...f, price: e.target.value })} /></label>}
      </div>
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
  if (creating) return <Sheet title="Add instrument" close={() => setCreating(false)}><InstrumentForm done={async i => { await reload(); if (i) setWhat(i.id); setCreating(false); }} /></Sheet>;
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
        <details><summary className="small" style={{ color: 'var(--s1)' }}>Edit exposure override</summary>
          <textarea value={txt} onChange={e => setTxt(e.target.value)} />
          <div className="row"><button className="btn" onClick={async () => { try { await saveInst({ exposureOverride: JSON.parse(txt) }); setMsg('Saved'); } catch (e) { setMsg(String(e)); } }}>Save override</button>
            {inst.exposureOverride && <button className="btn ghost" onClick={() => saveInst({ exposureOverride: undefined })}>Use auto</button>}</div>
        </details>
        <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={!!inst.excluded} onChange={e => saveInst({ excluded: e.target.checked })} /> In exception sleeve (excluded from targets)</label>
        {(inst.kind === 'manual' || inst.source?.provider === 'manual') && <label className="f">Upload price CSV (date,price)
          <input type="file" accept=".csv,.txt" onChange={async e => { const f = e.target.files?.[0]; if (!f) return; try { const r = await api.uploadPrices(inst.id, await f.text()); setMsg(`${r.points} prices loaded`); await reload(); } catch (x) { setMsg(String(x)); } }} /></label>}
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
  const txs = [...data.transactions].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn" style={{ flex: 1 }} onClick={() => setAdding('tx')}>+ Transaction</button>
        <button className="btn ghost" style={{ flex: 1 }} onClick={() => setAdding('inst')}>+ Instrument</button>
      </div>
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
        {adding === 'tx' ? <TxForm data={data} base={r.base} done={async () => { setAdding(null); await reload(); }} /> : <InstrumentForm done={async () => { setAdding(null); await reload(); }} />}
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

function InstrumentForm({ done }: { done: (added?: Instrument) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Awaited<ReturnType<typeof api.search>>>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [man, setMan] = useState<Partial<Instrument>>({ kind: 'manual', currency: 'ILS' });
  return (
    <div className="stack">
      <div className="row">
        <input placeholder="Search: SPY, VT, TEVA.TA, bitcoin…" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && (e.currentTarget.nextElementSibling as HTMLButtonElement)?.click()} />
        <button className="btn" disabled={busy || !q} onClick={async () => { setBusy(true); setErr(''); try { setHits(await api.search(q)); } catch (e) { setErr(String(e)); } setBusy(false); }}>Search</button>
      </div>
      <div className="list">{hits.map(h => (
        <div className="item row between" key={h.provider + h.symbol}>
          <div><b>{h.symbol}</b> <span className="small muted">{h.exchange} · {h.type} · {h.provider}</span><div className="small">{h.name}</div></div>
          <button className="btn ghost" onClick={async () => { try { done(await api.addInstrument({ provider: h.provider, symbol: h.symbol, id: h.provider === 'coingecko' ? h.name.match(/\((\w+)\)$/)?.[1] ?? h.symbol : h.symbol })); } catch (e) { setErr(String(e)); } }}>Add</button>
        </div>))}</div>
      <details><summary className="small" style={{ color: 'var(--s1)' }}>Manual instrument (Israeli fund, cash account, loan, property…)</summary>
        <div className="grid2" style={{ marginTop: 8 }}>
          <label className="f">ID<input value={man.id ?? ''} onChange={e => setMan({ ...man, id: e.target.value })} /></label>
          <label className="f">Name (used for auto-classification)<input value={man.name ?? ''} onChange={e => setMan({ ...man, name: e.target.value })} placeholder='e.g. מחקה ת"א 125' /></label>
          <label className="f">Kind<select value={man.kind} onChange={e => setMan({ ...man, kind: e.target.value as Instrument['kind'] })}>{['manual', 'debt', 'cash', 'security', 'crypto'].map(k => <option key={k}>{k}</option>)}</select></label>
          <label className="f">Currency<input value={man.currency ?? ''} onChange={e => setMan({ ...man, currency: e.target.value.toUpperCase() })} /></label>
        </div>
        <label className="row small" style={{ marginTop: 8 }}><input type="checkbox" style={{ width: 'auto' }} checked={!!man.tradable} onChange={e => setMan({ ...man, tradable: e.target.checked })} /> Can be bought/sold by the rebalancer (e.g. a fund, not a property)</label>
        <button className="btn block" style={{ marginTop: 8 }} onClick={async () => { try { done(await api.addInstrument(man)); } catch (e) { setErr(String(e)); } }}>Add manual instrument</button>
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
