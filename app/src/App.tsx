import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getServer, setServer, type Data, type Report } from './api';
import { Activity, Holdings, Overview, Rebalance, Settings, Targets } from './views';

const TABS = [
  { id: 'overview', label: 'Overview', d: 'M3 13h4v8H3zM10 8h4v13h-4zM17 3h4v18h-4z' },
  { id: 'targets', label: 'Targets', d: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 4a6 6 0 1 1 0 12 6 6 0 0 1 0-12zm0 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4z' },
  { id: 'rebalance', label: 'Rebalance', d: 'M7 7h11l-3-3m3 3-3 3M17 17H6l3 3m-3-3 3-3' },
  { id: 'holdings', label: 'Holdings', d: 'M4 6h16M4 12h16M4 18h10' },
  { id: 'activity', label: 'Activity', d: 'M12 5v14M5 12h14' },
] as const;
type Tab = typeof TABS[number]['id'] | 'settings';

export function App() {
  const [tab, setTab] = useState<Tab>(() => (location.hash.slice(1) as Tab) || 'overview');
  const [data, setData] = useState<Data | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [serverSheet, setServerSheet] = useState(false);
  const lastPage = useRef<Tab>(tab === 'settings' ? 'overview' : tab);
  const settingsDirty = useRef(false);
  if (tab !== 'settings') lastPage.current = tab;
  const go = (next: Tab) => {
    if (tab === 'settings' && next !== 'settings' && settingsDirty.current && !confirm('Discard unsaved settings?')) return;
    settingsDirty.current = false;
    setTab(next);
  };

  const reload = useCallback(async () => {
    setLoading(true);
    try { const [d, r] = await Promise.all([api.data(), api.report()]); setData(d); setReport(r); setErr(''); }
    catch (e) { setErr(String((e as Error).message ?? e)); if (/unauthorized/.test(String(e))) setServerSheet(true); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { if (location.hash.slice(1) !== tab) location.hash = tab; window.scrollTo(0, 0); }, [tab]);
  useEffect(() => { const f = () => setTab((location.hash.slice(1) as Tab) || 'overview'); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);

  const ctx = data && report ? { data, report, reload } : null;
  return (
    <div className="app">
      <header className="top">
        <div className="row" style={{ gap: 2 }}>
          {tab === 'settings' && <button className="icon-btn" style={{ marginLeft: -8 }} aria-label={`Back to ${TABS.find(t => t.id === lastPage.current)?.label}`} onClick={() => go(lastPage.current)}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7" /></svg></button>}
          <h1>{tab === 'settings' ? 'Settings' : TABS.find(t => t.id === tab)?.label}</h1>
        </div>
        <div className="row" style={{ gap: 0 }}>
          <button className="icon-btn" aria-label="reload" onClick={reload}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={loading ? 'spin' : ''}><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" /></svg></button>
          <button className="icon-btn" aria-label="settings" onClick={() => go('settings')}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg></button>
        </div>
      </header>

      {err && <div className="card"><div className="err">{err}</div><button className="btn ghost" style={{ marginTop: 8 }} onClick={() => setServerSheet(true)}>Server settings</button></div>}
      {!ctx && !err && <div className="muted">Loading…</div>}
      {ctx && tab === 'overview' && <Overview {...ctx} />}
      {ctx && tab === 'targets' && <Targets {...ctx} />}
      {ctx && tab === 'rebalance' && <Rebalance {...ctx} />}
      {ctx && tab === 'holdings' && <Holdings {...ctx} />}
      {ctx && tab === 'activity' && <Activity {...ctx} />}
      {data && tab === 'settings' && <Settings data={data} reload={reload} onServer={() => setServerSheet(true)} onDirty={d => { settingsDirty.current = d; }} />}

      <nav className="tabs"><div>
        {TABS.map(t => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => go(t.id)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={t.d} /></svg>{t.label}
          </button>
        ))}
      </div></nav>

      {serverSheet && <ServerSheet close={() => { setServerSheet(false); reload(); }} />}
    </div>
  );
}

function ServerSheet({ close }: { close: () => void }) {
  const s = getServer();
  const [base, setBase] = useState(s.base);
  const [token, setToken] = useState(s.token);
  return (
    <div className="sheet-bg" onClick={close}><div className="sheet stack" onClick={e => e.stopPropagation()}>
      <div className="row between"><h3 style={{ margin: 0 }}>Server</h3><button className="icon-btn" aria-label="Close" onClick={close}>✕</button></div>
      <label className="f">Server URL (blank = this site)<input value={base} onChange={e => setBase(e.target.value)} placeholder="https://petf.example.com" /></label>
      <label className="f">Access token (PETF_TOKEN)<input type="password" value={token} onChange={e => setToken(e.target.value)} /></label>
      <button className="btn block" onClick={() => { setServer(base, token); close(); }}>Save & connect</button>
    </div></div>
  );
}
