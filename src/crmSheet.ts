import { supabase } from './cloud';

/**
 * The CRM page's data: every person on one sheet, live, and editable by a human (iain, 6 Oct 2026: "기본
 * 엑스포넨셜 구성은 좌측에 메인 데일리 오버뷰, 그리고 우측에 crm처럼 스프레드시트있는거야 우리 DB랑 실시간
 * 연결되서 업데이트 수동으로할 수 있는거"). So this loads the WHOLE
 * crm_people table of the team (a few hundred rows, paged in 500s), keeps it current from the realtime
 * publication, and writes one column at a time back to the row, each write leaving one crm_audit line
 * (surface 'app:sheet') so a hand edit is as traceable as an agent's. The guards of patch-016 still hold:
 * consent, opt-out and provenance columns are never offered for editing.
 */

/* Row shapes, as the columns are (snake_case). Only what the page reads is typed; the rest rides the index signature. */
export interface SheetPerson {
  id: string; team_id: string; name: string | null; email_normalized: string | null; emails: string[]; phone_as_typed: string | null;
  x_handle: string | null; linkedin_url: string | null; company: string | null; job_title: string | null; location_text: string | null;
  types: string[]; customer_stage: string | null; investor_stage: string | null; contributor_stage?: string | null; contributor_kind?: string | null;
  investor_firm?: string | null; investor_notes?: string | null;
  source_channel: string; source_at: string; next_action: string | null; next_action_kind?: string | null; next_action_due: string | null;
  last_inbound_at: string | null; last_outbound_at: string | null; do_not_contact: boolean; flags: string[]; merged_into: string | null;
  notes?: string | null; created_at: string; updated_at?: string;
  enrichment?: Record<string, unknown> | null; enrichment_summary?: string | null; enrichment_headline?: string | null;
  enrichment_status?: string | null; enriched_at?: string | null; enrichment_model?: string | null;
  [key: string]: unknown;
}
export interface SheetInteraction { id: string; person_id: string; channel: string; direction: 'inbound' | 'outbound' | 'internal'; occurred_at: string; summary: string; body: string | null; actor_user_id: string | null }
export interface SheetReservation { id: string; series: string; edition_number: number | null; funding_status: string; acceptance_status: string }
export interface LastWords { at: string; text: string; channel: string; id?: string }
export interface SheetData { people: SheetPerson[]; said: Record<string, LastWords>; loaded: boolean }

const PAGE = 500;

async function allPeople(teamId: string): Promise<SheetPerson[]> {
  const rows: SheetPerson[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('crm_people').select('*').eq('team_id', teamId).is('merged_into', null)
      .order('source_at', { ascending: false }).order('id').range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data as SheetPerson[]));
    if ((data?.length ?? 0) < PAGE) return rows;
  }
}

/** The latest thing each person wrote to us (form note, message, reply), for the overview and the "Wrote" column. */
async function lastWords(teamId: string): Promise<Record<string, LastWords>> {
  const out: Record<string, LastWords> = {};
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('crm_submissions').select('id, person_id, received_at, text_body, channel').eq('team_id', teamId)
      .not('person_id', 'is', null).order('received_at', { ascending: false }).range(from, from + PAGE - 1);
    if (error) throw error;
    for (const s of (data ?? []) as { id: string; person_id: string; received_at: string; text_body: string | null; channel: string }[]) {
      const text = (s.text_body ?? '').trim();
      if (text && !out[s.person_id]) out[s.person_id] = { at: s.received_at, text, channel: s.channel, id: s.id };
    }
    if ((data?.length ?? 0) < PAGE) return out;
  }
}

export async function fetchSheet(teamId: string, cloud: boolean): Promise<SheetData> {
  if (!cloud) return { people: [], said: {}, loaded: true };
  const [people, said] = await Promise.all([allPeople(teamId), lastWords(teamId)]);
  return { people, said, loaded: true };
}

