import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Person } from './types';
import { shortName } from './types';
import { Avatar } from './WeekPlan';
import { toISO, todayISO } from './dates';
import { appIdle } from './idle';
import {
  agentRef, arrivedWithin, dueBy, fetchRecord, fetchSheet, notContacted, ourTurn, subscribeSheet, writeCell,
  type LastWords, type RecordDetail, type SheetAction, type SheetData, type SheetPerson,
} from './crmSheet';

/**
 * CRM: one page. Left, the daily overview (who needs us today); right, every person as a spreadsheet, live on
 * crm_people, where a human types straight into a cell (iain, 6 Oct 2026: "좌측에 메인 데일리 오버뷰, 그리고 우측에
 * crm처럼 스프레드시트 ... 우리 DB랑 실시간 연결되서 업데이트 수동으로할 수 있는거"). Clicking a name, or Space on a
 * row, opens that person's record: every field, the research, what they wrote, the timeline, and every DB
 * column as it is stored. No messaging from here.
 *
 * Keys on the sheet: arrows move, Enter or F2 or a double-click edits, typing replaces, Tab and Enter commit
 * and move, Escape cancels, Backspace clears, Space opens the record, ⌘C copies the cell.
 */

interface Props {
  teamId: string;
  me: string;
  people: Person[];
  cloud: boolean;
  onClose: () => void;
  onError: (m: string) => void;
  /** Phone shell: registers a back handler (record → sheet) for the back-swipe guard. */
  backRef?: React.MutableRefObject<(() => boolean) | null>;
}

const CUSTOMER_STAGES = ['lead', 'engaged', 'visiting', 'deposit_pending', 'deposit_paid', 'accepted', 'on_hold', 'cancelled', 'refunded', 'delivered'];
const INVESTOR_STAGES = ['new', 'routed', 'intro', 'meeting', 'diligence', 'passed', 'invested', 'parked'];
const TYPES = ['customer', 'investor', 'contributor'];

type Kind = 'text' | 'long' | 'link' | 'date' | 'stamp' | 'select' | 'owner' | 'bool' | 'types' | 'ro' | 'rostamp';
interface Col { key: string; label: string; w: number; kind: Kind; options?: string[] }
/** The sheet's columns, in order. Email, provenance and consent are shown but never editable (merge key, patch-016 guards). */
const COLS: Col[] = [
  { key: 'name', label: 'Name', w: 190, kind: 'text' },
  { key: 'customer_stage', label: 'Stage', w: 118, kind: 'select', options: CUSTOMER_STAGES },
  { key: 'owner_user_id', label: 'Owner', w: 112, kind: 'owner' },
  { key: 'next_action', label: 'Next action', w: 220, kind: 'text' },
  { key: 'next_action_due', label: 'Due', w: 92, kind: 'date' },
  { key: 'last_outbound_at', label: 'Contacted', w: 100, kind: 'stamp' },
  { key: 'notes', label: 'Notes', w: 240, kind: 'long' },
  { key: 'enrichment_headline', label: 'Who (research)', w: 260, kind: 'ro' },
  { key: '_said', label: 'What they wrote', w: 280, kind: 'ro' },
  { key: 'email_normalized', label: 'Email', w: 210, kind: 'ro' },
  { key: 'phone_as_typed', label: 'Phone', w: 128, kind: 'text' },
  { key: 'company', label: 'Company', w: 150, kind: 'text' },
  { key: 'job_title', label: 'Title', w: 150, kind: 'text' },
  { key: 'location_text', label: 'Location', w: 130, kind: 'text' },
  { key: 'linkedin_url', label: 'LinkedIn', w: 170, kind: 'link' },
  { key: 'x_handle', label: 'X', w: 110, kind: 'text' },
  { key: 'types', label: 'Types', w: 150, kind: 'types' },
  { key: 'investor_stage', label: 'Investor stage', w: 118, kind: 'select', options: INVESTOR_STAGES },
  { key: 'source_at', label: 'Arrived', w: 96, kind: 'rostamp' },
  { key: 'last_inbound_at', label: 'Last inbound', w: 104, kind: 'rostamp' },
  { key: 'source_channel', label: 'Source', w: 112, kind: 'ro' },
  { key: 'enrichment_status', label: 'Research', w: 90, kind: 'ro' },
  { key: 'do_not_contact', label: 'Do not contact', w: 104, kind: 'bool' },
  { key: 'flags', label: 'Flags', w: 130, kind: 'ro' },
];
const editable = (c: Col) => c.kind !== 'ro' && c.kind !== 'rostamp';
const typed = (c: Col) => c.kind === 'text' || c.kind === 'long' || c.kind === 'link';

type Filter = 'all' | 'due' | 'ourTurn' | 'new' | 'notContacted';
const FILTERS: { k: Filter; t: string }[] = [
  { k: 'all', t: 'All' }, { k: 'due', t: 'Due' }, { k: 'ourTurn', t: 'Our turn' }, { k: 'new', t: 'New 48h' }, { k: 'notContacted', t: 'Not contacted' },
];

