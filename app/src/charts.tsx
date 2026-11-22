import { useRef, useState, type KeyboardEvent } from 'react';
import { label, pct } from './api';

/** Single-series line with crosshair + tooltip. */
export function LineChart({ points, fmt }: { points: { date: string; value: number }[]; fmt: (v: number) => string }) {
  const W = 680, H = 180, P = { l: 4, r: 4, t: 10, b: 20 };
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  if (points.length < 2) return <div className="muted small">Not enough history yet.</div>;
  const vs = points.map(p => p.value);
  const lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || 1;
  const x = (i: number) => P.l + (i / (points.length - 1)) * (W - P.l - P.r);
  const y = (v: number) => P.t + (1 - (v - lo) / span) * (H - P.t - P.b);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const onMove = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const fx = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(((fx - P.l) / (W - P.l - P.r)) * (points.length - 1)))));
  };
  const h = hover !== null ? points[hover] : null;
  return (
    <div style={{ position: 'relative' }}>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', touchAction: 'pan-y' }}
        onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="Net worth over time">
        {[0.25, 0.5, 0.75].map(f => <line key={f} x1={P.l} x2={W - P.r} y1={P.t + f * (H - P.t - P.b)} y2={P.t + f * (H - P.t - P.b)} stroke="var(--grid)" strokeWidth="1" />)}
        <line x1={P.l} x2={W - P.r} y1={H - P.b} y2={H - P.b} stroke="var(--axis)" />
        <path d={d} fill="none" stroke="var(--s1)" strokeWidth="2" strokeLinejoin="round" />
        <text x={P.l} y={H - 5} fontSize="11" fill="var(--muted)">{points[0].date}</text>
        <text x={W - P.r} y={H - 5} fontSize="11" fill="var(--muted)" textAnchor="end">{points.at(-1)!.date}</text>
        {h && <>
          <line x1={x(hover!)} x2={x(hover!)} y1={P.t} y2={H - P.b} stroke="var(--axis)" />
          <circle cx={x(hover!)} cy={y(h.value)} r="4.5" fill="var(--s1)" stroke="var(--surface)" strokeWidth="2" />
        </>}
      </svg>
      {h && <div className="tip" style={{ left: `clamp(0px, calc(${(x(hover!) / W) * 100}% - 60px), calc(100% - 130px))`, top: 0 }}>
        <div className="muted">{h.date}</div><div className="num"><b>{fmt(h.value)}</b></div>
      </div>}
    </div>
  );
}

