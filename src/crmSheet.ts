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
  types: string[]; customer_stage: string | null; investor_stage: string | null; owner_user_id: string | null;
  source_channel: string; source_at: string; next_action: string | null; next_action_due: string | null;
  last_inbound_at: string | null; last_outbound_at: string | null; do_not_contact: boolean; flags: string[]; merged_into: string | null;
  notes?: string | null; created_at: string; updated_at?: string;
  enrichment?: Record<string, unknown> | null; enrichment_summary?: string | null; enrichment_headline?: string | null;
  enrichment_status?: string | null; enriched_at?: string | null; enrichment_model?: string | null;
  [key: string]: unknown;
}
export interface SheetAction { id: string; person_id: string | null; owner_user_id: string; title: string; priority: number; due_date: string | null; status: string }
export interface SheetInteraction { id: string; person_id: string; channel: string; direction: 'inbound' | 'outbound' | 'internal'; occurred_at: string; summary: string; body: string | null; actor_user_id: string | null }
export interface SheetReservation { id: string; series: string; edition_number: number | null; funding_status: string; acceptance_status: string }
export interface LastWords { at: string; text: string; channel: string }
export interface SheetData { people: SheetPerson[]; said: Record<string, LastWords>; actions: SheetAction[]; loaded: boolean }

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
    const { data, error } = await supabase.from('crm_submissions').select('person_id, received_at, text_body, channel').eq('team_id', teamId)
      .not('person_id', 'is', null).order('received_at', { ascending: false }).range(from, from + PAGE - 1);
    if (error) throw error;
    for (const s of (data ?? []) as { person_id: string; received_at: string; text_body: string | null; channel: string }[]) {
      const text = (s.text_body ?? '').trim();
      if (text && !out[s.person_id]) out[s.person_id] = { at: s.received_at, text, channel: s.channel };
    }
    if ((data?.length ?? 0) < PAGE) return out;
  }
}

export async function fetchSheet(teamId: string, cloud: boolean): Promise<SheetData> {
  if (!cloud) return { people: [], said: {}, actions: [], loaded: true };
  const [people, said, actions] = await Promise.all([
    allPeople(teamId),
    lastWords(teamId),
    supabase.from('crm_actions').select('*').eq('team_id', teamId).eq('status', 'open').order('priority').order('due_date', { ascending: true, nullsFirst: false }).limit(300),
  ]);
  if (actions.error) throw actions.error;
  return { people, said, actions: actions.data as SheetAction[], loaded: true };
}

/** Whether this team keeps a CRM at all (any crm_people row): the app shows the CRM item only then. */
export async function hasCrm(teamId: string, cloud: boolean): Promise<boolean> {
  if (!cloud) return false;
  const { count, error } = await supabase.from('crm_people').select('id', { count: 'exact', head: true }).eq('team_id', teamId);
  if (error) return false;
  return (count ?? 0) > 0;
}

/** Realtime: people rows patch the sheet in place; a new submission updates "Wrote"; actions refresh as rows. */
export function subscribeSheet(teamId: string, cloud: boolean, h: {
  person: (row: SheetPerson | null, oldId?: string) => void;
  words: (personId: string, w: LastWords) => void;
  action: (row: SheetAction | null, oldId?: string) => void;
}): () => void {
  if (!cloud) return () => {};
  const ch = supabase.channel(`crm-sheet:${teamId}:${Math.random().toString(36).slice(2, 8)}`);
  const filter = `team_id=eq.${teamId}`;
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'crm_people', filter }, (p) => {
    if (p.eventType === 'DELETE') h.person(null, (p.old as { id?: string })?.id);
    else h.person(p.new as SheetPerson);
  });
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'crm_submissions', filter }, (p) => {
    const r = p.new as { person_id?: string | null; received_at?: string; text_body?: string | null; channel?: string } | null;
    if (r?.person_id && r.received_at && (r.text_body ?? '').trim()) h.words(r.person_id, { at: r.received_at, text: (r.text_body ?? '').trim(), channel: r.channel ?? '' });
  });
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'crm_actions', filter }, (p) => {
    if (p.eventType === 'DELETE') h.action(null, (p.old as { id?: string })?.id);
    else h.action(p.new as SheetAction);
  });
  ch.subscribe();
  return () => { supabase.removeChannel(ch); };
}

/** One column of one person, written straight to the row, plus its audit line. Returns the row as stored. */
export async function writeCell(teamId: string, me: string, person: SheetPerson, col: string, value: unknown): Promise<SheetPerson> {
  const { data, error } = await supabase.from('crm_people').update({ [col]: value }).eq('id', person.id).select('*').single();
  if (error) throw error;
  // The audit is a record, not a gate: the edit stands even if this line cannot be written.
  const audit = await supabase.from('crm_audit').insert({
    team_id: teamId, actor_user_id: me, surface: 'app:sheet', tool: 'sheet_edit', target_table: 'crm_people', target_id: person.id,
    before: { [col]: person[col] ?? null }, after: { [col]: value ?? null },
  });
  if (audit.error) console.warn('[crm] audit line not written:', audit.error.message);
  return data as SheetPerson;
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

/** The one-line reference a human pastes into Claude or Codex to work this person ("Open in agent"). */
export const agentRef = (id: string, label: string) => `crm person ${id} ${label.replace(/\s+/g, ' ').trim()}`;

/* ── what counts as what, shared by the overview and the sheet's filters ── */

export const isLive = (p: SheetPerson) => !p.merged_into && !p.do_not_contact && !(p.flags ?? []).includes('test')
  && !['cancelled', 'refunded'].includes(p.customer_stage ?? '');
const ms = (iso?: string | null) => (iso ? +new Date(iso) : 0);
/** Wrote to us and nobody has written back yet. */
export const notContacted = (p: SheetPerson) => isLive(p) && !p.last_outbound_at && !!(p.last_inbound_at || p.source_at);
/** We wrote, they answered, and the next word is ours. */
export const ourTurn = (p: SheetPerson) => isLive(p) && !!p.last_outbound_at && ms(p.last_inbound_at) > ms(p.last_outbound_at);
export const dueBy = (p: SheetPerson, day: string) => isLive(p) && !!p.next_action_due && p.next_action_due <= day;
export const arrivedWithin = (p: SheetPerson, hours: number) => !p.merged_into && !(p.flags ?? []).includes('test') && Date.now() - ms(p.source_at) < hours * 3_600_000;
