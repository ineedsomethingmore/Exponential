import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Person } from './types';
import { shortName } from './types';
import { toISO, todayISO } from './dates';
import { appIdle } from './idle';
import {
  arrivedWithin, askCrm, cameFrom, dueBy, fetchHistory, fetchRecord, fetchSheet, notContacted, ourTurn, subscribeSheet, writePatch, writeSaid,
  type Change, type ChatTurn, type LastWords, type RecordDetail, type SheetData, type SheetPerson,
} from './crmSheet';

/**
 * CRM: one page. Left, today's list and the chat with the CRM agent; right, every person as a spreadsheet, live on
 * crm_people. One CRM, no owner and no assignment: anyone updates anything, by hand or through the chat; the latest
 * change wins. Every column is editable and writes to the database; ⌘Z / ⌘⇧Z undo and redo this session's edits
 * (the sheet's, the record's and the chat's), and the record lists every change with its own Undo. The sheet is
 * built for people to read: a short default set of columns (more under "Columns"), human labels, no system values.
 *
 * Sheet, in the manner of Supabase's table editor: drag a header edge to resize (remembered per machine); click a
 * cell to select it, and a cut-off value shows in full under it; double-click or Enter to edit (text in place,
 * long text, choices and dates in a small editor); arrows move, Tab and Enter commit and move, Escape cancels,
 * Backspace clears, Space opens the person's record, ⌘C copies.
 *
 * The chat is a conversation: the agent shows what it is doing while it works, what it changed (with Undo), and
 * asks when something is unclear; the next message is read as the answer. Kept per machine, per team.
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
  /** The app's ⌘Z / ⌘⇧Z (Edit menu or keydown) lands here while the CRM is open. */
  undoRef?: React.MutableRefObject<((kind: 'undo' | 'redo') => void) | null>;
}

/* ── vocabularies, as people read them ── */
type Opt = [value: string, label: string];
const CUSTOMER: Opt[] = [['lead', 'New'], ['engaged', 'In conversation'], ['visiting', 'Visit planned'], ['deposit_pending', 'Deposit pending'], ['deposit_paid', 'Deposit paid'], ['accepted', 'Accepted'], ['closed', 'Closed'], ['delivered', 'Delivered'], ['on_hold', 'On hold'], ['cancelled', 'Cancelled'], ['refunded', 'Refunded']];
const INVESTOR: Opt[] = [['new', 'New'], ['intro', 'Intro'], ['meeting', 'Meeting'], ['diligence', 'Diligence'], ['invested', 'Invested'], ['passed', 'Passed'], ['parked', 'Parked']];
const CONTRIBUTOR: Opt[] = [['new', 'New'], ['in_conversation', 'In conversation'], ['active', 'Active'], ['parked', 'Parked']];
const KINDS: Opt[] = [['partner', 'Partner'], ['engineer', 'Engineer'], ['creator', 'Creator'], ['media', 'Media'], ['other', 'Other']];
const STEPS: Opt[] = [['email', 'Email'], ['call', 'Call'], ['sms', 'Text'], ['visit', 'Visit'], ['meeting', 'Meeting'], ['reply', 'Reply'], ['other', 'Other']];
const TYPES: Opt[] = [['customer', 'Customer'], ['investor', 'Investor'], ['contributor', 'Contributor'], ['other', 'Other']];
const TAGS: Record<string, string> = { icp1: 'ICP 1', wants_visit: 'Wants a visit', wants_call: 'Wants a call', urgent: 'Urgent', foreign: 'Outside the US', duplicate: 'Duplicate', honeypot: 'Bot trap', honeypot_suspect: 'Possible bot', do_not_contact_request: 'Asked not to be contacted', unsubscribe_request: 'Unsubscribed' };
const STAGE_OF = { customer: { col: 'customer_stage', opts: CUSTOMER }, investor: { col: 'investor_stage', opts: INVESTOR }, contributor: { col: 'contributor_stage', opts: CONTRIBUTOR } } as const;
type TypeKey = keyof typeof STAGE_OF;
const optLabel = (opts: Opt[], v: unknown) => opts.find((o) => o[0] === v)?.[1] ?? (v ? String(v).replace(/_/g, ' ') : '');
/** The type whose stage the Stage column shows: customer first, then investor, then contributor. */
const primaryType = (p: SheetPerson): TypeKey | null => {
  const t = p.types ?? [];
  return t.includes('customer') ? 'customer' : t.includes('investor') ? 'investor' : t.includes('contributor') ? 'contributor' : p.customer_stage ? 'customer' : null;
};

/* ── columns ── */
type Kind = 'text' | 'long' | 'link' | 'email' | 'date' | 'stamp' | 'select' | 'stage' | 'types' | 'tags' | 'bool' | 'ro';
interface Col { key: string; label: string; w: number; kind: Kind; options?: Opt[]; optional?: boolean }
/** Default columns first; the optional ones live under "Columns" and in every record. */
const COLS: Col[] = [
  { key: 'name', label: 'Name', w: 180, kind: 'text' },
  { key: 'types', label: 'Type', w: 168, kind: 'types' },
  { key: '_stage', label: 'Stage', w: 128, kind: 'stage' },
  { key: 'next_action', label: 'Next step', w: 250, kind: 'long' },
  { key: 'next_action_due', label: 'Due', w: 84, kind: 'date' },
  { key: 'last_outbound_at', label: 'Last contact', w: 112, kind: 'stamp' },
  { key: '_who', label: 'Who', w: 230, kind: 'text' },
  { key: '_said', label: 'Their message', w: 240, kind: 'long' },
  { key: 'notes', label: 'Notes', w: 220, kind: 'long' },
  { key: 'email_normalized', label: 'Email', w: 200, kind: 'email' },
  { key: 'phone_as_typed', label: 'Phone', w: 130, kind: 'text' },
  { key: '_from', label: 'Came from', w: 150, kind: 'text' },
  { key: 'source_at', label: 'Arrived', w: 84, kind: 'stamp' },
  { key: 'company', label: 'Company', w: 150, kind: 'text', optional: true },
  { key: 'job_title', label: 'Title', w: 150, kind: 'text', optional: true },
  { key: 'location_text', label: 'Location', w: 130, kind: 'text', optional: true },
  { key: 'linkedin_url', label: 'LinkedIn', w: 170, kind: 'link', optional: true },
  { key: 'x_handle', label: 'X', w: 110, kind: 'text', optional: true },
  { key: 'next_action_kind', label: 'Step kind', w: 90, kind: 'select', options: STEPS, optional: true },
  { key: 'customer_stage', label: 'Customer stage', w: 128, kind: 'select', options: CUSTOMER, optional: true },
  { key: 'investor_stage', label: 'Investor stage', w: 118, kind: 'select', options: INVESTOR, optional: true },
  { key: 'investor_firm', label: 'Investor firm', w: 140, kind: 'text', optional: true },
  { key: 'investor_notes', label: 'Investor notes', w: 220, kind: 'long', optional: true },
  { key: 'contributor_kind', label: 'Contributor kind', w: 124, kind: 'select', options: KINDS, optional: true },
  { key: 'contributor_stage', label: 'Contributor stage', w: 132, kind: 'select', options: CONTRIBUTOR, optional: true },
  { key: 'summary', label: 'Summary', w: 280, kind: 'long', optional: true },
  { key: '_tags', label: 'Tags', w: 150, kind: 'tags', optional: true },
  { key: 'last_inbound_at', label: 'Last message', w: 104, kind: 'stamp', optional: true },
  { key: 'do_not_contact', label: 'Do not contact', w: 108, kind: 'bool', optional: true },
];
const COL = Object.fromEntries(COLS.map((c) => [c.key, c])) as Record<string, Col>;
/** What a changed column is called where the history, the chat and undo name it. */
const EXTRA_LABELS: Record<string, string> = { enrichment_headline: 'Who', attribution: 'Came from', flags: 'Tags', emails: 'Emails', first_name: 'First name', last_name: 'Last name', text_body: 'Their message' };
const labelOf = (k: string) => COL[k]?.label ?? EXTRA_LABELS[k] ?? k.replace(/_/g, ' ');
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const editable = (c: Col) => c.kind !== 'ro';
const inlineText = (c: Col) => c.kind === 'text' || c.kind === 'link' || c.kind === 'email';
const DEFAULT_VISIBLE = COLS.filter((c) => !c.optional).map((c) => c.key);

/* ── per-machine view settings (widths, visible columns); browser storage may be unavailable ── */
const VIEW_KEY = 'exponential-crm-view-v1';
const loadView = (): { widths: Record<string, number>; visible: string[] } => {
  try { const v = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null'); if (v && typeof v === 'object') return { widths: v.widths ?? {}, visible: Array.isArray(v.visible) ? v.visible.filter((k: string) => COL[k]) : DEFAULT_VISIBLE }; } catch { /* no storage */ }
  return { widths: {}, visible: DEFAULT_VISIBLE };
};
const saveView = (v: { widths: Record<string, number>; visible: string[] }) => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(v)); } catch { /* no storage */ } };