/* ── formatting ── */
const label = (s?: string | null) => (s ?? '').replace(/_/g, ' ');
const thisYear = new Date().getFullYear();
const fmtDay = (d?: string | null) => {
  if (!d || d.length < 10) return '';
  const [y, m, dd] = d.slice(0, 10).split('-').map(Number);
  const t = new Date(y, m - 1, dd);
  return t.toLocaleDateString([], y === thisYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: '2-digit' });
};
const fmtStamp = (iso?: string | null) => (iso ? fmtDay(toISO(new Date(iso))) : '');
const ago = (iso?: string | null) => {
  if (!iso) return '';
  const m = Math.round((Date.now() - +new Date(iso)) / 60_000);
  if (m < 60) return `${Math.max(m, 1)}m`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h`;
  if (m < 14 * 1440) return `${Math.round(m / 1440)}d`;
  return fmtStamp(iso);
};
const one = (s?: string | null, n = 140) => { const t = (s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const nameOf = (p: SheetPerson) => p.name || p.email_normalized || (p.x_handle ? `@${p.x_handle}` : 'Unnamed');

interface Ctx { said: Record<string, LastWords>; people: Person[] }
function show(p: SheetPerson, c: Col, ctx: Ctx): string {
  const v = c.key === '_said' ? ctx.said[p.id]?.text : p[c.key];
  if (v === null || v === undefined || v === '') return '';
  switch (c.kind) {
    case 'date': return fmtDay(String(v));
    case 'stamp': case 'rostamp': return fmtStamp(String(v));
    case 'select': return label(String(v));
    case 'owner': { const who = ctx.people.find((x) => x.id === v); return who ? shortName(who.name) : 'Someone else'; }
    case 'bool': return v ? 'Yes' : '';
    case 'types': return (v as string[]).join(', ');
    default: return Array.isArray(v) ? v.join(', ') : c.key === 'source_channel' || c.key === 'enrichment_status' ? label(String(v)) : one(String(v), 400);
  }
}
function sortKey(p: SheetPerson, c: Col, ctx: Ctx): string | number {
  if (c.key === '_said') return ctx.said[p.id]?.at ? +new Date(ctx.said[p.id].at) : 0;
  const v = p[c.key];
  if (v === null || v === undefined || v === '') return '';
  if (c.kind === 'stamp' || c.kind === 'rostamp') return +new Date(String(v));
  if (c.kind === 'select') return (c.options ?? []).indexOf(String(v));
  if (c.kind === 'bool') return v ? 1 : 0;
  return show(p, c, ctx).toLowerCase();
}

export function CrmPage(p: Props) {
  const { teamId, me, people, cloud } = p;
  const [data, setData] = useState<SheetData>({ people: [], said: {}, actions: [], loaded: false });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'source_at', dir: -1 });
  const [sel, setSel] = useState<{ id: string; c: number } | null>(null);
  const [edit, setEdit] = useState<{ id: string; c: number; initial?: string } | null>(null);
  const [recordId, setRecordId] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [, tick] = useState(0);

  const load = () => fetchSheet(teamId, cloud).then((d) => { setData(d); setLoadError(null); }).catch((e) => { const m = String((e as Error).message ?? e); setLoadError(m); p.onError(`CRM: ${m}`); });
  useEffect(() => {
    setData({ people: [], said: {}, actions: [], loaded: false }); setSel(null); setEdit(null); setRecordId(null);
    load();
    const unsub = subscribeSheet(teamId, cloud, {
      person: (row, oldId) => setData((d) => {
        const rest = d.people.filter((x) => x.id !== (row?.id ?? oldId));
        return { ...d, people: row && !row.merged_into ? [row, ...rest] : rest };
      }),
      words: (pid, w) => setData((d) => (d.said[pid] && d.said[pid].at >= w.at ? d : { ...d, said: { ...d.said, [pid]: w } })),
      action: (row, oldId) => setData((d) => {
        const rest = d.actions.filter((x) => x.id !== (row?.id ?? oldId));
        return { ...d, actions: row && row.status === 'open' ? [...rest, row] : rest };
      }),
    });
    setLive(cloud);
    // "2h ago" and "today" drift while the page stays open; parked while the app sits unfocused (src/idle.ts)
    const t = window.setInterval(() => { if (!appIdle()) tick((n) => n + 1); }, 60_000);
    // Realtime does not replay what happened while the machine slept: refetch on focus, at most every 5 minutes (egress).
    let last = Date.now();
    const onFocus = () => { if (Date.now() - last > 5 * 60_000) { last = Date.now(); load(); } };
    window.addEventListener('focus', onFocus);
    return () => { unsub(); setLive(false); window.clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [teamId, cloud]); // eslint-disable-line react-hooks/exhaustive-deps

  const back = () => { if (recordId) { setRecordId(null); return true; } return false; };
  if (p.backRef) p.backRef.current = back;
  useEffect(() => () => { if (p.backRef) p.backRef.current = null; }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const ctx: Ctx = useMemo(() => ({ said: data.said, people }), [data.said, people]);
  const today = todayISO();
  const visible = useMemo(() => data.people.filter((x) => !(x.flags ?? []).includes('test')), [data.people]);
  const counts = useMemo(() => ({
    all: visible.length,
    due: visible.filter((x) => dueBy(x, today)).length,
    ourTurn: visible.filter(ourTurn).length,
    new: visible.filter((x) => arrivedWithin(x, 48)).length,
    notContacted: visible.filter(notContacted).length,
  }), [visible, today]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^@/, '');
    const col = COLS.find((c) => c.key === sort.key) ?? COLS[0];
    const pass = (x: SheetPerson) =>
      filter === 'all' ? true : filter === 'due' ? dueBy(x, today) : filter === 'ourTurn' ? ourTurn(x) : filter === 'new' ? arrivedWithin(x, 48) : notContacted(x);
    const hit = (x: SheetPerson) => !q || [x.name, x.email_normalized, x.company, x.job_title, x.x_handle, x.phone_as_typed, x.notes, x.next_action, x.enrichment_headline, data.said[x.id]?.text]
      .some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
    return visible.filter((x) => pass(x) && hit(x)).sort((a, b) => {
      const ka = sortKey(a, col, ctx), kb = sortKey(b, col, ctx);
      if (ka === '' && kb !== '') return 1; // empty cells sink, whichever way the sort runs
      if (kb === '' && ka !== '') return -1;
      if (ka === kb) return +new Date(b.source_at) - +new Date(a.source_at);
      return (ka < kb ? -1 : 1) * sort.dir;
    });
  }, [visible, filter, query, sort, data.said, people, today]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── writing ── */
  const commit = (person: SheetPerson, key: string, value: unknown) => {
    const before = person[key] ?? null;
    if (JSON.stringify(before) === JSON.stringify(value ?? null)) return;
    const optimistic = { ...person, [key]: value };
    setData((d) => ({ ...d, people: d.people.map((x) => (x.id === person.id ? optimistic : x)) }));
    writeCell(teamId, me, person, key, value)
      .then((row) => setData((d) => ({ ...d, people: d.people.map((x) => (x.id === row.id ? row : x)) })))
      .catch((e) => {
        setData((d) => ({ ...d, people: d.people.map((x) => (x.id === person.id ? { ...x, [key]: before } : x)) }));
        p.onError(`Not saved (${label(key)}): ${String((e as Error).message ?? e)}`);
      });
  };

  /* ── keyboard ── */
  const focusGrid = () => gridRef.current?.focus({ preventScroll: true });
  const reveal = (id: string, c: number) => requestAnimationFrame(() => {
    gridRef.current?.querySelector(`[data-cell="${id}:${c}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  const moveSel = (dr: number, dc: number) => {
    if (!sel) { if (rows[0]) setSel({ id: rows[0].id, c: 0 }); return; }
    const r = Math.max(0, Math.min(rows.length - 1, rows.findIndex((x) => x.id === sel.id) + dr));
    const c = Math.max(0, Math.min(COLS.length - 1, sel.c + dc));
    if (!rows[r]) return;
    setSel({ id: rows[r].id, c });
    reveal(rows[r].id, c);
  };
  const startEdit = (id: string, c: number, initial?: string) => {
    const col = COLS[c];
    const person = rows.find((x) => x.id === id);
    if (!person || !editable(col)) return;
    if (col.kind === 'bool') { commit(person, col.key, !person[col.key]); return; }
    setSel({ id, c });
    setEdit({ id, c, initial });
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (edit || e.target !== gridRef.current) return; // the editor owns its keys
    const k = e.key;
    if (k === 'ArrowDown') { e.preventDefault(); moveSel(1, 0); return; }
    if (k === 'ArrowUp') { e.preventDefault(); moveSel(-1, 0); return; }
    if (k === 'ArrowRight' || (k === 'Tab' && !e.shiftKey)) { e.preventDefault(); moveSel(0, 1); return; }
    if (k === 'ArrowLeft' || (k === 'Tab' && e.shiftKey)) { e.preventDefault(); moveSel(0, -1); return; }
    if (!sel) return;
    const col = COLS[sel.c];
    const person = rows.find((x) => x.id === sel.id);
    if (!person) return;
    if (k === 'Enter' || k === 'F2') { e.preventDefault(); startEdit(sel.id, sel.c); return; }
    if (k === ' ') { e.preventDefault(); setRecordId(sel.id); return; }
    if (k === 'Escape') { if (recordId) setRecordId(null); else setSel(null); return; }
    if ((k === 'Backspace' || k === 'Delete') && editable(col) && col.kind !== 'bool') { e.preventDefault(); commit(person, col.key, col.kind === 'types' ? [] : null); return; }
    if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === 'c') {
      e.preventDefault();
      const raw = col.key === '_said' ? data.said[person.id]?.text : person[col.key];
      navigator.clipboard?.writeText(raw === null || raw === undefined ? '' : Array.isArray(raw) ? raw.join(', ') : String(raw)).catch(() => {});
      return;
    }
    if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && typed(col)) { e.preventDefault(); startEdit(sel.id, sel.c, k); }
  };
  const done = (person: SheetPerson, c: number, value: unknown | undefined, move?: 'down' | 'right' | 'left') => {
    setEdit(null);
    if (value !== undefined) commit(person, COLS[c].key, value);
    if (move === 'down') moveSel(1, 0); else if (move === 'right') moveSel(0, 1); else if (move === 'left') moveSel(0, -1);
    focusGrid();
  };

  const openRecord = (id: string) => { setRecordId(id); const c = sel?.id === id ? sel.c : 0; setSel({ id, c }); reveal(id, c); };
  const record = recordId ? data.people.find((x) => x.id === recordId) ?? null : null;

  return (
    <div className="crm cs">
      <Overview data={data} visible={visible} counts={counts} people={people} today={today} filter={filter}
        onFilter={(f) => { setFilter(f); setQuery(''); }} onPerson={(id) => { setFilter('all'); setQuery(''); openRecord(id); }} />
      <section className="cs-main">
        <header className="cs-bar">
          <input className="cs-search" placeholder="Search name, email, company, notes…" value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); focusGrid(); } if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); if (rows[0]) setSel({ id: rows[0].id, c: 0 }); focusGrid(); } }} />
          <div className="cs-filters">
            {FILTERS.map((f) => (
              <button key={f.k} className={`cs-filter${filter === f.k ? ' on' : ''}`} onClick={() => setFilter(f.k)}>
                {f.t}<span>{counts[f.k]}</span>
              </button>
            ))}
          </div>
          <span className="panel-spacer" />
          <span className={`cs-live${live ? ' on' : ''}`} title={live ? 'Live: every change in the database shows here as it happens' : 'Not connected'}>{live ? 'Live' : 'Offline'}</span>
          <button className="icon-btn" title="Close CRM" aria-label="Close CRM" onClick={p.onClose}><XGlyph /></button>
        </header>
        {!cloud && <div className="cs-empty">Sign in to see the CRM. It reads the team's live database.</div>}
        {cloud && loadError && !data.loaded && <div className="cs-empty">Couldn't load the CRM: {loadError} <button className="pill small" onClick={load}>Retry</button></div>}
        {cloud && (
          <div className="cs-grid-wrap" ref={gridRef} tabIndex={0} onKeyDown={onKey} role="grid" aria-rowcount={rows.length}>
            <table className="cs-grid">
              <colgroup><col style={{ width: 44 }} />{COLS.map((c) => <col key={c.key} style={{ width: c.w }} />)}</colgroup>
              <thead>
                <tr>
                  <th className="cs-num">#</th>
                  {COLS.map((c, i) => (
                    <th key={c.key} className={`${i === 0 ? 'cs-sticky ' : ''}${editable(c) ? '' : 'ro'}`}
                      onClick={() => setSort((s) => (s.key === c.key ? { key: c.key, dir: (s.dir * -1) as 1 | -1 } : { key: c.key, dir: c.kind === 'rostamp' || c.kind === 'stamp' ? -1 : 1 }))}>
                      <span>{c.label}</span>{sort.key === c.key && <i>{sort.dir === 1 ? '↑' : '↓'}</i>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((x, r) => (
                  <Row key={x.id} person={x} n={r + 1} ctx={ctx} said={data.said[x.id]}
                    selC={sel?.id === x.id ? sel.c : -1} editC={edit?.id === x.id ? edit.c : -1} initial={edit?.id === x.id ? edit.initial : undefined}
                    open={recordId === x.id}
                    onSelect={(c) => { setSel({ id: x.id, c }); if (edit && (edit.id !== x.id || edit.c !== c)) setEdit(null); }}
                    onEdit={(c) => startEdit(x.id, c)}
                    onOpen={() => openRecord(x.id)}
                    onDone={(c, v, move) => done(x, c, v, move)} />
                ))}
              </tbody>
            </table>
            {data.loaded && rows.length === 0 && <div className="cs-empty">{query ? `Nobody matches “${query}”.` : 'Nobody here.'}</div>}
            {!data.loaded && !loadError && <div className="cs-empty">Loading…</div>}
          </div>
        )}
        {record && (
          <RecordPanel key={record.id} person={record} said={data.said[record.id]} people={people} cloud={cloud} ctx={ctx}
            onClose={() => { setRecordId(null); focusGrid(); }} onCommit={(key, v) => commit(record, key, v)} onError={p.onError} />
        )}
      </section>
    </div>
  );
}

/* ─── the daily overview ────────────────────────────── */

function Overview({ data, visible, counts, people, today, filter, onFilter, onPerson }: {
  data: SheetData; visible: SheetPerson[]; counts: Record<Filter, number>; people: Person[]; today: string; filter: Filter;
  onFilter: (f: Filter) => void; onPerson: (id: string) => void;
}) {
  // Each person appears once, in the first section that fits: what is due, whose turn it is, who is new, who is waiting.
  const seen = new Set<string>();
  const take = (list: SheetPerson[]) => list.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
  const byRecent = (a: SheetPerson, b: SheetPerson) => +new Date(b.last_inbound_at ?? b.source_at) - +new Date(a.last_inbound_at ?? a.source_at);
  const due = take(visible.filter((x) => dueBy(x, today)).sort((a, b) => (a.next_action_due ?? '').localeCompare(b.next_action_due ?? '')));
  const turn = take(visible.filter(ourTurn).sort(byRecent));
  const fresh = take(visible.filter((x) => arrivedWithin(x, 48)).sort(byRecent));
  const waiting = take(visible.filter(notContacted).sort(byRecent));
  const nameById = new Map(data.people.map((x) => [x.id, nameOf(x)]));
  const actions = [...data.actions].sort((a, b) => a.priority - b.priority || (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'));
  const date = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const stats: { k: Filter; t: string }[] = [{ k: 'new', t: 'New 48h' }, { k: 'notContacted', t: 'Not contacted' }, { k: 'ourTurn', t: 'Our turn' }, { k: 'due', t: 'Due' }];
  return (
    <aside className="cs-overview">
      <div className="cs-ov-head"><h1>Today</h1><span>{date}</span></div>
      <div className="cs-stats">
        {stats.map((s) => (
          <button key={s.k} className={`cs-stat${filter === s.k ? ' on' : ''}${s.k === 'due' && counts.due ? ' hot' : ''}`} onClick={() => onFilter(filter === s.k ? 'all' : s.k)}>
            <strong>{data.loaded ? counts[s.k] : '–'}</strong><span>{s.t}</span>
          </button>
        ))}
      </div>
      <div className="cs-ov-scroll">
        {!data.loaded && <div className="cs-empty">Loading…</div>}
        <OvSection title="Due" list={due} limit={8} line={(x) => one(x.next_action, 90) || 'Next action due'} meta={(x) => fmtDay(x.next_action_due)} metaHot={(x) => (x.next_action_due ?? '') < today} people={people} onPerson={onPerson} onMore={() => onFilter('due')} />
        <OvSection title="Our turn" hint="They answered; the next word is ours" list={turn} limit={8} line={(x) => one(data.said[x.id]?.text, 90) || one(x.enrichment_headline, 90)} meta={(x) => ago(x.last_inbound_at)} people={people} onPerson={onPerson} onMore={() => onFilter('ourTurn')} />
        <OvSection title="New" hint="Arrived in the last 48 hours" list={fresh} limit={10} line={(x) => one(x.enrichment_headline, 90) || one(data.said[x.id]?.text, 90)} meta={(x) => ago(x.source_at)} people={people} onPerson={onPerson} onMore={() => onFilter('new')} />
        <OvSection title="Not contacted yet" list={waiting} limit={8} line={(x) => one(x.enrichment_headline, 90) || one(data.said[x.id]?.text, 90)} meta={(x) => ago(x.source_at)} people={people} onPerson={onPerson} onMore={() => onFilter('notContacted')} />
        {actions.length > 0 && (
          <section className="cs-ov-sec">
            <h2>Open actions <span>{actions.length}</span></h2>
            {actions.slice(0, 8).map((a: SheetAction) => (
              <button key={a.id} className="cs-ov-row" onClick={() => a.person_id && onPerson(a.person_id)} disabled={!a.person_id}>
                <span className="cs-ov-main"><b>{a.person_id ? nameById.get(a.person_id) ?? 'Someone' : 'Team'}</b><em>{one(a.title, 90)}</em></span>
                <span className={`cs-ov-meta${a.due_date && a.due_date < today ? ' hot' : ''}`}>{a.due_date ? fmtDay(a.due_date) : `P${a.priority}`}</span>
              </button>
            ))}
          </section>
        )}
        {data.loaded && !due.length && !turn.length && !fresh.length && !waiting.length && <div className="cs-empty">Nobody is waiting on us.</div>}
      </div>
    </aside>
  );
}

function OvSection({ title, hint, list, limit, line, meta, metaHot, people, onPerson, onMore }: {
  title: string; hint?: string; list: SheetPerson[]; limit: number; line: (x: SheetPerson) => string; meta: (x: SheetPerson) => string;
  metaHot?: (x: SheetPerson) => boolean; people: Person[]; onPerson: (id: string) => void; onMore: () => void;
}) {
  if (!list.length) return null;
  return (
    <section className="cs-ov-sec">
      <h2 title={hint}>{title} <span>{list.length}</span></h2>
      {list.slice(0, limit).map((x) => {
        const owner = x.owner_user_id ? people.find((m) => m.id === x.owner_user_id) : null;
        return (
          <button key={x.id} className="cs-ov-row" onClick={() => onPerson(x.id)}>
            <span className="cs-ov-main"><b>{nameOf(x)}</b><em>{line(x) || x.email_normalized || ''}</em></span>
            <span className={`cs-ov-meta${metaHot?.(x) ? ' hot' : ''}`}>{owner && <Avatar person={owner} size={16} />}{meta(x)}</span>
          </button>
        );
      })}
      {list.length > limit && <button className="cs-ov-more" onClick={onMore}>All {list.length} in the sheet →</button>}
    </section>
  );
}

/* ─── the sheet ─────────────────────────────────────── */

const Row = memo(function Row({ person, n, ctx, said, selC, editC, initial, open, onSelect, onEdit, onOpen, onDone }: {
  person: SheetPerson; n: number; ctx: Ctx; said?: LastWords; selC: number; editC: number; initial?: string; open: boolean;
  onSelect: (c: number) => void; onEdit: (c: number) => void; onOpen: () => void; onDone: (c: number, v: unknown | undefined, move?: 'down' | 'right' | 'left') => void;
}) {
  void said; // a prop only so a new message re-renders the row
  const dim = person.do_not_contact || ['cancelled', 'refunded'].includes(person.customer_stage ?? '');
  return (
    <tr className={`${selC >= 0 ? 'sel' : ''}${open ? ' open' : ''}${dim ? ' dim' : ''}`}>
      <td className="cs-num" onClick={onOpen} title="Open the record">{n}</td>
      {COLS.map((c, i) => {
        const text = show(person, c, ctx);
        const isEdit = editC === i;
        return (
          <td key={c.key} data-cell={`${person.id}:${i}`}
            className={`${i === 0 ? 'cs-sticky ' : ''}k-${c.kind}${selC === i ? ' cur' : ''}${isEdit ? ' editing' : ''}${editable(c) ? '' : ' ro'}`}
            onMouseDown={(e) => {
              if (isEdit) return;
              // an open editor elsewhere commits first (a click-away saves, as in a spreadsheet); preventDefault would otherwise keep its focus
              const active = document.activeElement as HTMLElement | null;
              if (active?.closest('.cs-edit')) active.blur();
              e.preventDefault(); onSelect(i);
              (e.currentTarget.closest('.cs-grid-wrap') as HTMLElement | null)?.focus({ preventScroll: true });
            }}
            onDoubleClick={() => { if (c.kind !== 'bool') onEdit(i); }}
            title={c.kind === 'ro' || c.kind === 'long' || c.key === 'next_action' ? (c.key === '_said' ? ctx.said[person.id]?.text : (person[c.key] as string | undefined)) ?? undefined : undefined}>
            {isEdit ? <Editor col={c} value={person[c.key]} initial={initial} people={ctx.people} onDone={(v, move) => onDone(i, v, move)} /> : (
              i === 0 ? <span className="cs-name"><span>{text || <i className="cs-null">Unnamed</i>}</span><button className="cs-open" title="Open the record (Space)" onMouseDown={(e) => e.stopPropagation()} onClick={onOpen}><OpenGlyph /></button></span>
              : c.kind === 'bool' ? <span className={`cs-check${person[c.key] ? ' on' : ''}`} onClick={() => onEdit(i)} />
              : c.kind === 'link' && text ? <a href={/^https?:/i.test(text) ? text : `https://${text}`} target="_blank" rel="noreferrer" onMouseDown={(e) => e.stopPropagation()}>{text.replace(/^https?:\/\/(www\.)?/i, '')}</a>
              : c.kind === 'select' && text ? <span className={`cs-tag s-${String(person[c.key])}`}>{text}</span>
              : c.kind === 'owner' && text ? <OwnerChip id={String(person[c.key])} people={ctx.people} />
              : text
            )}
          </td>
        );
      })}
    </tr>
  );
});

function OwnerChip({ id, people }: { id: string; people: Person[] }) {
  const who = people.find((x) => x.id === id);
  return <span className="cs-owner">{who && <Avatar person={who} size={16} />}{who ? shortName(who.name) : 'Someone else'}</span>;
}

/** One cell's editor. onDone(undefined) cancels; a value commits (null clears). */
function Editor({ col, value, initial, people, onDone }: {
  col: Col; value: unknown; initial?: string; people: Person[]; onDone: (v: unknown | undefined, move?: 'down' | 'right' | 'left') => void;
}) {
  const finished = useRef(false);
  const finish = (v: unknown | undefined, move?: 'down' | 'right' | 'left') => { if (finished.current) return; finished.current = true; onDone(v, move); };
  const text = (s: string) => (s.trim() === '' ? null : col.kind === 'long' ? s.replace(/\s+$/, '') : s.trim());
  const keys = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>, get: () => unknown) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); finish(undefined); }
    else if (e.key === 'Enter' && !(col.kind === 'long' && e.shiftKey)) { e.preventDefault(); finish(get(), 'down'); }
    else if (e.key === 'Tab') { e.preventDefault(); finish(get(), e.shiftKey ? 'left' : 'right'); }
  };
  if (col.kind === 'text' || col.kind === 'link') {
    const start = initial ?? (value === null || value === undefined ? '' : String(value));
    return <input className="cs-edit" autoFocus defaultValue={start} onFocus={(e) => { if (initial === undefined) e.currentTarget.select(); else { const l = e.currentTarget.value.length; e.currentTarget.setSelectionRange(l, l); } }}
      onKeyDown={(e) => keys(e, () => text(e.currentTarget.value))} onBlur={(e) => finish(text(e.currentTarget.value))} />;
  }
  if (col.kind === 'long') {
    const start = initial ?? (value === null || value === undefined ? '' : String(value));
    return <textarea className="cs-edit cs-edit-long" autoFocus defaultValue={start} rows={4}
      onFocus={(e) => { const l = e.currentTarget.value.length; e.currentTarget.setSelectionRange(l, l); }}
      onKeyDown={(e) => keys(e, () => text(e.currentTarget.value))} onBlur={(e) => finish(text(e.currentTarget.value))} />;
  }
  if (col.kind === 'date' || col.kind === 'stamp') {
    const start = value ? (col.kind === 'stamp' ? toISO(new Date(String(value))) : String(value).slice(0, 10)) : '';
    const out = (s: string) => (!s ? null : col.kind === 'stamp' ? new Date(`${s}T12:00:00`).toISOString() : s);
    return <input className="cs-edit" type="date" autoFocus defaultValue={start}
      onKeyDown={(e) => keys(e, () => out(e.currentTarget.value))} onBlur={(e) => finish(out(e.currentTarget.value))} />;
  }
  if (col.kind === 'select' || col.kind === 'owner') {
    const opts = col.kind === 'owner' ? people.map((m) => [m.id, m.name] as const) : (col.options ?? []).map((o) => [o, label(o)] as const);
    return (
      <select className="cs-edit" autoFocus defaultValue={value === null || value === undefined ? '' : String(value)}
        onChange={(e) => finish(e.currentTarget.value || null)} onKeyDown={(e) => keys(e, () => e.currentTarget.value || null)} onBlur={() => finish(undefined)}>
        <option value="">{col.kind === 'owner' ? 'Unassigned' : '—'}</option>
        {opts.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
    );
  }
  if (col.kind === 'types') return <TypesEditor value={(value as string[] | null) ?? []} onDone={finish} />;
  return null;
}

function TypesEditor({ value, onDone }: { value: string[]; onDone: (v: unknown | undefined, move?: 'down' | 'right' | 'left') => void }) {
  const [draft, setDraft] = useState<string[]>(value);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const out = () => TYPES.filter((t) => draft.includes(t));
  return (
    <div className="cs-edit cs-types" ref={ref} tabIndex={-1}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onDone(out()); }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onDone(undefined); if (e.key === 'Enter') onDone(out(), 'down'); if (e.key === 'Tab') { e.preventDefault(); onDone(out(), e.shiftKey ? 'left' : 'right'); } }}>
      {TYPES.map((t) => (
        <button key={t} className={draft.includes(t) ? 'on' : ''} onMouseDown={(e) => e.preventDefault()}
          onClick={() => setDraft((d) => (d.includes(t) ? d.filter((x) => x !== t) : [...d, t]))}>{t}</button>
      ))}
    </div>
  );
}