/** Whether this team keeps a CRM at all (any crm_people row): the app shows the CRM item only then. */
export async function hasCrm(teamId: string, cloud: boolean): Promise<boolean> {
  if (!cloud) return false;
  const { count, error } = await supabase.from('crm_people').select('id', { count: 'exact', head: true }).eq('team_id', teamId);
  if (error) return false;
  return (count ?? 0) > 0;
}

/** Realtime: people rows patch the sheet in place; a new submission updates "What they wrote". */
export function subscribeSheet(teamId: string, cloud: boolean, h: {
  person: (row: SheetPerson | null, oldId?: string) => void;
  words: (personId: string, w: LastWords) => void;
}): () => void {
  if (!cloud) return () => {};
  const ch = supabase.channel(`crm-sheet:${teamId}:${Math.random().toString(36).slice(2, 8)}`);
  const filter = `team_id=eq.${teamId}`;
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'crm_people', filter }, (p) => {
    if (p.eventType === 'DELETE') h.person(null, (p.old as { id?: string })?.id);
    else h.person(p.new as SheetPerson);
  });
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'crm_submissions', filter }, (p) => {
    const r = p.new as { id?: string; person_id?: string | null; received_at?: string; text_body?: string | null; channel?: string } | null;
    if (r?.person_id && r.received_at) h.words(r.person_id, { at: r.received_at, text: (r.text_body ?? '').trim(), channel: r.channel ?? '', id: r.id });
  });
  ch.subscribe();
  return () => { supabase.removeChannel(ch); };
}

/** Columns of one person written straight to the row (usually one; a stage set on an untyped person also adds the type),
 *  plus one audit line with the before and after. Returns the row as stored. */
export async function writePatch(teamId: string, me: string, person: SheetPerson, patch: Record<string, unknown>): Promise<SheetPerson> {
  const { data, error } = await supabase.from('crm_people').update(patch).eq('id', person.id).select('*').single();
  if (error) throw error;
  const before: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) before[k] = person[k] ?? null;
  // The audit is a record, not a gate: the edit stands even if this line cannot be written.
  const audit = await supabase.from('crm_audit').insert({
    team_id: teamId, actor_user_id: me, surface: 'app:sheet', tool: 'sheet_edit', target_table: 'crm_people', target_id: person.id, before, after: patch,
  });
  if (audit.error) console.warn('[crm] audit line not written:', audit.error.message);
  return data as SheetPerson;
}
export const writeCell = (teamId: string, me: string, person: SheetPerson, col: string, value: unknown) => writePatch(teamId, me, person, { [col]: value });

/** "Their message" edited by hand: the text of the person's latest submission (the raw item they sent). With no
 *  submission at all (someone the team added), a manual one is created. One audit line, like every other edit. */
export async function writeSaid(teamId: string, me: string, personId: string, subId: string | null, before: string | null, text: string | null): Promise<LastWords> {
  let id = subId;
  if (!id) {
    const { data } = await supabase.from('crm_submissions').select('id, received_at').eq('person_id', personId).order('received_at', { ascending: false }).limit(1);
    id = (data as { id: string }[] | null)?.[0]?.id ?? null;
  }
  let row: { id: string; received_at: string; channel: string; text_body: string | null };
  if (id) {
    const { data, error } = await supabase.from('crm_submissions').update({ text_body: text }).eq('id', id).select('id, received_at, channel, text_body').single();
    if (error) throw error;
    row = data as typeof row;
  } else {
    const { data, error } = await supabase.from('crm_submissions').insert({ team_id: teamId, person_id: personId, channel: 'agent_dump', text_body: text, payload: {}, received_at: new Date().toISOString(),
      // filed already: the inbound agent must not pick up a value the team typed
      processed_at: new Date().toISOString(), processing: { decision: 'manual' }, created_by: `user:${me}` })
      .select('id, received_at, channel, text_body').single();
    if (error) throw error;
    row = data as typeof row;
  }
  const audit = await supabase.from('crm_audit').insert({
    team_id: teamId, actor_user_id: me, surface: 'app:sheet', tool: 'sheet_edit', target_table: 'crm_submissions', target_id: row.id,
    before: { text_body: before, person_id: personId }, after: { text_body: text, person_id: personId },
  });
  if (audit.error) console.warn('[crm] audit line not written:', audit.error.message);
  return { at: row.received_at, text: (row.text_body ?? '').trim(), channel: row.channel, id: row.id };
}