/* The four counters on the left (iain, 7 Oct: the pills above the sheet went, these stay) filter the sheet. */
type Filter = 'all' | 'due' | 'ourTurn' | 'new' | 'notContacted';
const FILTER_NAMES: Record<Filter, string> = { all: 'Everyone', due: 'Due', ourTurn: 'Our turn', new: 'New 48h', notContacted: 'Not contacted' };
type TypeFilter = 'any' | TypeKey | 'other' | 'none';
const TYPE_FILTERS: { k: TypeFilter; t: string }[] = [
  { k: 'any', t: 'Type filter' }, { k: 'customer', t: 'Customers' }, { k: 'investor', t: 'Investors' }, { k: 'contributor', t: 'Contributors' }, { k: 'other', t: 'Other' }, { k: 'none', t: 'No type yet' },
];
const typePass = (x: SheetPerson, t: TypeFilter) => (t === 'any' ? true : t === 'none' ? !(x.types ?? []).length : (x.types ?? []).includes(t));

/* ── formatting ── */
const thisYear = new Date().getFullYear();
const fmtDay = (d?: string | null) => {
  if (!d || d.length < 10) return '';
  const [y, m, dd] = d.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, dd).toLocaleDateString([], y === thisYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: '2-digit' });
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
const who = (p: SheetPerson) => p.enrichment_headline || [p.job_title, p.company].filter(Boolean).join(', ');

interface Ctx { said: Record<string, LastWords> }
/** The full text of a cell as a person reads it (also what ⌘C copies and the peek shows). */
function text(p: SheetPerson, c: Col, ctx: Ctx): string {
  switch (c.key) {
    case '_stage': { const t = primaryType(p); return t ? optLabel(STAGE_OF[t].opts, p[STAGE_OF[t].col]) : ''; }
    case '_who': return who(p);
    case '_said': return ctx.said[p.id]?.text ?? '';
    case '_from': return cameFrom(p);
    case '_tags': return (p.flags ?? []).map((f) => TAGS[f]).filter(Boolean).join(', ');
    case 'types': return (p.types ?? []).map((t) => optLabel(TYPES, t) + (t === 'contributor' && p.contributor_kind ? ` (${optLabel(KINDS, p.contributor_kind)})` : '')).join(', ');
    case 'source_at': case 'last_inbound_at': case 'last_outbound_at': return fmtStamp(p[c.key] as string | null);
    case 'next_action_due': return fmtDay(p.next_action_due);
    case 'next_action': return p.next_action ? [p.next_action_kind ? optLabel(STEPS, p.next_action_kind) : '', p.next_action].filter(Boolean).join(': ') : '';
    case 'do_not_contact': return p.do_not_contact ? 'Yes' : '';
  }
  const v = p[c.key];
  if (v === null || v === undefined || v === '') return '';
  if (c.kind === 'select') return optLabel(c.options ?? [], v);
  return Array.isArray(v) ? v.join(', ') : String(v).replace(/\s+/g, ' ').trim();
}
/** The value an editor starts from (for the derived columns, what the cell shows). */
function editValue(p: SheetPerson, c: Col, ctx: Ctx): unknown {
  switch (c.key) {
    case '_who': return who(p) || null;
    case '_from': return cameFrom(p) || null;
    case '_said': return ctx.said[p.id]?.text || null;
    case '_tags': return (p.flags ?? []).filter((f) => TAGS[f]);
    case '_stage': { const t = primaryType(p); return t ? `${t}:${p[STAGE_OF[t].col] ?? ''}` : null; }
  }
  return p[c.key] ?? null;
}
function sortKey(p: SheetPerson, c: Col, ctx: Ctx): string | number {
  if (c.key === '_said') return ctx.said[p.id]?.at ? +new Date(ctx.said[p.id].at) : 0;
  if (['source_at', 'last_inbound_at', 'last_outbound_at'].includes(c.key)) return p[c.key] ? +new Date(String(p[c.key])) : '';
  if (c.key === 'next_action_due') return p.next_action_due ?? '';
  if (c.key === '_stage') { const t = primaryType(p); return t ? `${t}:${String(STAGE_OF[t].opts.findIndex((o) => o[0] === p[STAGE_OF[t].col])).padStart(2, '0')}` : ''; }
  return text(p, c, ctx).toLowerCase();
}