/* ─── one person's record ───────────────────────────── */

function RecordPanel({ person, said, people, cloud, ctx, onClose, onCommit, onError }: {
  person: SheetPerson; said?: LastWords; people: Person[]; cloud: boolean; ctx: Ctx;
  onClose: () => void; onCommit: (key: string, v: unknown) => void; onError: (m: string) => void;
}) {
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let alive = true;
    fetchRecord(person.id, cloud).then((d) => { if (alive) setDetail(d); }).catch((e) => onError(`Record: ${String((e as Error).message ?? e)}`));
    return () => { alive = false; };
  }, [person.id, person.last_inbound_at, person.last_outbound_at, said?.at, cloud]); // eslint-disable-line react-hooks/exhaustive-deps
  const copyRef = () => {
    navigator.clipboard?.writeText(agentRef(person.id, nameOf(person))).catch(() => {});
    setCopied(true); window.setTimeout(() => setCopied(false), 1500);
  };
  const enr = (person.enrichment ?? null) as Record<string, unknown> | null;
  return (
    <aside className="cs-record" onKeyDown={(e) => { if (e.key === 'Escape' && !editing) onClose(); }}>
      <header className="cs-rec-head">
        <div className="cs-rec-title">
          <h2>{nameOf(person)}</h2>
          <span>{[person.job_title, person.company].filter(Boolean).join(' · ') || person.email_normalized}</span>
        </div>
        <button className="pill small" onClick={copyRef} title="Copies a one-line reference to paste into Claude or Codex">{copied ? 'Copied' : 'Open in agent'}</button>
        <button className="icon-btn" title="Close (Esc)" onClick={onClose}><XGlyph /></button>
      </header>
      <div className="cs-rec-scroll">
        <table className="cs-fields">
          <tbody>
            {COLS.map((c) => {
              const isEdit = editing === c.key;
              const text = show(person, c, ctx);
              return (
                <tr key={c.key} className={editable(c) ? '' : 'ro'}>
                  <th>{c.label}</th>
                  <td className={isEdit ? 'editing' : ''} onClick={() => { if (!editable(c) || isEdit) return; if (c.kind === 'bool') onCommit(c.key, !person[c.key]); else setEditing(c.key); }}>
                    {isEdit ? <Editor col={c} value={person[c.key]} people={people} onDone={(v) => { setEditing(null); if (v !== undefined) onCommit(c.key, v); }} />
                      : c.key === '_said' ? <span className="cs-pre">{said?.text ?? ''}</span>
                      : c.kind === 'long' || c.key === 'enrichment_headline' ? <span className="cs-pre">{(person[c.key] as string | null) ?? ''}</span>
                      : c.kind === 'link' && text ? <a href={/^https?:/i.test(text) ? text : `https://${text}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{text}</a>
                      : c.kind === 'owner' && text ? <OwnerChip id={String(person[c.key])} people={people} />
                      : c.kind === 'bool' ? <span className={`cs-check${person[c.key] ? ' on' : ''}`} />
                      : text || <i className="cs-null">empty</i>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <Research person={person} enr={enr} />

        {detail && detail.submissions.length > 0 && (
          <section className="cs-rec-sec">
            <h3>What they wrote <span>{detail.submissions.length}</span></h3>
            {detail.submissions.map((s) => (
              <div key={s.id} className="cs-msg">
                <div className="cs-msg-head"><b>{label(s.channel)}</b><span>{new Date(s.received_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div>
                <p>{s.text_body || <i className="cs-null">no text</i>}</p>
              </div>
            ))}
          </section>
        )}
        {detail && detail.interactions.length > 0 && (
          <section className="cs-rec-sec">
            <h3>Timeline <span>{detail.interactions.length}</span></h3>
            {detail.interactions.map((i) => {
              const who = i.actor_user_id ? people.find((m) => m.id === i.actor_user_id) : null;
              return (
                <div key={i.id} className={`cs-msg d-${i.direction}`}>
                  <div className="cs-msg-head"><b>{i.direction === 'inbound' ? 'In' : i.direction === 'outbound' ? 'Out' : 'Note'} · {label(i.channel)}</b>{who && <span>{shortName(who.name)}</span>}<span>{new Date(i.occurred_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div>
                  <p>{i.summary}</p>
                  {i.body && i.body !== i.summary && <details><summary>Full text</summary><p>{i.body}</p></details>}
                </div>
              );
            })}
          </section>
        )}
        {detail && detail.reservations.length > 0 && (
          <section className="cs-rec-sec">
            <h3>Reservations <span>{detail.reservations.length}</span></h3>
            {detail.reservations.map((r) => (
              <div key={r.id} className="cs-msg"><div className="cs-msg-head"><b>{r.series} {r.edition_number ? `#${String(r.edition_number).padStart(2, '0')}` : ''}</b><span>{label(r.funding_status)} · {label(r.acceptance_status)}</span></div></div>
            ))}
          </section>
        )}

        <section className="cs-rec-sec">
          <h3>All columns</h3>
          <table className="cs-raw">
            <tbody>
              {Object.keys(person).map((k) => {
                const v = person[k];
                const out = v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v, null, 1) : String(v);
                return <tr key={k}><th>{k}</th><td>{out === null ? <i className="cs-null">NULL</i> : <span className="cs-pre">{out.length > 1200 ? `${out.slice(0, 1200)}…` : out}</span>}</td></tr>;
              })}
            </tbody>
          </table>
        </section>
      </div>
    </aside>
  );
}