export interface RecordDetail { interactions: SheetInteraction[]; submissions: { id: string; channel: string; received_at: string; text_body: string | null; source_url: string | null }[]; reservations: SheetReservation[] }
export async function fetchRecord(personId: string, cloud: boolean): Promise<RecordDetail> {
  if (!cloud) return { interactions: [], submissions: [], reservations: [] };
  const [i, s, r] = await Promise.all([
    supabase.from('crm_interactions').select('*').eq('person_id', personId).order('occurred_at', { ascending: false }).limit(200),
    supabase.from('crm_submissions').select('id, channel, received_at, text_body, source_url').eq('person_id', personId).order('received_at', { ascending: false }).limit(50),
    supabase.from('crm_reservations').select('*').eq('person_id', personId).order('created_at'),
  ]);
  for (const x of [i, s, r]) if (x.error) throw x.error;
  return { interactions: i.data as SheetInteraction[], submissions: s.data as RecordDetail['submissions'], reservations: r.data as SheetReservation[] };
}

/* ── history: every change to one person, newest first, from crm_audit (the sheet, the chat box, the agents) ── */
export interface Change { id: number; at: string; surface: string; actor_user_id: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null }
export async function fetchHistory(personId: string, cloud: boolean): Promise<Change[]> {
  if (!cloud) return [];
  const { data, error } = await supabase.from('crm_audit').select('id, at, surface, actor_user_id, before, after')
    .eq('target_table', 'crm_people').eq('target_id', personId).eq('ok', true).order('at', { ascending: false }).limit(60);
  if (error) throw error;
  return data as Change[];
}

/* ── the chat box: the CRM agent on the website's server (api/agent/chat.js), called with this member's session ── */
export const CRM_AGENT_URL = (import.meta.env.VITE_CRM_AGENT_URL as string | undefined) || 'https://www.utopialabs.com/api/agent/chat';
export interface ChatChange { field: string; before: unknown; after: unknown }
export interface ChatApplied { person_id: string; name: string | null; created: boolean; changed: string[]; changes?: ChatChange[] }
export interface ChatTurn {
  role: 'member' | 'agent'; text: string; at?: string;
  /** the person the chat was opened on when this was sent */
  about?: { id: string; name: string } | null;
  applied?: ChatApplied[]; questions?: string[]; steps?: string[]; error?: boolean; undone?: boolean;
}
/** A turn as the agent reads it back next time: what it said, what it changed, what it asked. */
const forAgent = (t: ChatTurn) => {
  if (t.role === 'member') return { role: t.role, text: (t.about ? `[about ${t.about.name}] ` : '') + t.text };
  const changed = (t.applied ?? []).map((a) => `${a.name ?? 'someone'}${a.created ? ' (added)' : ''}: ${(a.changes ?? []).map((c) => `${c.field} ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`).join('; ') || 'timeline note'}`);
  return { role: t.role, text: [t.text, changed.length ? `Changed: ${changed.join(' | ')}${t.undone ? ' (the member undid these)' : ''}` : '', t.questions?.length ? `Asked: ${t.questions.join(' / ')}` : ''].filter(Boolean).join('\n') };
};
/** One chat turn with the CRM agent. The server streams what it is doing (onStatus), then the answer. */
export async function askCrm(message: string, personId: string | null, conversation: ChatTurn[], onStatus: (s: string) => void = () => {}): Promise<ChatTurn> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('not signed in');
  const res = await fetch(CRM_AGENT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, person_id: personId, stream: true, conversation: conversation.filter((t) => !t.error).slice(-12).map(forAgent) }),
  });
  const done = (out: { reply?: string; applied?: ChatApplied[]; questions?: string[] }, steps: string[]): ChatTurn =>
    ({ role: 'agent', text: out.reply || '', applied: out.applied || [], questions: out.questions || [], steps, at: new Date().toISOString() });
  if (!(res.headers.get('content-type') || '').includes('ndjson') || !res.body) {
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) throw new Error(out.error || `the CRM agent answered ${res.status}`);
    return done(out, []);
  }
  const steps: string[] = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done: end } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const m = JSON.parse(line) as { type: string; text?: string; error?: string; reply?: string; applied?: ChatApplied[]; questions?: string[] };
      if (m.type === 'status' && m.text) { steps.push(m.text); onStatus(m.text); }
      if (m.type === 'error') throw new Error(m.error || 'the CRM agent failed');
      if (m.type === 'done') return done(m, steps);
    }
    if (end) break;
  }
  throw new Error('the CRM agent stopped before answering');
}