export function CrmPage(p: Props) {
  const { teamId, me, people, cloud } = p;
  const [data, setData] = useState<SheetData>({ people: [], said: {}, loaded: false });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('any');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'source_at', dir: -1 });
  const [sel, setSel] = useState<{ id: string; key: string } | null>(null);
  const [edit, setEdit] = useState<{ id: string; key: string; initial?: string } | null>(null);
  const [recordId, setRecordId] = useState<string | null>(null);
  const [view, setView] = useState(loadView);
  const [colsOpen, setColsOpen] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const [, tick] = useState(0);

  const cols = useMemo(() => COLS.filter((c) => c.key === 'name' || view.visible.includes(c.key)), [view.visible]);
  const width = (c: Col) => view.widths[c.key] ?? c.w;
  const setWidth = (key: string, w: number) => setView((v) => { const n = { ...v, widths: { ...v.widths, [key]: Math.round(Math.max(56, Math.min(900, w))) } }; saveView(n); return n; });
  const toggleCol = (key: string) => setView((v) => { const vis = v.visible.includes(key) ? v.visible.filter((k) => k !== key) : [...v.visible, key]; const n = { ...v, visible: COLS.map((c) => c.key).filter((k) => vis.includes(k)) }; saveView(n); return n; });

  const load = () => fetchSheet(teamId, cloud).then((d) => { setData(d); setLoadError(null); }).catch((e) => { const m = String((e as Error).message ?? e); setLoadError(m); p.onError(`CRM: ${m}`); });
  useEffect(() => {
    setData({ people: [], said: {}, loaded: false }); setSel(null); setEdit(null); setRecordId(null);
    load();
    const unsub = subscribeSheet(teamId, cloud, {
      person: (row, oldId) => setData((d) => {
        const rest = d.people.filter((x) => x.id !== (row?.id ?? oldId));
        return { ...d, people: row && !row.merged_into ? [row, ...rest] : rest };
      }),
      words: (pid, w) => setData((d) => (d.said[pid] && d.said[pid].at >= w.at ? d : { ...d, said: { ...d.said, [pid]: w } })),
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

  const ctx: Ctx = useMemo(() => ({ said: data.said }), [data.said]);
  const today = todayISO();
  const visible = useMemo(() => data.people.filter((x) => !(x.flags ?? []).includes('test')), [data.people]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^@/, '');
    const col = COL[sort.key] ?? COLS[0];
    const hit = (x: SheetPerson) => !q || [x.name, x.email_normalized, x.company, x.job_title, x.x_handle, x.phone_as_typed, x.notes, x.next_action, x.enrichment_headline, data.said[x.id]?.text]
      .some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
    const pass = (x: SheetPerson) =>
      filter === 'all' ? true : filter === 'due' ? dueBy(x, today) : filter === 'ourTurn' ? ourTurn(x) : filter === 'new' ? arrivedWithin(x, 48) : notContacted(x);
    return visible.filter((x) => pass(x) && typePass(x, typeFilter) && hit(x)).sort((a, b) => {
      const ka = sortKey(a, col, ctx), kb = sortKey(b, col, ctx);
      if (ka === '' && kb !== '') return 1; // empty cells sink, whichever way the sort runs
      if (kb === '' && ka !== '') return -1;
      if (ka === kb) return +new Date(b.source_at) - +new Date(a.source_at);
      return (ka < kb ? -1 : 1) * sort.dir;
    });
  }, [visible, filter, typeFilter, query, sort, data.said, today]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => ({
    all: visible.length,
    due: visible.filter((x) => dueBy(x, today)).length,
    ourTurn: visible.filter(ourTurn).length,
    new: visible.filter((x) => arrivedWithin(x, 48)).length,
    notContacted: visible.filter(notContacted).length,
  }), [visible, today]);

  /* ── writing, and this session's undo / redo ── */
  type Op = { t: 'person'; id: string; before: Record<string, unknown>; after: Record<string, unknown> } | { t: 'said'; id: string; before: string | null; after: string | null };
  const dataRef = useRef(data);
  dataRef.current = data;
  const undoStack = useRef<Op[][]>([]);
  const redoStack = useRef<Op[][]>([]);
  const remember = (ops: Op[]) => {
    if (!ops.length) return;
    undoStack.current.push(ops);
    if (undoStack.current.length > 100) undoStack.current.shift();
    redoStack.current = [];
  };
  const commit = (person: SheetPerson, patch: Record<string, unknown>, track = true) => {
    const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => !same(person[k], v)));
    if (!Object.keys(changed).length) return;
    const before = Object.fromEntries(Object.keys(changed).map((k) => [k, person[k] ?? null]));
    if (track) remember([{ t: 'person', id: person.id, before, after: changed }]);
    setData((d) => ({ ...d, people: d.people.map((x) => (x.id === person.id ? { ...x, ...changed } : x)) }));
    writePatch(teamId, me, person, changed)
      .then((row) => setData((d) => ({ ...d, people: d.people.map((x) => (x.id === row.id ? row : x)) })))
      .catch((e) => {
        setData((d) => ({ ...d, people: d.people.map((x) => (x.id === person.id ? { ...x, ...before } : x)) }));
        p.onError(`Not saved: ${String((e as Error).message ?? e)}`);
      });
  };
  /** "Their message": the text of the person's latest submission. */
  const saveSaid = (person: SheetPerson, value: string | null, track = true) => {
    const w = dataRef.current.said[person.id];
    const before = w?.text || null;
    if ((value || null) === before) return;
    if (track) remember([{ t: 'said', id: person.id, before, after: value || null }]);
    const put = (x: LastWords | null) => setData((d) => { const said = { ...d.said }; if (x && x.text) said[person.id] = x; else delete said[person.id]; return { ...d, said }; });
    put({ at: w?.at ?? new Date().toISOString(), text: value ?? '', channel: w?.channel ?? '', id: w?.id });
    writeSaid(teamId, me, person.id, w?.id ?? null, before, value || null)
      .then((x) => put(x))
      .catch((e) => { put(w ?? null); p.onError(`Not saved: ${String((e as Error).message ?? e)}`); });
  };
  /** Put a recorded change back (undo) or forward again (redo). A field someone changed since is left alone. */
  const replay = (ops: Op[], dir: 'undo' | 'redo') => {
    const stale: string[] = [];
    for (const op of ops) {
      const want = dir === 'undo' ? op.before : op.after;
      const was = dir === 'undo' ? op.after : op.before;
      const person = dataRef.current.people.find((x) => x.id === op.id);
      if (!person) continue;
      if (op.t === 'said') {
        const cur = dataRef.current.said[op.id]?.text || null;
        if (cur === (was as string | null)) saveSaid(person, want as string | null, false);
        else if (cur !== want) stale.push('Their message');
        continue;
      }
      const patch: Record<string, unknown> = {};
      for (const k of Object.keys(want as Record<string, unknown>)) {
        if (same(person[k], (was as Record<string, unknown>)[k])) patch[k] = (want as Record<string, unknown>)[k];
        else if (!same(person[k], (want as Record<string, unknown>)[k])) stale.push(labelOf(k));
      }
      if (Object.keys(patch).length) commit(person, patch, false);
    }
    if (stale.length) p.onError(`Left as it is (changed since): ${[...new Set(stale)].join(', ')}`);
  };
  const undo = () => { const ops = undoStack.current.pop(); if (!ops) return; replay(ops, 'undo'); redoStack.current.push(ops); };
  const redo = () => { const ops = redoStack.current.pop(); if (!ops) return; replay(ops, 'redo'); undoStack.current.push(ops); };
  if (p.undoRef) p.undoRef.current = (kind) => (kind === 'undo' ? undo() : redo());
  useEffect(() => () => { if (p.undoRef) p.undoRef.current = null; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  /** What the chat agent changed, as one undo step (⌘Z takes back the whole turn). */
  const chatOps = (t: ChatTurn): Op[] => (t.applied ?? []).filter((a) => a.changes?.length).map((a) => ({
    t: 'person', id: a.person_id,
    before: Object.fromEntries((a.changes ?? []).map((c) => [c.field, c.before])),
    after: Object.fromEntries((a.changes ?? []).map((c) => [c.field, c.after])),
  }));

  /** A column's new value as a patch: Stage writes the primary type's stage (and adds that type to an untyped
   *  person); email keeps the address list in step; the derived columns write where their value lives. */
  const patchFor = (person: SheetPerson, key: string, value: unknown): Record<string, unknown> => {
    if (key === '_stage') {
      const [t, v] = String(value ?? '').split(':') as [TypeKey, string];
      if (!value || !STAGE_OF[t]) { const pt = primaryType(person); return pt ? { [STAGE_OF[pt].col]: null } : {}; }
      return (person.types ?? []).includes(t) ? { [STAGE_OF[t].col]: v } : { [STAGE_OF[t].col]: v, types: [...(person.types ?? []), t] };
    }
    if (key === 'next_action' && value && typeof value === 'object' && (value as { __next?: boolean }).__next) {
      const v = value as { text: unknown; kind: unknown };
      return { next_action: v.text ?? null, next_action_kind: v.text ? v.kind ?? null : null };
    }
    if (key === 'email_normalized') {
      const e = String(value ?? '').trim().toLowerCase() || null;
      return { email_normalized: e, emails: e ? [e, ...(person.emails ?? []).filter((x) => x.toLowerCase() !== e)] : person.emails ?? [] };
    }
    if (key === 'name') { // first and last name follow it (the email templates greet by first name)
      const parts = String(value ?? '').trim().split(/\s+/).filter(Boolean);
      return { name: value, first_name: parts[0] ?? null, last_name: parts.slice(1).join(' ') || null };
    }
    if (key === '_who') return { enrichment_headline: value };
    if (key === '_from') {
      const a = { ...((person.attribution ?? {}) as Record<string, unknown>) };
      if (value) a.label = value; else delete a.label;
      return { attribution: a };
    }
    if (key === '_tags') return { flags: [...(person.flags ?? []).filter((f) => !TAGS[f]), ...((value as string[] | null) ?? [])] };
    return { [key]: value };
  };
  const save = (person: SheetPerson, key: string, value: unknown) => {
    if (key === '_said') { saveSaid(person, (value as string | null) ?? null); return; }
    if (key !== '_stage' && same(value, editValue(person, COL[key] ?? { key, label: key, w: 0, kind: 'text' }, ctx))) return; // nothing changed
    commit(person, patchFor(person, key, value));
  };

  /* ── keyboard and selection ── */
  const focusGrid = () => gridRef.current?.focus({ preventScroll: true });
  const cellEl = (id: string, key: string) => gridRef.current?.querySelector(`[data-cell="${id}:${key}"]`) as HTMLElement | null;
  const reveal = (id: string, key: string) => requestAnimationFrame(() => cellEl(id, key)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  const moveSel = (dr: number, dc: number) => {
    if (!sel) { if (rows[0]) setSel({ id: rows[0].id, key: cols[0].key }); return; }
    const r = Math.max(0, Math.min(rows.length - 1, rows.findIndex((x) => x.id === sel.id) + dr));
    const c = Math.max(0, Math.min(cols.length - 1, cols.findIndex((x) => x.key === sel.key) + dc));
    if (!rows[r]) return;
    setSel({ id: rows[r].id, key: cols[c].key });
    reveal(rows[r].id, cols[c].key);
  };
  const startEdit = (id: string, key: string, initial?: string) => {
    const col = COL[key];
    const person = rows.find((x) => x.id === id);
    if (!person || !editable(col)) return;
    if (col.kind === 'bool') { save(person, key, !person[key]); return; }
    setSel({ id, key });
    setEdit({ id, key, initial });
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (edit || e.target !== gridRef.current) return; // the editor owns its keys
    const k = e.key;
    if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === 'z') { e.preventDefault(); e.nativeEvent.stopPropagation(); if (e.shiftKey) redo(); else undo(); return; }
    if (k === 'ArrowDown') { e.preventDefault(); moveSel(1, 0); return; }
    if (k === 'ArrowUp') { e.preventDefault(); moveSel(-1, 0); return; }
    if (k === 'ArrowRight' || (k === 'Tab' && !e.shiftKey)) { e.preventDefault(); moveSel(0, 1); return; }
    if (k === 'ArrowLeft' || (k === 'Tab' && e.shiftKey)) { e.preventDefault(); moveSel(0, -1); return; }
    if (!sel) return;
    const col = COL[sel.key];
    const person = rows.find((x) => x.id === sel.id);
    if (!person) return;
    if (k === 'Enter' || k === 'F2') { e.preventDefault(); startEdit(sel.id, sel.key); return; }
    if (k === ' ') { e.preventDefault(); setRecordId(sel.id); return; }
    if (k === 'Escape') { if (recordId) setRecordId(null); else setSel(null); return; }
    if ((k === 'Backspace' || k === 'Delete') && editable(col) && col.kind !== 'bool') { e.preventDefault(); save(person, sel.key, col.kind === 'types' || col.kind === 'tags' ? [] : null); return; }
    if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === 'c') { e.preventDefault(); navigator.clipboard?.writeText(text(person, col, ctx)).catch(() => {}); return; }
    if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && (inlineText(col) || col.kind === 'long')) { e.preventDefault(); startEdit(sel.id, sel.key, k); }
  };
  const done = (move?: 'down' | 'right' | 'left') => {
    setEdit(null);
    if (move === 'down') moveSel(1, 0); else if (move === 'right') moveSel(0, 1); else if (move === 'left') moveSel(0, -1);
    focusGrid();
  };

  /* The peek: a selected cell whose value is cut off shows in full just under it (Supabase-style, one click). */
  const [peek, setPeek] = useState<{ rect: DOMRect; text: string } | null>(null);
  useLayoutEffect(() => {
    setPeek(null);
    if (!sel || edit) return;
    const td = cellEl(sel.id, sel.key);
    const v = td?.querySelector('.cs-v') as HTMLElement | null;
    const person = rows.find((x) => x.id === sel.id);
    if (!td || !v || !person) return;
    const full = text(person, COL[sel.key], ctx);
    if (full && v.scrollWidth > v.clientWidth + 1) setPeek({ rect: td.getBoundingClientRect(), text: full });
  }, [sel?.id, sel?.key, edit, data.people, view.widths]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const wrap = gridRef.current;
    if (!wrap || !peek) return;
    const hide = () => setPeek(null);
    wrap.addEventListener('scroll', hide, { passive: true });
    return () => wrap.removeEventListener('scroll', hide);
  }, [peek]);

  const openRecord = (id: string) => { setRecordId(id); const key = sel?.id === id ? sel.key : 'name'; setSel({ id, key }); reveal(id, key); };
  const record = recordId ? data.people.find((x) => x.id === recordId) ?? null : null;
  const editing = edit ? rows.find((x) => x.id === edit.id) ?? null : null;
  const editCol = edit ? COL[edit.key] : null;

  /* Column resize: drag the right edge of a header. */
  const startResize = (e: React.PointerEvent, c: Col) => {
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX, w0 = width(c);
    const move = (ev: PointerEvent) => setWidth(c.key, w0 + ev.clientX - x0);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="crm cs">
      <Overview data={data} visible={visible} today={today} cloud={cloud} teamId={teamId} ctx={ctx} onError={p.onError}
        scope={record ? { id: record.id, name: nameOf(record) } : null}
        onApplied={(t) => remember(chatOps(t))} onUndoTurn={(t) => replay(chatOps(t), 'undo')}
        counts={counts} filter={filter} onFilter={(f) => { setFilter(f); setQuery(''); }}
        onPerson={(id) => { setFilter('all'); setTypeFilter('any'); setQuery(''); openRecord(id); }} />
      <section className="cs-main">
        <header className="cs-bar">
          <input className="cs-search" placeholder="Search name, email, company, notes…" value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); focusGrid(); } if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); if (rows[0]) setSel({ id: rows[0].id, key: 'name' }); focusGrid(); } }} />
          <select className={`cs-type${typeFilter !== 'any' ? ' on' : ''}`} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as TypeFilter)} aria-label="Type filter">
            {TYPE_FILTERS.map((t) => <option key={t.k} value={t.k}>{t.k === 'any' ? t.t : `${t.t} (${visible.filter((x) => typePass(x, t.k)).length})`}</option>)}
          </select>
          <span className="cs-count">{rows.length === visible.length ? `${visible.length} people` : `${rows.length} of ${visible.length}`}</span>
          {filter !== 'all' && <button className="cs-filter on" title="Show everyone" onClick={() => setFilter('all')}>{FILTER_NAMES[filter]}<span>×</span></button>}
          <span className="panel-spacer" />
          <div className="cs-cols-wrap">
            <button className={`cs-filter${colsOpen ? ' on' : ''}`} onClick={() => setColsOpen((o) => !o)}>Columns<span>{cols.length}</span></button>
            {colsOpen && (
              <div className="cs-cols" onMouseLeave={() => setColsOpen(false)}>
                {COLS.filter((c) => c.key !== 'name').map((c) => (
                  <label key={c.key}><input type="checkbox" checked={view.visible.includes(c.key)} onChange={() => toggleCol(c.key)} />{c.label}</label>
                ))}
                <button className="cs-cols-reset" onClick={() => { const n = { widths: {}, visible: DEFAULT_VISIBLE }; saveView(n); setView(n); }}>Reset columns and widths</button>
              </div>
            )}
          </div>
          <span className={`cs-live${live ? ' on' : ''}`} title={live ? 'Live: every change in the database shows here as it happens' : 'Not connected'}>{live ? 'Live' : 'Offline'}</span>
          <button className="icon-btn" title="Close CRM" aria-label="Close CRM" onClick={p.onClose}><XGlyph /></button>
        </header>
        {!cloud && <div className="cs-empty">Sign in to see the CRM. It reads the team's live database.</div>}
        {cloud && loadError && !data.loaded && <div className="cs-empty">Couldn't load the CRM: {loadError} <button className="pill small" onClick={load}>Retry</button></div>}
        {cloud && (
          <div className="cs-grid-wrap" ref={gridRef} tabIndex={0} onKeyDown={onKey} role="grid" aria-rowcount={rows.length}
            style={{ scrollPaddingLeft: 44 + width(COL.name), scrollPaddingTop: 32 }}>
            <table className="cs-grid" style={{ width: 44 + cols.reduce((sum, c) => sum + width(c), 0) }}>
              <colgroup><col style={{ width: 44 }} />{cols.map((c) => <col key={c.key} style={{ width: width(c) }} />)}</colgroup>
              <thead>
                <tr>
                  <th className="cs-num">#</th>
                  {cols.map((c, i) => (
                    <th key={c.key} className={`${i === 0 ? 'cs-sticky ' : ''}${editable(c) ? '' : 'ro'}`}
                      onClick={() => setSort((s) => (s.key === c.key ? { key: c.key, dir: (s.dir * -1) as 1 | -1 } : { key: c.key, dir: ['source_at', 'last_outbound_at', 'last_inbound_at', '_said'].includes(c.key) ? -1 : 1 }))}>
                      <span>{c.label}</span>{sort.key === c.key && <i>{sort.dir === 1 ? '↑' : '↓'}</i>}
                      <span className="cs-resize" title="Drag to resize" onPointerDown={(e) => startResize(e, c)} onClick={(e) => e.stopPropagation()} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((x, r) => (
                  <Row key={x.id} person={x} n={r + 1} ctx={ctx} cols={cols} said={data.said[x.id]} today={today}
                    selKey={sel?.id === x.id ? sel.key : null} editKey={edit?.id === x.id && edit && inlineText(COL[edit.key]) ? edit.key : null}
                    initial={edit?.id === x.id ? edit.initial : undefined} open={recordId === x.id}
                    onSelect={(key) => { setSel({ id: x.id, key }); if (edit && (edit.id !== x.id || edit.key !== key)) setEdit(null); }}
                    onEdit={(key) => startEdit(x.id, key)}
                    onOpen={() => openRecord(x.id)}
                    onInlineDone={(key, v, move) => { if (v !== undefined) save(x, key, v); done(move); }} />
                ))}
              </tbody>
            </table>
            {data.loaded && rows.length === 0 && <div className="cs-empty">{query ? `Nobody matches “${query}”.` : 'Nobody here.'}</div>}
            {!data.loaded && !loadError && <div className="cs-empty">Loading…</div>}
          </div>
        )}
        {record && (
          <RecordPanel key={record.id} person={record} said={data.said[record.id]} people={people} cloud={cloud} ctx={ctx}
            onClose={() => { setRecordId(null); focusGrid(); }} onSave={(key, v) => save(record, key, v)} onUndo={(patch) => commit(record, patch)} onError={p.onError} />
        )}
      </section>
      {editing && editCol && !inlineText(editCol) && (
        <Popover anchor={cellEl(editing.id, editCol.key)}>
          <FieldEditor col={editCol} person={editing} value={editValue(editing, editCol, ctx)} initial={edit?.initial} onDone={(v, move) => { if (v !== undefined) save(editing, editCol.key, v); done(move); }} />
        </Popover>
      )}
      {peek && !edit && createPortal(
        <div className="cs-peek" style={{ left: Math.min(peek.rect.left, window.innerWidth - 440), top: peek.rect.bottom + 2, minWidth: Math.min(peek.rect.width, 420) }}>{peek.text}</div>,
        document.body,
      )}
    </div>
  );
}

/* ─── the daily overview ────────────────────────────── */

function Overview({ data, visible, today, cloud, teamId, ctx, scope, counts, filter, onFilter, onError, onPerson, onApplied, onUndoTurn }: {
  data: SheetData; visible: SheetPerson[]; today: string; cloud: boolean; teamId: string; ctx: Ctx; scope: { id: string; name: string } | null;
  counts: Record<Filter, number>; filter: Filter; onFilter: (f: Filter) => void;
  onError: (m: string) => void; onPerson: (id: string) => void; onApplied: (t: ChatTurn) => void; onUndoTurn: (t: ChatTurn) => void;
}) {
  // Each person appears once, in the first section that fits: what is due, whose turn it is, who is new, who is waiting.
  const seen = new Set<string>();
  const take = (list: SheetPerson[]) => list.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
  const byRecent = (a: SheetPerson, b: SheetPerson) => +new Date(b.last_inbound_at ?? b.source_at) - +new Date(a.last_inbound_at ?? a.source_at);
  const due = take(visible.filter((x) => dueBy(x, today)).sort((a, b) => (a.next_action_due ?? '').localeCompare(b.next_action_due ?? '')));
  const turn = take(visible.filter(ourTurn).sort(byRecent));
  const fresh = take(visible.filter((x) => arrivedWithin(x, 48)).sort(byRecent));
  const waiting = take(visible.filter(notContacted).sort(byRecent));
  const date = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const step = (x: SheetPerson) => [x.next_action_kind ? optLabel(STEPS, x.next_action_kind) : '', one(x.next_action, 90)].filter(Boolean).join(': ');
  const stats: { k: Filter; t: string }[] = [{ k: 'new', t: 'New 48h' }, { k: 'notContacted', t: 'Not contacted' }, { k: 'ourTurn', t: 'Our turn' }, { k: 'due', t: 'Due' }];
  return (
    <aside className="cs-overview">
      <div className="cs-ov-head"><h1>Today</h1><span>{date}</span></div>
      <div className="cs-stats">
        {stats.map((st) => (
          <button key={st.k} className={`cs-stat${filter === st.k ? ' on' : ''}${st.k === 'due' && counts.due ? ' hot' : ''}`} onClick={() => onFilter(filter === st.k ? 'all' : st.k)}
            title={filter === st.k ? 'Show everyone in the sheet' : `Show only ${st.t} in the sheet`}>
            <strong>{data.loaded ? counts[st.k] : '–'}</strong><span>{st.t}</span>
          </button>
        ))}
      </div>
      <div className="cs-ov-scroll">
        {!data.loaded && <div className="cs-empty">Loading…</div>}
        <OvSection title="Due" list={due} limit={6} line={(x) => step(x) || 'Next step due'} meta={(x) => fmtDay(x.next_action_due)} metaHot={(x) => (x.next_action_due ?? '') < today} onPerson={onPerson} onMore={() => onFilter('due')} />
        <OvSection title="Our turn" hint="They answered; the next word is ours" list={turn} limit={6} line={(x) => one(data.said[x.id]?.text, 90) || one(who(x), 90)} meta={(x) => ago(x.last_inbound_at)} onPerson={onPerson} onMore={() => onFilter('ourTurn')} />
        <OvSection title="New" hint="Arrived in the last 48 hours" list={fresh} limit={6} line={(x) => one(who(x), 90) || one(data.said[x.id]?.text, 90)} meta={(x) => ago(x.source_at)} onPerson={onPerson} onMore={() => onFilter('new')} />
        <OvSection title="Not contacted yet" list={waiting} limit={6} line={(x) => one(who(x), 90) || one(data.said[x.id]?.text, 90)} meta={(x) => ago(x.source_at)} onPerson={onPerson} onMore={() => onFilter('notContacted')} />
        {data.loaded && !due.length && !turn.length && !fresh.length && !waiting.length && <div className="cs-empty">Nobody is waiting on us.</div>}
      </div>
      {cloud && <ChatPanel teamId={teamId} people={data.people} ctx={ctx} scope={scope} onError={onError} onPerson={onPerson} onApplied={onApplied} onUndoTurn={onUndoTurn} />}
    </aside>
  );
}

function OvSection({ title, hint, list, limit, line, meta, metaHot, onPerson, onMore }: {
  title: string; hint?: string; list: SheetPerson[]; limit: number; line: (x: SheetPerson) => string; meta: (x: SheetPerson) => string;
  metaHot?: (x: SheetPerson) => boolean; onPerson: (id: string) => void; onMore: () => void;
}) {
  if (!list.length) return null;
  return (
    <section className="cs-ov-sec">
      <h2 title={hint}>{title} <span>{list.length}</span></h2>
      {list.slice(0, limit).map((x) => (
        <button key={x.id} className="cs-ov-row" onClick={() => onPerson(x.id)}>
          <span className="cs-ov-main"><b>{nameOf(x)}</b><em>{line(x) || x.email_normalized || ''}</em></span>
          <span className={`cs-ov-meta${metaHot?.(x) ? ' hot' : ''}`}>{meta(x)}</span>
        </button>
      ))}
      {list.length > limit && <button className="cs-ov-more" onClick={onMore}>All {list.length} in the sheet →</button>}
    </section>
  );
}

/* ─── the sheet ─────────────────────────────────────── */

const Row = memo(function Row({ person, n, ctx, cols, said, today, selKey, editKey, initial, open, onSelect, onEdit, onOpen, onInlineDone }: {
  person: SheetPerson; n: number; ctx: Ctx; cols: Col[]; said?: LastWords; today: string; selKey: string | null; editKey: string | null; initial?: string; open: boolean;
  onSelect: (key: string) => void; onEdit: (key: string) => void; onOpen: () => void; onInlineDone: (key: string, v: unknown | undefined, move?: 'down' | 'right' | 'left') => void;
}) {
  void said; // a prop only so a new message re-renders the row
  const dim = person.do_not_contact || ['cancelled', 'refunded'].includes(person.customer_stage ?? '');
  return (
    <tr className={`${selKey ? 'sel' : ''}${open ? ' open' : ''}${dim ? ' dim' : ''}`}>
      <td className="cs-num" onClick={onOpen} title="Open the record (Space)">{n}</td>
      {cols.map((c, i) => {
        const isEdit = editKey === c.key;
        return (
          <td key={c.key} data-cell={`${person.id}:${c.key}`}
            className={`${i === 0 ? 'cs-sticky ' : ''}k-${c.kind}${selKey === c.key ? ' cur' : ''}${isEdit ? ' editing' : ''}${editable(c) ? '' : ' ro'}`}
            onMouseDown={(e) => {
              if (isEdit) return;
              // an open editor elsewhere commits first (a click-away saves, as in a spreadsheet)
              const active = document.activeElement as HTMLElement | null;
              if (active?.closest('.cs-edit, .cs-pop')) active.blur();
              e.preventDefault(); onSelect(c.key);
              (e.currentTarget.closest('.cs-grid-wrap') as HTMLElement | null)?.focus({ preventScroll: true });
            }}
            onDoubleClick={() => { if (c.kind !== 'bool') onEdit(c.key); }}>
            {isEdit ? <InlineEditor col={c} value={editValue(person, c, ctx)} initial={initial} onDone={(v, move) => onInlineDone(c.key, v, move)} /> : <Cell person={person} col={c} ctx={ctx} today={today} onOpen={onOpen} onToggle={() => onEdit(c.key)} />}
          </td>
        );
      })}
    </tr>
  );
});

function Cell({ person, col, ctx, today, onOpen, onToggle }: { person: SheetPerson; col: Col; ctx: Ctx; today: string; onOpen: () => void; onToggle: () => void }) {
  const t = text(person, col, ctx);
  switch (col.key) {
    case 'name':
      return (
        <div className="cs-v cs-name">
          <span>{t || <i className="cs-null">Unnamed</i>}</span>
          {person.linkedin_url && <a className="cs-badge" href={/^https?:/i.test(person.linkedin_url) ? person.linkedin_url : `https://${person.linkedin_url}`} target="_blank" rel="noreferrer" title="LinkedIn" onMouseDown={(e) => e.stopPropagation()}>in</a>}
          {person.x_handle && <a className="cs-badge" href={`https://x.com/${person.x_handle}`} target="_blank" rel="noreferrer" title={`@${person.x_handle} on X`} onMouseDown={(e) => e.stopPropagation()}>X</a>}
          <button className="cs-open" title="Open the record (Space)" onMouseDown={(e) => e.stopPropagation()} onClick={onOpen}><OpenGlyph /></button>
        </div>
      );
    case 'types':
      return <div className="cs-v cs-chips">{(person.types ?? []).map((ty) => <span key={ty} className={`cs-chip t-${ty}`}>{optLabel(TYPES, ty)}{ty === 'contributor' && person.contributor_kind ? ` · ${optLabel(KINDS, person.contributor_kind)}` : ''}</span>)}</div>;
    case '_stage': {
      const pt = primaryType(person);
      const v = pt ? person[STAGE_OF[pt].col] : null;
      return <div className="cs-v">{v ? <span className={`cs-tag s-${String(v)}`}>{t}</span> : ''}</div>;
    }
    case 'next_action':
      return <div className="cs-v">{person.next_action_kind && person.next_action && <span className="cs-kind">{optLabel(STEPS, person.next_action_kind)}</span>}{person.next_action ?? ''}</div>;
    case 'next_action_due': {
      const d = person.next_action_due;
      return <div className={`cs-v${d && d < today ? ' late' : d === today ? ' today' : ''}`}>{t}</div>;
    }
    case 'do_not_contact':
      return <div className="cs-v"><span className={`cs-check${person.do_not_contact ? ' on' : ''}`} onClick={onToggle} /></div>;
  }
  if (col.kind === 'link' && t) return <div className="cs-v"><a href={/^https?:/i.test(t) ? t : `https://${t}`} target="_blank" rel="noreferrer" onMouseDown={(e) => e.stopPropagation()}>{t.replace(/^https?:\/\/(www\.)?/i, '')}</a></div>;
  if (col.kind === 'select' && t) return <div className="cs-v"><span className={`cs-tag s-${String(person[col.key])}`}>{t}</span></div>;
  return <div className="cs-v">{t}</div>;
}

/* In-place editor for short text (name, phone, email, links). onDone(undefined) cancels; a value commits (null clears). */
function InlineEditor({ col, value, initial, onDone }: { col: Col; value: unknown; initial?: string; onDone: (v: unknown | undefined, move?: 'down' | 'right' | 'left') => void }) {
  const finished = useRef(false);
  const finish = (v: unknown | undefined, move?: 'down' | 'right' | 'left') => { if (finished.current) return; finished.current = true; onDone(v, move); };
  const out = (s: string) => (s.trim() === '' ? null : s.trim());
  const start = initial ?? (value === null || value === undefined ? '' : String(value));
  return (
    <input className="cs-edit" autoFocus defaultValue={start} type={col.kind === 'email' ? 'email' : 'text'}
      onFocus={(e) => { if (initial === undefined) e.currentTarget.select(); else { const l = e.currentTarget.value.length; e.currentTarget.setSelectionRange(l, l); } }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); finish(undefined); }
        else if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); finish(out(e.currentTarget.value), 'down'); }
        else if (e.key === 'Tab') { e.preventDefault(); finish(out(e.currentTarget.value), e.shiftKey ? 'left' : 'right'); }
      }}
      onBlur={(e) => finish(out(e.currentTarget.value))} />
  );
}