/** Horizontal bars, one hue (magnitude), values direct-labeled. */
export function HBars({ data, total, fmt }: { data: [string, number][]; total: number; fmt: (v: number) => string }) {
  const max = Math.max(...data.map(d => Math.abs(d[1])), 1e-9);
  return (
    <div className="stack">
      {data.map(([k, v]) => (
        <div key={k} title={`${label(k)}: ${fmt(v)} (${pct(v / total)})`}>
          <div className="row between small"><span>{label(k)}</span><span className="num ink2">{pct(v / total)} · {fmt(v)}</span></div>
          <div style={{ height: 8, background: 'var(--neutral)', borderRadius: 4, marginTop: 3 }}>
            <div style={{ width: `${(Math.abs(v) / max) * 100}%`, height: '100%', borderRadius: 4, background: v < 0 ? 'var(--critical)' : 'var(--s1)' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Bullet bar: actual (fill) vs target (tick) with tolerance band shaded. Scale 0..max(actual,target+band). */
export function Bullet({ actual, target, band, out, max, drag }: {
  actual: number; target: number; band: number; out: boolean; max?: number;
  /** When set, the target gets a draggable handle and the bar uses a fixed 0–100 scale so the pointer maps directly. */
  drag?: { name: string; disabled?: boolean; onStart: () => void; onMove: (pct: number) => void; onEnd: () => void };
}) {
  const scale = drag ? 100 : (max ?? Math.max(actual, target + band, 1)) * 1.08;
  const p = (v: number) => `${Math.max(0, Math.min(100, (v / scale) * 100))}%`;
  const bar = useRef<HTMLDivElement>(null);
  const active = useRef(false);
  const fromPointer = (x: number) => { const b = bar.current!.getBoundingClientRect(); return Math.max(0, Math.min(100, ((x - b.left) / b.width) * 100)); };
  const nudge = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = ({ ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 } as Record<string, number>)[e.key];
    if (!dir || !drag || drag.disabled) return;
    e.preventDefault();
    drag.onStart(); drag.onMove(target + dir * (e.shiftKey ? 5 : 0.5)); drag.onEnd();
  };
  return (
    <div ref={bar} style={{ position: 'relative', height: 14, background: 'var(--neutral)', borderRadius: 4, margin: drag ? '8px 0' : undefined }} aria-label={`actual ${actual.toFixed(1)}%, target ${target}%`}>
      <div style={{ position: 'absolute', left: p(Math.max(0, target - band)), width: `calc(${p(target + band)} - ${p(Math.max(0, target - band))})`, top: 0, bottom: 0, background: 'var(--band)' }} />
      <div style={{ position: 'absolute', left: 0, width: p(actual), top: 3, bottom: 3, borderRadius: 3, background: out ? 'var(--warn)' : 'var(--s1)' }} />
      <div style={{ position: 'absolute', left: p(target), top: -2, bottom: -2, width: 2, marginLeft: -1, background: 'var(--ink)' }} />
      {drag && <div className={`handle ${drag.disabled ? 'off' : ''}`} style={{ left: p(target) }} role="slider" tabIndex={drag.disabled ? -1 : 0}
        aria-label={`${drag.name} target`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={target} aria-disabled={drag.disabled}
        onKeyDown={nudge}
        onPointerDown={e => { if (drag.disabled) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); active.current = true; drag.onStart(); }}
        onPointerMove={e => { if (active.current) drag.onMove(fromPointer(e.clientX)); }}
        onPointerUp={() => { if (active.current) { active.current = false; drag.onEnd(); } }}
        onPointerCancel={() => { if (active.current) { active.current = false; drag.onEnd(); } }}><span /></div>}
    </div>
  );
}

/** Correlation heatmap: diverging blue (−1) ↔ neutral (0) ↔ orange (+1). */
export function Heatmap({ ids, m }: { ids: string[]; m: number[][] }) {
  const [tip, setTip] = useState<string | null>(null);
  const color = (v: number) => {
    if (!Number.isFinite(v)) return 'var(--neutral)';
    const a = Math.min(1, Math.abs(v));
    return `color-mix(in srgb, ${v >= 0 ? 'var(--s2)' : 'var(--s1)'} ${Math.round(a * 85)}%, var(--neutral))`;
  };
  const n = ids.length, cell = Math.max(22, Math.min(44, 300 / n));
  return (
    <div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'separate', borderSpacing: 2, fontSize: 11 }}>
          <tbody>
            <tr><td />{ids.map(id => <td key={id} className="muted" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', height: 56, verticalAlign: 'bottom' }}>{id}</td>)}</tr>
            {ids.map((a, i) => (
              <tr key={a}>
                <td className="muted" style={{ paddingRight: 6, whiteSpace: 'nowrap' }}>{a}</td>
                {ids.map((b, j) => (
                  <td key={b} onPointerEnter={() => setTip(`${a} × ${b}: ${Number.isFinite(m[i][j]) ? m[i][j].toFixed(2) : 'n/a'}`)} onPointerLeave={() => setTip(null)} onClick={() => setTip(`${a} × ${b}: ${m[i][j].toFixed(2)}`)}
                    style={{ width: cell, height: cell, background: color(m[i][j]), borderRadius: 4, textAlign: 'center', color: Math.abs(m[i][j]) > 0.6 ? (m[i][j] >= 0 ? '#06182f' : '#fff') : 'var(--ink-2)' }}>
                    {n <= 8 && i !== j ? m[i][j].toFixed(1) : ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row between small muted" style={{ marginTop: 6 }}>
        <span>{tip ?? 'Tap a cell'}</span>
        <span className="row" style={{ gap: 4 }}>−1 <span style={{ width: 80, height: 8, borderRadius: 4, background: 'linear-gradient(90deg, var(--s1), var(--neutral), var(--s2))' }} /> +1</span>
      </div>
    </div>
  );
}

/** Weight vs risk contribution, paired bars per instrument. */
export function RiskBars({ rows }: { rows: { id: string; weight: number; risk: number }[] }) {
  const max = Math.max(...rows.flatMap(r => [r.weight, r.risk]), 0.01);
  return (
    <div className="stack">
      <div className="row small muted" style={{ gap: 14 }}>
        <span className="row" style={{ gap: 5 }}><i style={{ width: 10, height: 10, borderRadius: 3, background: 'var(--s1)' }} />Weight</span>
        <span className="row" style={{ gap: 5 }}><i style={{ width: 10, height: 10, borderRadius: 3, background: 'var(--s2)' }} />Risk share</span>
      </div>
      {rows.map(r => (
        <div key={r.id} title={`${r.id}: weight ${pct(r.weight)}, risk ${pct(r.risk)}`}>
          <div className="row between small"><span>{r.id}</span><span className="num ink2">{pct(r.weight)} → {pct(r.risk)}</span></div>
          <div style={{ display: 'grid', gap: 2, marginTop: 3 }}>
            <div style={{ height: 6, width: `${(r.weight / max) * 100}%`, background: 'var(--s1)', borderRadius: 3 }} />
            <div style={{ height: 6, width: `${(Math.max(0, r.risk) / max) * 100}%`, background: 'var(--s2)', borderRadius: 3 }} />
          </div>
        </div>
      ))}
    </div>
  );
}