/** The enrichment, in whichever shape it was written: v2 (open research, free findings) or v1 (fixed fields). */
function Research({ person, enr }: { person: SheetPerson; enr: Record<string, unknown> | null }) {
  const status = person.enrichment_status;
  if (!enr || status === 'skipped') {
    return <section className="cs-rec-sec"><h3>Research</h3><p className="cs-note">{status === 'skipped' ? 'Not researched (team or test row).' : status === 'running' ? 'Being researched now.' : status === 'failed' ? 'Research failed; it will not retry on its own.' : 'Waiting to be researched.'}</p></section>;
  }
  const identity = enr.identity as { match?: string; reason?: string } | undefined;
  const findings = Array.isArray(enr.findings) ? (enr.findings as { finding: string; confidence: string; source: string }[]) : null;
  const sources = Array.isArray(enr.sources) ? (enr.sources as { url: string; what?: string; supports?: string }[]) : [];
  const unknowns = Array.isArray(enr.unknowns) ? (enr.unknowns as string[]) : [];
  const v1 = !findings ? ([
    ['Role', enr.role], ['Company', enr.company], ['About the company', enr.company_about], ['Location', enr.location], ['Lane', enr.lane], ['Why', enr.lane_reason],
    ['Fit', enr.fit], ['Fit reason', enr.fit_reason], ['Approach', enr.suggested_approach], ['Watch out', enr.watch_outs], ['Signals', enr.signals],
  ] as [string, unknown][]).filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) : [];
  const fieldText = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : (x as { value?: string; text?: string })?.value ?? (x as { text?: string })?.text ?? JSON.stringify(x))).join('; ') : typeof v === 'object' && v ? ((v as { value?: string }).value ?? JSON.stringify(v)) : String(v));
  return (
    <section className="cs-rec-sec">
      <h3>Research {identity?.match && <em className={`cs-conf c-${identity.match}`}>{label(identity.match)}</em>}<span>{person.enriched_at ? ago(person.enriched_at) : ''}</span></h3>
      {person.enrichment_summary && <p className="cs-pre">{person.enrichment_summary}</p>}
      {identity?.reason && <p className="cs-note">{identity.reason}</p>}
      {findings && findings.length > 0 && (
        <ul className="cs-findings">
          {findings.map((f, i) => (
            <li key={i}><em className={`cs-conf c-${f.confidence}`}>{f.confidence}</em><span>{f.finding}</span>{f.source && /^https?:/i.test(f.source) && <a href={f.source} target="_blank" rel="noreferrer">source</a>}</li>
          ))}
        </ul>
      )}
      {v1.length > 0 && <dl className="cs-v1">{v1.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{fieldText(v)}</dd></div>)}</dl>}
      {unknowns.length > 0 && <p className="cs-note">Unknown: {unknowns.join(' · ')}</p>}
      {sources.length > 0 && (
        <ol className="cs-sources">
          {sources.map((s, i) => <li key={i}><a href={s.url} target="_blank" rel="noreferrer">{s.url.replace(/^https?:\/\/(www\.)?/i, '').slice(0, 70)}</a>{(s.what || s.supports) && <span> · {s.what ?? s.supports}</span>}</li>)}
        </ol>
      )}
    </section>
  );
}

/* ─── bits ──────────────────────────────────────────── */

function XGlyph() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>;
}
function OpenGlyph() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>;
}