/* A small floating panel anchored under an element (flips above near the bottom edge). */
function Popover({ anchor, children }: { anchor: HTMLElement | null; children: React.ReactNode }) {
  const [pos, setPos] = useState<{ left: number; top: number; minWidth: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 380)), top: below > 300 ? r.bottom + 2 : Math.max(8, r.top - 302), minWidth: Math.max(r.width, 220) });
  }, [anchor]);
  if (!pos) return null;
  return createPortal(<div className="cs-pop" style={{ left: pos.left, top: pos.top, minWidth: pos.minWidth }}>{children}</div>, document.body);
}

/* The editor for everything that is not short text: long text (with the step kind for the next step), choices,
   types, dates, yes/no. Saves on Enter / ⌘Enter / click-away / choosing; Escape cancels. */
function FieldEditor({ col, person, value, initial, onDone }: { col: Col; person: SheetPerson; value?: unknown; initial?: string; onDone: (v: unknown | undefined, move?: 'down' | 'right' | 'left') => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const finished = useRef(false);
  const finish = (v: unknown | undefined, move?: 'down' | 'right' | 'left') => { if (finished.current) return; finished.current = true; onDone(v, move); };
  const start = value === undefined ? person[col.key] : value;
  const [draft, setDraft] = useState<string>(() => initial ?? (start === null || start === undefined ? '' : String(start)));
  const [kind, setKind] = useState<string | null>((person.next_action_kind as string | null) ?? null);
  const [types, setTypes] = useState<string[]>(person.types ?? []);
  const [tags, setTags] = useState<string[]>(Array.isArray(start) && col.kind === 'tags' ? (start as string[]) : []);
  const valueNow = (): unknown => {
    if (col.kind === 'types') return TYPES.map((o) => o[0]).filter((t) => types.includes(t));
    if (col.kind === 'tags') return Object.keys(TAGS).filter((t) => tags.includes(t));
    const s = draft.trim();
    return s === '' ? null : col.kind === 'long' ? draft.replace(/\s+$/, '') : s;
  };
  // The next step's kind travels with its text: one save writes both.
  const commitNow = (move?: 'down' | 'right' | 'left') => {
    if (col.key === 'next_action') { finish({ __next: true, text: valueNow(), kind }, move); return; }
    finish(valueNow(), move);
  };
  useEffect(() => {
    const away = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) { if (col.kind === 'select' || col.kind === 'stage') finish(undefined); else commitNow(); } };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }); // re-bound each render so commitNow sees the latest draft
  const keys = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); finish(undefined); }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (col.kind !== 'long' || col.key === 'next_action')) && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); commitNow('down'); }
  };

  if (col.kind === 'select' || col.kind === 'stage') {
    const pt = primaryType(person);
    const groups: { t: string; opts: Opt[]; prefix?: TypeKey }[] = col.kind === 'stage'
      ? (pt ? [{ t: optLabel(TYPES, pt) + ' stage', opts: STAGE_OF[pt].opts, prefix: pt }] : (Object.keys(STAGE_OF) as TypeKey[]).map((t) => ({ t: optLabel(TYPES, t), opts: STAGE_OF[t].opts, prefix: t })))
      : [{ t: col.label, opts: col.options ?? [] }];
    const flat = groups.flatMap((g) => g.opts.map((o) => ({ v: g.prefix ? `${g.prefix}:${o[0]}` : o[0], label: o[1] })));
    const current = col.kind === 'stage' ? (pt ? `${pt}:${person[STAGE_OF[pt].col] ?? ''}` : '') : String(person[col.key] ?? '');
    return (
      <div className="cs-menu" ref={ref} tabIndex={-1} autoFocus onKeyDown={(e) => {
        e.stopPropagation();
        const items = Array.from(ref.current?.querySelectorAll('button[data-v]') ?? []) as HTMLButtonElement[];
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(items.length - 1, at + 1)]?.focus(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); items[Math.max(0, at - 1)]?.focus(); }
        if (e.key === 'Escape') { e.preventDefault(); finish(undefined); }
      }}>
        {groups.map((g) => (
          <div key={g.t}>
            <div className="cs-menu-h">{g.t}</div>
            {g.opts.map((o) => { const v = g.prefix ? `${g.prefix}:${o[0]}` : o[0]; return (
              <button key={v} data-v={v} className={v === current ? 'on' : ''} ref={(b) => { if (b && v === (current || flat[0]?.v) && document.activeElement?.closest('.cs-menu') !== ref.current) b.focus(); }} onClick={() => finish(v, 'down')}>{o[1]}</button>
            ); })}
          </div>
        ))}
        <button className="cs-menu-clear" onClick={() => finish(null, 'down')}>Clear</button>
      </div>
    );
  }
  if (col.kind === 'types') {
    return (
      <div className="cs-menu" ref={ref} tabIndex={-1} onKeyDown={keys}>
        <div className="cs-menu-h">Type (several allowed)</div>
        {TYPES.map(([v, l]) => (
          <label key={v} className="cs-menu-check"><input type="checkbox" checked={types.includes(v)} onChange={() => setTypes((t) => (t.includes(v) ? t.filter((x) => x !== v) : [...t, v]))} />{l}</label>
        ))}
        <div className="cs-menu-foot"><button className="pill small" onClick={() => commitNow('down')}>Save</button></div>
      </div>
    );
  }
  if (col.kind === 'tags') {
    return (
      <div className="cs-menu" ref={ref} tabIndex={-1} onKeyDown={keys}>
        <div className="cs-menu-h">Tags</div>
        {Object.entries(TAGS).map(([v, l]) => (
          <label key={v} className="cs-menu-check"><input type="checkbox" checked={tags.includes(v)} onChange={() => setTags((t) => (t.includes(v) ? t.filter((x) => x !== v) : [...t, v]))} />{l}</label>
        ))}
        <div className="cs-menu-foot"><button className="pill small" onClick={() => commitNow('down')}>Save</button></div>
      </div>
    );
  }
  if (col.kind === 'date' || col.kind === 'stamp') {
    const start = person[col.key] ? (col.kind === 'stamp' ? toISO(new Date(String(person[col.key]))) : String(person[col.key]).slice(0, 10)) : '';
    const out = (s: string | null) => (!s ? null : col.kind === 'stamp' ? new Date(`${s}T12:00:00`).toISOString() : s);
    const plus = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return toISO(d); };
    return (
      <div className="cs-menu cs-date" ref={ref} onKeyDown={keys}>
        <div className="cs-menu-h">{col.label}</div>
        <input type="date" autoFocus defaultValue={start} onChange={(e) => setDraft(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(out(e.currentTarget.value), 'down'); } }} />
        <div className="cs-quick">
          {(col.kind === 'stamp' ? [['Today', 0], ['Yesterday', -1]] : [['Today', 0], ['Tomorrow', 1], ['In 3 days', 3], ['Next week', 7]]).map(([l, n]) => (
            <button key={String(l)} onClick={() => finish(out(plus(Number(n))), 'down')}>{l}</button>
          ))}
          <button onClick={() => finish(null, 'down')}>Clear</button>
        </div>
        {/* the date typed or picked above is saved on Enter or a click elsewhere */}
        <span hidden>{draft}</span>
      </div>
    );
  }
  // long text
  return (
    <div className="cs-menu cs-longedit" ref={ref} onKeyDown={keys}>
      <div className="cs-menu-h">{col.label}</div>
      {col.key === 'next_action' && (
        <div className="cs-quick">
          {STEPS.map(([v, l]) => <button key={v} className={kind === v ? 'on' : ''} onClick={() => setKind(kind === v ? null : v)}>{l}</button>)}
        </div>
      )}
      <textarea autoFocus value={draft} rows={col.key === 'next_action' ? 2 : 6} onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => { const l = e.currentTarget.value.length; e.currentTarget.setSelectionRange(l, l); }} />
      <div className="cs-menu-foot"><span>{col.key === 'next_action' ? 'Enter saves' : '⌘Enter saves, Enter adds a line'} · Esc cancels</span><button className="pill small" onClick={() => commitNow('down')}>Save</button></div>
    </div>
  );
}