/* ── what counts as what, shared by the overview and the sheet's filters ── */

export const isLive = (p: SheetPerson) => !p.merged_into && !p.do_not_contact && !(p.flags ?? []).includes('test')
  && !['cancelled', 'refunded'].includes(p.customer_stage ?? '');
const ms = (iso?: string | null) => (iso ? +new Date(iso) : 0);
/** Wrote to us and nobody has written back yet. */
export const notContacted = (p: SheetPerson) => isLive(p) && !p.last_outbound_at && !!(p.last_inbound_at || p.source_at);
/** We wrote, they answered, and the next word is ours. */
export const ourTurn = (p: SheetPerson) => isLive(p) && !!p.last_outbound_at && ms(p.last_inbound_at) > ms(p.last_outbound_at);
export const dueBy = (p: SheetPerson, day: string) => isLive(p) && !!p.next_action_due && p.next_action_due <= day;
/** Where the person came from, in words: X, Instagram, Google, LinkedIn, a site, or Direct (from the landing referrer,
 *  or the channel recorded when the lead lived in Twenty). */
export const cameFrom = (p: SheetPerson): string => {
  const a = (p.attribution ?? {}) as Record<string, unknown>;
  const touch = (k: string) => ((a[k] as { referrer?: string } | undefined)?.referrer ?? '');
  if (typeof a.label === 'string' && a.label.trim()) return a.label.trim(); // set by hand in the sheet
  const recorded = typeof a.channel === 'string' ? a.channel : '';
  const ref = String(touch('firstTouch') || touch('lastTouch') || a.referrer || '').toLowerCase();
  const via = /t\.co|twitter|x\.com/.test(ref) ? 'X' : /instagram/.test(ref) ? 'Instagram' : /google\./.test(ref) ? 'Google' : /linkedin/.test(ref) ? 'LinkedIn'
    : /youtube|youtu\.be/.test(ref) ? 'YouTube' : /facebook|fb\./.test(ref) ? 'Facebook' : ref ? ref.replace(/^https?:\/\/(www\.)?/, '').split('/')[0] : recorded ? recorded.charAt(0) + recorded.slice(1).toLowerCase() : '';
  const how: Record<string, string> = { website_form: 'Hangar form', website_message: 'Message box', preorder_page: 'Pre-order', stripe: 'Pre-order', x_reply: 'X reply', x_dm: 'X DM', email: 'Email', agent_dump: 'Added by the team', manual: 'Added by the team', import_twenty: 'Hangar form' };
  return [how[p.source_channel] ?? 'Other', via && via !== 'Unknown' ? `via ${via}` : ''].filter(Boolean).join(' ');
};
export const arrivedWithin = (p: SheetPerson, hours: number) => !p.merged_into && !(p.flags ?? []).includes('test') && Date.now() - ms(p.source_at) < hours * 3_600_000;