/* ─── one person's record ───────────────────────────── */

const SECTIONS: { t: string; keys: string[] }[] = [
  { t: 'Relationship', keys: ['types', 'customer_stage', 'investor_stage', 'contributor_stage', 'contributor_kind', 'next_action', 'next_action_due', 'last_outbound_at', 'notes', 'do_not_contact'] },
  { t: 'Person', keys: ['name', 'email_normalized', 'phone_as_typed', 'company', 'job_title', 'location_text', 'linkedin_url', 'x_handle', 'investor_firm', 'investor_notes'] },
  { t: 'Context', keys: ['_who', 'summary', '_said', '_from', 'source_at', 'last_inbound_at', '_tags'] },
];

function RecordPanel({ person, said, people, cloud, ctx, onClose, onSave, onUndo, onError }: {
  person: SheetPerson; said?: LastWords; people: Person[]; cloud: boolean; ctx: Ctx;
  onClose: () => void; onSave: (key: string, v: unknown) => void; onUndo: (patch: Record<string, unknown>) => void; onError: (m: string) => void;
}) {
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [editing, setEditing] = useState<{ key: string; el: HTMLElement } | null>(null);
  const [history, setHistory] = useState<Change[]>([]);
  const [showSystem, setShowSystem] = useState(false);
  useEffect(() => {
    let alive = true;
    fetchRecord(person.id, cloud).then((d) => { if (alive) setDetail(d); }).catch((e) => onError(`Record: ${String((e as Error).message ?? e)}`));
    return () => { alive = false; };
  }, [person.id, person.last_inbound_at, person.last_outbound_at, said?.at, person.updated_at, cloud]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let alive = true;
    fetchHistory(person.id, cloud).then((h) => { if (alive) setHistory(h); }).catch(() => {});
    return () => { alive = false; };
  }, [person.id, person.updated_at, cloud]);
  const by = (c: Change) => {
    const m = c.actor_user_id ? people.find((x) => x.id === c.actor_user_id) : null;
    const name = m ? shortName(m.name) : 'Someone';
    if (c.surface.startsWith('app:sheet')) return `${name}, in the sheet`;
    if (c.surface.startsWith('app:chat')) return `${name}, through the chat`;
    if (c.surface.startsWith('mcp:')) return `${name}'s agent`;
    if (c.surface.startsWith('agent:')) return 'CRM agent';
    if (c.surface.startsWith('system:migration')) return 'Cleanup';
    return 'System';
  };
  const val = (k: string, v: unknown) => {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return 'empty';
    if (k === 'attribution') return cameFrom({ ...person, attribution: v } as SheetPerson) || 'empty';
    if (k === 'flags') return (v as string[]).map((f) => TAGS[f]).filter(Boolean).join(', ') || 'empty';
    const c = COL[k];
    return c ? text({ ...person, [k]: v } as SheetPerson, c, ctx) || String(v) : (Array.isArray(v) ? v.join(', ') : String(v));
  };
  // Timeline: what they wrote, what the team did and noted. System bookkeeping (imports, machine notes) is hidden
  // unless asked for; the database keeps it.
  const isSystem = (i: RecordDetail['interactions'][number]) => i.direction === 'internal' && !i.actor_user_id;
  const timeline = (detail?.interactions ?? []).filter((i) => showSystem || !isSystem(i));
  const systemCount = (detail?.interactions ?? []).filter(isSystem).length;
  const stamp = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const enr = (person.enrichment ?? null) as Record<string, unknown> | null;
  const editCol = editing ? COL[editing.key] : null;
  return (
    <aside className="cs-record" onKeyDown={(e) => { if (e.key === 'Escape' && !editing) onClose(); }}>
      <header className="cs-rec-head">
        <div className="cs-rec-title">
          <h2>{nameOf(person)}</h2>
          <span>{who(person) || person.email_normalized}</span>
        </div>
        <button className="icon-btn" title="Close (Esc)" onClick={onClose}><XGlyph /></button>
      </header>
      <div className="cs-rec-scroll">
        <p className="cs-note cs-rec-hint">Every field is editable: click it. To tell the CRM what happened, use the chat on the left; it is about {nameOf(person)} while this is open.</p>
        {SECTIONS.map((s) => (
          <section key={s.t} className="cs-rec-sec">
            <h3>{s.t}</h3>
            <table className="cs-fields">
              <tbody>
                {s.keys.map((k) => {
                  const c = COL[k];
                  if (!c) return null;
                  const t = text(person, c, ctx);
                  const canEdit = editable(c);
                  void canEdit;
                  return (
                    <tr key={k} className={canEdit ? '' : 'ro'}>
                      <th>{c.label}</th>
                      <td onClick={(e) => { if (!canEdit) return; if (c.kind === 'bool') { onSave(k, !person[k]); return; } setEditing({ key: k, el: e.currentTarget }); }}>
                        {c.kind === 'link' && t ? <a href={/^https?:/i.test(t) ? t : `https://${t}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{t}</a>
                          : c.kind === 'bool' ? <span className={`cs-check${person[k] ? ' on' : ''}`} />
                          : t ? <span className="cs-pre">{k === '_said' ? said?.text ?? t : k === 'notes' || k === 'summary' || k === 'investor_notes' ? String(person[k] ?? '') : t}</span>
                          : <i className="cs-null">{canEdit ? 'add' : '—'}</i>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        ))}

        <Research person={person} enr={enr} />

        {detail && (timeline.length > 0 || systemCount > 0) && (
          <section className="cs-rec-sec">
            <h3>Timeline <span>{timeline.length}</span>{systemCount > 0 && <button className="cs-link-btn" onClick={() => setShowSystem((v) => !v)}>{showSystem ? 'Hide' : 'Show'} system notes ({systemCount})</button>}</h3>
            {timeline.map((i) => {
              const m = i.actor_user_id ? people.find((x) => x.id === i.actor_user_id) : null;
              const what = i.direction === 'inbound' ? 'They wrote' : i.direction === 'outbound' ? 'We wrote' : m ? 'Note' : 'System';
              return (
                <div key={i.id} className={`cs-msg d-${i.direction}${isSystem(i) ? ' sys' : ''}`}>
                  <div className="cs-msg-head"><b>{what}</b>{m && <span>{shortName(m.name)}</span>}<span>{stamp(i.occurred_at)}</span></div>
                  <p>{(i.body && i.direction === 'inbound' ? i.body : i.summary).replace(/^(Hangar form|Message box): /, '')}</p>
                </div>
              );
            })}
          </section>
        )}
        {history.length > 0 && (
          <section className="cs-rec-sec">
            <h3>Changes <span>{history.length}</span></h3>
            {history.map((c) => (
              <div key={c.id} className="cs-change">
                <div className="cs-msg-head"><b>{by(c)}</b><span>{stamp(c.at)}</span></div>
                {Object.keys(c.after ?? {}).filter((k) => COL[k] || ['enrichment_headline', 'attribution', 'flags'].includes(k)).map((k) => {
                  const after = (c.after ?? {})[k];
                  const before = (c.before ?? {})[k] ?? null;
                  const current = JSON.stringify(person[k] ?? null) === JSON.stringify(after ?? null);
                  return (
                    <div key={k} className="cs-change-row">
                      <span className="cs-change-f">{labelOf(k)}</span>
                      <span className="cs-change-v"><s>{one(val(k, before), 70)}</s> → {one(val(k, after), 70)}</span>
                      <button className="cs-undo" disabled={!current} title={current ? 'Put the earlier value back (recorded as your change)' : 'Changed again since'}
                        onClick={() => onUndo({ [k]: before })}>Undo</button>
                    </div>
                  );
                })}
              </div>
            ))}
          </section>
        )}
        {detail && detail.reservations.length > 0 && (
          <section className="cs-rec-sec">
            <h3>Reservations <span>{detail.reservations.length}</span></h3>
            {detail.reservations.map((r) => (
              <div key={r.id} className="cs-msg"><div className="cs-msg-head"><b>{r.series} {r.edition_number ? `#${String(r.edition_number).padStart(2, '0')}` : ''}</b><span>{r.funding_status.replace(/_/g, ' ')} · {r.acceptance_status.replace(/_/g, ' ')}</span></div></div>
            ))}
          </section>
        )}
        <section className="cs-rec-sec">
          <details className="cs-rawbox">
            <summary>Database row (every column, as stored)</summary>
            <table className="cs-raw">
              <tbody>
                {Object.keys(person).map((k) => {
                  const v = person[k];
                  const out = v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v, null, 1) : String(v);
                  return <tr key={k}><th>{k}</th><td>{out === null ? <i className="cs-null">NULL</i> : <span className="cs-pre">{out.length > 1200 ? `${out.slice(0, 1200)}…` : out}</span>}</td></tr>;
                })}
              </tbody>
            </table>
          </details>
        </section>
      </div>
      {editing && editCol && (
        <Popover anchor={editing.el}>
          {inlineText(editCol)
            ? <TextPopEditor col={editCol} value={editValue(person, editCol, ctx)} onDone={(v) => { setEditing(null); if (v !== undefined) onSave(editing.key, v); }} />
            : <FieldEditor col={editCol} person={person} value={editValue(person, editCol, ctx)} onDone={(v) => { setEditing(null); if (v !== undefined) onSave(editing.key, v); }} />}
        </Popover>
      )}
    </aside>
  );
}

/* Short text in the record: the same field, in a small editor. */
function TextPopEditor({ col, value, onDone }: { col: Col; value: unknown; onDone: (v: unknown | undefined) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const finished = useRef(false);
  const [draft, setDraft] = useState(value === null || value === undefined ? '' : String(value));
  const finish = (v: unknown | undefined) => { if (finished.current) return; finished.current = true; onDone(v); };
  const out = () => (draft.trim() === '' ? null : draft.trim());
  useEffect(() => {
    const away = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) finish(out()); };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  });
  return (
    <div className="cs-menu" ref={ref}>
      <div className="cs-menu-h">{col.label}</div>
      <input className="cs-pop-input" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); finish(undefined); } if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); finish(out()); } }} />
    </div>
  );
}

/* ─── the chat with the CRM agent ───────────────────── */
/* A conversation, not a one-shot box: the thread stays (per machine, per team), the agent shows what it is doing while
   it works, every turn lists what it changed with an Undo, and when it asks something the next message is read as the
   answer (the last turns travel with each message). While a record is open the chat is about that person. */

const CHAT_KEY = (teamId: string) => `exponential-crm-chat-v1:${teamId}`;
const loadChat = (teamId: string): ChatTurn[] => { try { const v = JSON.parse(localStorage.getItem(CHAT_KEY(teamId)) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const saveChat = (teamId: string, turns: ChatTurn[]) => { try { localStorage.setItem(CHAT_KEY(teamId), JSON.stringify(turns.slice(-80))); } catch { /* no storage */ } };

function ChatPanel({ teamId, people, ctx, scope, onError, onPerson, onApplied, onUndoTurn }: {
  teamId: string; people: SheetPerson[]; ctx: Ctx; scope: { id: string; name: string } | null;
  onError: (m: string) => void; onPerson: (id: string) => void; onApplied: (t: ChatTurn) => void; onUndoTurn: (t: ChatTurn) => void;
}) {
  const [turns, setTurns] = useState<ChatTurn[]>(() => loadChat(teamId));
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<{ steps: string[]; since: number } | null>(null);
  const [unscoped, setUnscoped] = useState<string | null>(null);
  const [, tick] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);
  const inRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setTurns(loadChat(teamId)); }, [teamId]);
  useEffect(() => { saveChat(teamId, turns); }, [teamId, turns]);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [turns, busy?.steps.length]);
  useEffect(() => { if (!busy) return; const t = window.setInterval(() => tick((n) => n + 1), 1000); return () => window.clearInterval(t); }, [busy]);
  const about = scope && scope.id !== unscoped ? scope : null;
  const send = async () => {
    const message = draft.trim();
    if (!message || busy) return;
    const mine: ChatTurn = { role: 'member', text: message, at: new Date().toISOString(), about };
    const history = [...turns, mine];
    setTurns(history);
    setDraft('');
    setBusy({ steps: [], since: Date.now() });
    try {
      const reply = await askCrm(message, about?.id ?? null, turns, (step) => setBusy((b) => (b ? { ...b, steps: [...b.steps, step] } : b)));
      setTurns((t) => [...t, reply]);
      onApplied(reply);
    } catch (e) {
      const m = String((e as Error).message ?? e);
      setTurns((t) => [...t, { role: 'agent', text: `That did not go through: ${m}`, error: true, at: new Date().toISOString() }]);
      onError(`CRM chat: ${m}`);
    } finally {
      setBusy(null);
      inRef.current?.focus();
    }
  };
  const undoTurn = (i: number) => {
    const t = turns[i];
    if (!t || t.undone) return;
    onUndoTurn(t);
    setTurns((all) => all.map((x, j) => (j === i ? { ...x, undone: true } : x)));
  };
  const show = (personId: string, k: string, v: unknown) => {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return 'empty';
    const person = people.find((x) => x.id === personId);
    const c = COL[k];
    if (person && c) return text({ ...person, [k]: v } as SheetPerson, c, ctx) || String(v);
    return Array.isArray(v) ? v.join(', ') : String(v);
  };
  const secs = (t: ChatTurn, i: number) => {
    const prev = turns[i - 1];
    return prev?.at && t.at ? Math.max(1, Math.round((+new Date(t.at) - +new Date(prev.at)) / 1000)) : null;
  };
  return (
    <div className="cs-chat">
      <div className="cs-chat-head">
        <b>CRM agent</b>
        <span>{busy ? 'working…' : ''}</span>
        {turns.length > 0 && !busy && <button className="cs-link-btn" title="Start a new conversation (changes already made stay)" onClick={() => setTurns([])}>New chat</button>}
      </div>
      <div className="cs-chat-log" ref={logRef}>
        {!turns.length && !busy && (
          <div className="cs-chat-empty">
            <p>Tell it what happened or ask it anything, in any language.</p>
            <p className="ex">“Called Avery, coming Friday at 2”<br />“Met two investors at the dinner: …”<br />“Who should I call today?”</p>
            <p>It shows what it changed, with Undo, and asks when something is unclear.</p>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`cs-turn ${t.role}${t.error ? ' error' : ''}`}>
            {t.role === 'member' && t.about && <span className="cs-turn-about">about {t.about.name}</span>}
            {t.text && <p>{t.text}</p>}
            {!!t.applied?.length && (
              <div className={`cs-applied${t.undone ? ' undone' : ''}`}>
                {t.applied.map((a) => (
                  <div key={a.person_id} className="cs-applied-p">
                    <button className="cs-applied-name" onClick={() => onPerson(a.person_id)}>{a.name ?? 'Someone'}{a.created ? ' (added)' : ''}</button>
                    {(a.changes ?? []).length ? (a.changes ?? []).map((c) => (
                      <div key={c.field} className="cs-applied-row"><span>{labelOf(c.field)}</span><span><s>{one(show(a.person_id, c.field, c.before), 60)}</s> → {one(show(a.person_id, c.field, c.after), 80)}</span></div>
                    )) : <div className="cs-applied-row"><span>Noted in the timeline</span></div>}
                  </div>
                ))}
                {t.applied.some((a) => a.changes?.length) && (
                  <button className="cs-undo" disabled={t.undone} onClick={() => undoTurn(i)}>{t.undone ? 'Undone' : 'Undo'}</button>
                )}
              </div>
            )}
            {!!t.questions?.length && (
              <div className="cs-asks">{t.questions.map((q, j) => <p key={j}>{q}</p>)}<em>Answer below</em></div>
            )}
            {t.role === 'agent' && !!t.steps?.length && <span className="cs-turn-steps" title={t.steps.join(' → ')}>{t.steps.length} steps{secs(t, i) ? ` · ${secs(t, i)}s` : ''}</span>}
          </div>
        ))}
        {busy && (
          <div className="cs-turn agent busy">
            {(busy.steps.length ? busy.steps : ['Sending']).map((st, j, arr) => <p key={j} className={j === arr.length - 1 ? 'now' : 'done'}>{st}</p>)}
            <span className="cs-turn-steps">{Math.round((Date.now() - busy.since) / 1000)}s</span>
          </div>
        )}
      </div>
      {about && (
        <div className="cs-chat-scope">About <b>{about.name}</b><button title="Ask about the whole CRM instead" onClick={() => setUnscoped(about.id)}>×</button></div>
      )}
      <div className="cs-chat-in">
        <textarea ref={inRef} value={draft} rows={3} placeholder={about ? `What happened with ${about.name}?` : 'Dump meeting notes or an update, or ask about anyone…'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
        <button className="pill small" disabled={!!busy || !draft.trim()} onClick={send}>Send</button>
      </div>
    </div>
  );
}

/** The research, in whichever shape it was written: v2 (open research, free findings) or v1 (fixed fields). */
function Research({ person, enr }: { person: SheetPerson; enr: Record<string, unknown> | null }) {
  const status = person.enrichment_status;
  if (!enr || status === 'skipped') {
    if (status === 'skipped') return null;
    return <section className="cs-rec-sec"><h3>Research</h3><p className="cs-note">{status === 'running' ? 'Being researched now.' : status === 'failed' ? 'Research could not be completed.' : 'Not researched yet.'}</p></section>;
  }
  const identity = enr.identity as { match?: string; reason?: string } | undefined;
  const findings = Array.isArray(enr.findings) ? (enr.findings as { finding: string; confidence: string; source: string }[]) : null;
  const sources = Array.isArray(enr.sources) ? (enr.sources as { url: string; what?: string; supports?: string }[]) : [];
  const unknowns = Array.isArray(enr.unknowns) ? (enr.unknowns as string[]) : [];
  const v1 = !findings ? ([
    ['Role', enr.role], ['Company', enr.company], ['About the company', enr.company_about], ['Location', enr.location],
    ['Approach', enr.suggested_approach], ['Watch out', enr.watch_outs], ['Signals', enr.signals],
  ] as [string, unknown][]).filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) : [];
  const fieldText = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : (x as { value?: string; text?: string })?.value ?? (x as { text?: string })?.text ?? JSON.stringify(x))).join('; ') : typeof v === 'object' && v ? ((v as { value?: string }).value ?? JSON.stringify(v)) : String(v));
  const conf: Record<string, string> = { confirmed: 'Confirmed', likely: 'Likely', ambiguous: 'Unclear match', not_found: 'Not found', unverified: 'Unverified' };
  return (
    <section className="cs-rec-sec">
      <h3>Research {identity?.match && <em className={`cs-conf c-${identity.match}`}>{conf[identity.match] ?? identity.match}</em>}<span>{person.enriched_at ? ago(person.enriched_at) : ''}</span></h3>
      {person.enrichment_summary && <p className="cs-pre">{person.enrichment_summary}</p>}
      {findings && findings.length > 0 && (
        <ul className="cs-findings">
          {findings.map((f, i) => (
            <li key={i}><em className={`cs-conf c-${f.confidence}`}>{conf[f.confidence] ?? f.confidence}</em><span>{f.finding}</span>{f.source && /^https?:/i.test(f.source) && <a href={f.source} target="_blank" rel="noreferrer">source</a>}</li>
          ))}
        </ul>
      )}
      {v1.length > 0 && <dl className="cs-v1">{v1.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{fieldText(v)}</dd></div>)}</dl>}
      {unknowns.length > 0 && <p className="cs-note">Not found: {unknowns.join(' · ')}</p>}
      {sources.length > 0 && (
        <details className="cs-rawbox"><summary>Sources ({sources.length})</summary>
          <ol className="cs-sources">
            {sources.map((s, i) => <li key={i}><a href={s.url} target="_blank" rel="noreferrer">{s.url.replace(/^https?:\/\/(www\.)?/i, '').slice(0, 70)}</a>{(s.what || s.supports) && <span> · {s.what ?? s.supports}</span>}</li>)}
          </ol>
        </details>
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
