import { createClient, type RealtimeChannel } from '@supabase/supabase-js';
import type { Data, Deadline, Group, Notification, Person, Project, Retro, Task, TeamFeatures } from './types';
import { PROJECT_COLORS } from './types';

export const SUPABASE_URL = 'https://mojqfsnnawdxndqaciuv.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_SwEXVchPqA2ohG3jUzUMKA_Ijo88XVJ';

/* ── egress metering: every byte through the Supabase client is counted, and each
   device upserts one usage_log row per day (patch 009). Signed-URL media that bypasses
   this fetch (chat images, meeting audio) is added via addEgress() where the URL is
   issued. All best-effort: metering must never break a real request. ── */
let meterDown = 0;
let meterUp = 0;
let meterDay = new Date().toISOString().slice(0, 10);
let meterDirty = 0;
let meUid: string | null = null;
const deviceId = (() => {
  try {
    let d = localStorage.getItem('exponential-device');
    if (!d) { d = crypto.randomUUID(); localStorage.setItem('exponential-device', d); }
    return d;
  } catch { return crypto.randomUUID(); }
})();

export function addEgress(bytes: number) {
  if (Number.isFinite(bytes) && bytes > 0) { meterDown += bytes; meterDirty += bytes; }
}

const meteredFetch: typeof fetch = async (input, init) => {
  try {
    const body = init?.body;
    if (typeof body === 'string') meterUp += body.length;
    else if (body instanceof Blob) meterUp += body.size;
    else if (body instanceof ArrayBuffer) meterUp += body.byteLength;
    else if (ArrayBuffer.isView(body)) meterUp += body.byteLength;
  } catch { /* count what we can */ }
  const res = await fetch(input as RequestInfo, init);
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > 0) { meterDown += len; meterDirty += len; }
  return res;
};

async function flushUsage() {
  if (!meUid || meterDirty < 512 * 1024) return;
  const today = new Date().toISOString().slice(0, 10);
  if (today !== meterDay) { meterDay = today; meterDown = 0; meterUp = 0; }
  meterDirty = 0;
  await supabase.from('usage_log').upsert(
    { device_id: deviceId, day: meterDay, user_id: meUid, bytes_down: Math.round(meterDown), bytes_up: Math.round(meterUp), updated_at: new Date().toISOString() },
    { onConflict: 'device_id,day' },
  ).then(() => {}, () => {}); // table may not exist yet — metering stays silent
}
if (typeof window !== 'undefined') {
  window.setInterval(flushUsage, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushUsage(); });
}

/** This month's total metered bytes across the whole team (null while unknown). */
export async function usageMonthTotal(): Promise<number | null> {
  const { data, error } = await supabase.rpc('usage_month_total');
  if (error) return null;
  return Number(data) || 0;
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  // Web (the hosted PWA): the Google OAuth redirect lands back here with a ?code= that
  // supabase-js exchanges automatically. Electron keeps its own id-token flow.
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: !('exponential' in window), flowType: 'pkce' },
  global: { fetch: meteredFetch },
});

/** Browser sign-in for the hosted web app (Electron uses the system-browser id-token flow). */
export async function webSignIn() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.origin + location.pathname },
  });
  if (error) throw error;
}

/** Pending invitees (haven't signed in yet) get a synthetic person id so they show on the roster. */
export const pendingId = (email: string) => `pending:${email.toLowerCase()}`;
export const isPending = (id: string) => id.startsWith('pending:');

/* ─── Auth ─────────────────────────────────────────────────────────────── */

/** Make sure there's a Supabase session for the signed-in Google account. */
export async function ensureSession(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  if (data.session) { meUid = data.session.user.id; return data.session.user.id; }
  const token = await window.exponential?.google.idToken();
  if (!token) return null;
  let res = await supabase.auth.signInWithIdToken({ provider: 'google', token });
  if (res.error) {
    // e.g. a stale cached ID token: force a refresh from Google and try once more
    const fresh = await window.exponential?.google.idToken(true);
    if (!fresh) throw res.error;
    res = await supabase.auth.signInWithIdToken({ provider: 'google', token: fresh });
    if (res.error) throw res.error;
  }
  meUid = res.data.user?.id ?? meUid;
  return res.data.user?.id ?? null;
}

/** Make sure my profile row exists (the sign-up trigger covers new users; this covers everything else). */
export async function ensureProfile() {
  const { error } = await supabase.rpc('ensure_profile');
  if (error) throw error;
}

export async function signOutCloud() {
  await supabase.auth.signOut();
}

/* ─── Row shapes ───────────────────────────────────────────────────────── */

type ProfileRow = { id: string; email: string; name: string; photo: string | null; color: string };
type TeamRow = { id: string; name: string; icon: string | null; retro_fields: Data['retroFields'] | null; retro_template: Data['retroTemplate'] | null; features?: TeamFeatures | null };
type MemberRow = { team_id: string; email: string; user_id: string | null; role: 'moderator' | 'member'; color: string; profiles: ProfileRow | null };
type ProjectRow = { id: string; team_id: string; name: string; start_date: string; end_date: string; lane: number; color: string | null; notes: string | null; assignees: string[]; group_id: string | null; deleted_at: string | null };
type GroupRow = { id: string; team_id: string; name: string; color: string; sort: number };
type DeadlineRow = { id: string; team_id: string; name: string; date: string; notes: string | null };
type TaskRow = { id: string; team_id: string; person_id: string | null; title: string; date: string | null; end_date: string | null; status: Task['status']; sort_order: number; notes: string | null; created_by: string | null; reviewer_id: string | null; review_done: boolean | null; project_id: string | null; parent_id: string | null; deleted_at: string | null };
type RetroRow = { team_id: string; week: string; answers: Record<string, string>; notes: string | null };
type NotificationRow = { id: string; team_id: string; to_user: string; from_user: string | null; kind: Notification['kind']; text: string; ref_kind: 'task' | 'project' | 'chat'; ref_id: string; read: boolean; created_at: string };

const und = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

const toProject = (r: ProjectRow): Project => ({ id: r.id, name: r.name, start: r.start_date, end: r.end_date, lane: r.lane, groupId: und(r.group_id), color: und(r.color), notes: und(r.notes), assignees: r.assignees?.length ? r.assignees : undefined, deletedAt: und(r.deleted_at) });
const toGroup = (r: GroupRow): Group => ({ id: r.id, name: r.name, color: r.color, sort: r.sort });
const toDeadline = (r: DeadlineRow): Deadline => ({ id: r.id, name: r.name, date: r.date, notes: und(r.notes) });
const toTask = (r: TaskRow): Task => ({ id: r.id, personId: und(r.person_id), title: r.title, date: und(r.date), end: und(r.end_date), status: r.status, order: r.sort_order, notes: und(r.notes), createdBy: und(r.created_by), reviewerId: und(r.reviewer_id), reviewDone: r.review_done || undefined, projectId: und(r.project_id), parentId: und(r.parent_id), deletedAt: und(r.deleted_at) });
const toRetro = (r: RetroRow): Retro => ({ week: r.week, answers: r.answers ?? {}, notes: und(r.notes) });
const toNotification = (r: NotificationRow): Notification => ({ id: r.id, to: r.to_user, from: r.from_user ?? '', kind: r.kind, text: r.text, ref: { kind: r.ref_kind, id: r.ref_id }, at: r.created_at, read: r.read });

const fromProject = (teamId: string, p: Project) => ({ id: p.id, team_id: teamId, name: p.name, start_date: p.start, end_date: p.end, lane: p.lane, group_id: p.groupId ?? null, color: p.color ?? null, notes: p.notes ?? null, assignees: (p.assignees ?? []).filter((a) => !isPending(a)), deleted_at: p.deletedAt ?? null });
const fromGroup = (teamId: string, g: Group) => ({ id: g.id, team_id: teamId, name: g.name, color: g.color, sort: g.sort });
const fromDeadline = (teamId: string, d: Deadline) => ({ id: d.id, team_id: teamId, name: d.name, date: d.date, notes: d.notes ?? null });
const fromTask = (teamId: string, t: Task) => ({ id: t.id, team_id: teamId, person_id: t.personId ?? null, title: t.title, date: t.date ?? null, end_date: t.end ?? null, status: t.status, sort_order: t.order ?? 0, notes: t.notes ?? null, created_by: t.createdBy ?? null, reviewer_id: t.reviewerId ?? null, review_done: t.reviewDone ?? false, project_id: t.projectId ?? null, parent_id: t.parentId ?? null, deleted_at: t.deletedAt ?? null });
const fromNotification = (teamId: string, n: Notification) => ({ id: n.id, team_id: teamId, to_user: n.to, from_user: n.from || null, kind: n.kind, text: n.text, ref_kind: n.ref.kind, ref_id: n.ref.id, read: n.read });

/* ─── Loading ──────────────────────────────────────────────────────────── */

export interface TeamSummary { id: string; name: string; icon?: string }

export async function listMyTeams(): Promise<TeamSummary[]> {
  const { data, error } = await supabase.from('teams').select('id, name, icon').order('created_at');
  if (error) throw error;
  return (data as TeamRow[]).map((t) => ({ id: t.id, name: t.name, icon: und(t.icon) }));
}

export async function createTeam(name: string): Promise<string> {
  const { data, error } = await supabase.rpc('create_team', { team_name: name });
  if (error) throw error;
  return data as string;
}

export async function deleteTeam(id: string) {
  const { error } = await supabase.from('teams').delete().eq('id', id);
  if (error) throw error;
}

export async function loadTeam(teamId: string, me: string): Promise<Data> {
  try { await ensureSession(); } catch { /* a dead session then fails the reads visibly instead of silently returning nothing */ }
  const [team, members, projects, deadlines, tasks, retros, notifications, groups] = await Promise.all([
    supabase.from('teams').select('*').eq('id', teamId).single(), // '*' so a not-yet-applied additive column can't break the load
    supabase.from('team_members').select('team_id, email, user_id, role, color, profiles(id, email, name, photo, color)').eq('team_id', teamId).order('created_at'),
    supabase.from('projects').select('*').eq('team_id', teamId),
    supabase.from('deadlines').select('*').eq('team_id', teamId),
    supabase.from('tasks').select('*').eq('team_id', teamId),
    supabase.from('retros').select('*').eq('team_id', teamId),
    supabase.from('notifications').select('*').eq('team_id', teamId).eq('to_user', me).order('created_at'),
    supabase.from('groups').select('*').eq('team_id', teamId).order('sort').order('created_at'),
  ]);
  for (const r of [team, members, projects, deadlines, tasks, retros, notifications, groups]) if (r.error) throw r.error;
  const t = team.data as TeamRow;
  const rows = members.data as unknown as MemberRow[];
  const people: Person[] = rows.map((m, i) => m.profiles
    ? { id: m.profiles.id, name: m.profiles.name || m.email, email: m.profiles.email, photo: und(m.profiles.photo), color: m.color || PROJECT_COLORS[i % PROJECT_COLORS.length] }
    : { id: pendingId(m.email), name: m.email, email: m.email, color: m.color || PROJECT_COLORS[i % PROJECT_COLORS.length] });
  return {
    id: t.id,
    name: t.name,
    icon: und(t.icon),
    retroFields: t.retro_fields ?? undefined,
    retroTemplate: t.retro_template ?? undefined,
    features: t.features ?? undefined,
    moderators: rows.filter((m) => m.role === 'moderator').map((m) => m.user_id ?? pendingId(m.email)),
    me,
    people,
    groups: (groups.data as GroupRow[]).map(toGroup),
    projects: (projects.data as ProjectRow[]).map(toProject),
    deadlines: (deadlines.data as DeadlineRow[]).map(toDeadline),
    tasks: (tasks.data as TaskRow[]).map(toTask),
    retros: Object.fromEntries((retros.data as RetroRow[]).map((r) => [r.week, toRetro(r)])),
    notifications: (notifications.data as NotificationRow[]).map(toNotification),
  };
}

/* ─── Writing: diff two Data snapshots into row operations ─────────────── */

/** Only the columns this client actually changed: concurrent edits to DIFFERENT fields of the
 *  same row (one person drags the dates while another types notes) stop overwriting each other.
 *  Simultaneous edits to the SAME field remain last-writer-wins. */
function changedCols(prevRow: Record<string, unknown>, nextRow: Record<string, unknown>): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  let any = false;
  for (const k of Object.keys(nextRow)) {
    if (k === 'id' || k === 'team_id') continue;
    if (JSON.stringify(prevRow[k]) !== JSON.stringify(nextRow[k])) { patch[k] = nextRow[k]; any = true; }
  }
  return any ? patch : null;
}

/** A retro row is one jsonb of every section's answers — never write it whole. Reads the current
 *  row and overwrites only the KEYS this client changed (health merges one level deeper, per
 *  person), so people filling different sections — or their own health column — never fight. */
async function mergeRetroWrite(teamId: string, prev: { answers?: Record<string, unknown>; notes?: string | null } | undefined, next: { week: string; answers?: Record<string, unknown>; notes?: string | null }) {
  const { data: cur, error } = await supabase.from('retros').select('answers,notes').eq('team_id', teamId).eq('week', next.week).maybeSingle();
  if (error) return { error };
  const base = { ...((cur?.answers ?? {}) as Record<string, unknown>) };
  const pa = (prev?.answers ?? {}) as Record<string, unknown>;
  const na = (next.answers ?? {}) as Record<string, unknown>;
  for (const k of new Set([...Object.keys(pa), ...Object.keys(na)])) {
    if (JSON.stringify(pa[k]) === JSON.stringify(na[k])) continue; // untouched here — keep whatever the server has
    if (k === 'health') {
      const merged = { ...((base.health ?? {}) as Record<string, unknown>) };
      const ph = (pa.health ?? {}) as Record<string, unknown>;
      const nh = (na.health ?? {}) as Record<string, unknown>;
      for (const person of new Set([...Object.keys(ph), ...Object.keys(nh)])) {
        if (JSON.stringify(ph[person]) === JSON.stringify(nh[person])) continue;
        if (nh[person] === undefined) delete merged[person]; else merged[person] = nh[person];
      }
      base.health = merged;
    } else if (na[k] === undefined) delete base[k];
    else base[k] = na[k];
  }
  const notes = (prev?.notes ?? null) !== (next.notes ?? null) ? next.notes ?? null : cur ? cur.notes : next.notes ?? null;
  return supabase.from('retros').upsert({ team_id: teamId, week: next.week, answers: base, notes }, { onConflict: 'team_id,week' });
}

function diff<T extends { id: string }>(prev: T[], next: T[]) {
  const pm = new Map(prev.map((x) => [x.id, x]));
  const nm = new Map(next.map((x) => [x.id, x]));
  const upsert = next.filter((x) => { const p = pm.get(x.id); return !p || JSON.stringify(p) !== JSON.stringify(x); });
  const remove = prev.filter((x) => !nm.has(x.id)).map((x) => x.id);
  return { upsert, remove };
}

const errorListeners = new Set<(msg: string) => void>();
/** Subscribe to failed writes (shown to the user; nothing is silently dropped). */
export function onPersistError(cb: (msg: string) => void) { errorListeners.add(cb); return () => { errorListeners.delete(cb); }; }

async function run(label: string, p: PromiseLike<{ error: unknown }>) {
  const { error } = await p;
  if (error) {
    console.error(`[cloud] ${label} failed`, error);
    const msg = (error as { message?: string })?.message ?? String(error);
    errorListeners.forEach((cb) => cb(`Couldn't save ${label}: ${msg}`));
  }
}

/** Persist whatever changed between two snapshots of the same team. Fire-and-forget; errors are logged. */
export async function persistDiff(prev: Data, next: Data) {
  // The session can die while the app is running (a laptop asleep past token expiry, or a
  // backend outage blocking the refresh — the egress-quota incident did exactly this): heal
  // it before writing, or every save bounces off RLS as anonymous until the app restarts.
  try { await ensureSession(); } catch { /* let the writes surface the real error */ }
  const teamId = next.id;
  const ops: Promise<void>[] = [];

  // Existing rows: write only the changed columns; new rows: insert whole. (See changedCols.)
  const splitWrite = <M extends { id: string }>(label: string, table: string, changed: M[], prevArr: M[], toRow: (m: M) => Record<string, unknown>) => {
    const prevById = new Map(prevArr.map((x) => [x.id, x]));
    const freshRows = changed.filter((x) => !prevById.has(x.id)).map((x) => toRow(x));
    const out: Promise<void>[] = [];
    if (freshRows.length) out.push(run(label, supabase.from(table).upsert(freshRows)));
    for (const m of changed) {
      const p = prevById.get(m.id);
      if (!p) continue;
      const patch = changedCols(toRow(p), toRow(m));
      if (patch) out.push(run(label, supabase.from(table).update(patch).eq('id', m.id)));
    }
    return out;
  };

  const gr = diff(prev.groups ?? [], next.groups ?? []);
  await Promise.all(splitWrite('groups', 'groups', gr.upsert, prev.groups ?? [], (g) => fromGroup(teamId, g))); // before projects that reference them
  if (gr.remove.length) ops.push(run('groups-del', supabase.from('groups').delete().in('id', gr.remove)));

  const pr = diff(prev.projects, next.projects);
  ops.push(...splitWrite('projects', 'projects', pr.upsert, prev.projects, (p) => fromProject(teamId, p)));
  if (pr.remove.length) ops.push(run('projects-del', supabase.from('projects').delete().in('id', pr.remove)));

  const dl = diff(prev.deadlines, next.deadlines);
  ops.push(...splitWrite('deadlines', 'deadlines', dl.upsert, prev.deadlines, (d) => fromDeadline(teamId, d)));
  if (dl.remove.length) ops.push(run('deadlines-del', supabase.from('deadlines').delete().in('id', dl.remove)));

  const tk = diff(prev.tasks, next.tasks);
  const writable = tk.upsert.filter((t) => !t.personId || !isPending(t.personId));
  ops.push(...splitWrite('tasks', 'tasks', writable, prev.tasks, (t) => fromTask(teamId, t)));
  if (tk.remove.length) ops.push(run('tasks-del', supabase.from('tasks').delete().in('id', tk.remove)));

  const prevRetros = Object.values(prev.retros ?? {}).map((r) => ({ ...r, id: r.week }));
  const nextRetros = Object.values(next.retros ?? {}).map((r) => ({ ...r, id: r.week }));
  const rt = diff(prevRetros, nextRetros);
  for (const r of rt.upsert) {
    const prevR = prevRetros.find((x) => x.id === r.id);
    ops.push(run('retro', mergeRetroWrite(teamId, prevR, r)));
  }

  const nt = diff(prev.notifications ?? [], next.notifications ?? []);
  // Upserts would hit the UPDATE policy (own rows only), so: plain inserts for new notifications
  // (any member may notify a teammate), updates only for rows I already have (marking mine read).
  const prevIds = new Set((prev.notifications ?? []).map((n) => n.id));
  const fresh = nt.upsert.filter((n) => !prevIds.has(n.id) && !isPending(n.to));
  const changed = nt.upsert.filter((n) => prevIds.has(n.id) && !isPending(n.to));
  if (fresh.length) ops.push(run('notifications', supabase.from('notifications').insert(fresh.map((n) => fromNotification(teamId, n)))));
  for (const n of changed) ops.push(run('notifications-update', supabase.from('notifications').update({ read: n.read }).eq('id', n.id)));
  if (nt.remove.length) ops.push(run('notifications-del', supabase.from('notifications').delete().in('id', nt.remove)));

  const tpatch: Record<string, unknown> = {};
  if (prev.name !== next.name) tpatch.name = next.name;
  if (prev.icon !== next.icon) tpatch.icon = next.icon ?? null;
  if (JSON.stringify(prev.retroFields) !== JSON.stringify(next.retroFields)) tpatch.retro_fields = next.retroFields ?? null;
  if (JSON.stringify(prev.retroTemplate) !== JSON.stringify(next.retroTemplate)) tpatch.retro_template = next.retroTemplate ?? null;
  if (JSON.stringify(prev.features) !== JSON.stringify(next.features)) tpatch.features = next.features ?? null; // patch-012 column; errors surface as the red save toast until it's applied
  if (Object.keys(tpatch).length) ops.push(run('team', supabase.from('teams').update(tpatch).eq('id', teamId)));

  // Roster: people added/removed by email; role changes via the moderators list.
  const pp = diff(prev.people, next.people);
  for (const p of pp.upsert.filter((x) => !prev.people.some((y) => y.id === x.id))) {
    if (p.email) ops.push(run('invite', supabase.from('team_members').insert({ team_id: teamId, email: p.email.toLowerCase(), role: 'member', color: p.color })));
  }
  for (const id of pp.remove) {
    const gone = prev.people.find((x) => x.id === id);
    if (gone?.email) ops.push(run('remove-member', supabase.from('team_members').delete().eq('team_id', teamId).eq('email', gone.email.toLowerCase())));
  }
  if (JSON.stringify(prev.moderators) !== JSON.stringify(next.moderators)) {
    for (const person of next.people) {
      const wasMod = prev.moderators.includes(person.id), isMod = next.moderators.includes(person.id);
      if (wasMod !== isMod && person.email) {
        ops.push(run('role', supabase.from('team_members').update({ role: isMod ? 'moderator' : 'member' }).eq('team_id', teamId).eq('email', person.email.toLowerCase())));
      }
    }
  }

  await Promise.all(ops);
}

/* ─── Realtime ─────────────────────────────────────────────────────────── */

/** Calls `onChange` (debounced) whenever any row of this team changes; caller reloads. */
export function subscribeTeam(teamId: string, me: string, onChange: () => void, onNotification?: (n: Notification) => void): () => void {
  let timer: number | undefined;
  const kick = () => { window.clearTimeout(timer); timer = window.setTimeout(onChange, 150); };
  const ch: RealtimeChannel = supabase.channel(`team:${teamId}`);
  for (const table of ['projects', 'deadlines', 'tasks', 'retros', 'team_members', 'teams', 'groups']) {
    ch.on('postgres_changes', { event: '*', schema: 'public', table, filter: table === 'teams' ? `id=eq.${teamId}` : `team_id=eq.${teamId}` }, kick);
  }
  // the row payload rides along so banners can fire even while the reload itself is parked
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `to_user=eq.${me}` }, (p) => {
    kick();
    if (p.eventType === 'INSERT' && onNotification) { try { onNotification(toNotification(p.new as NotificationRow)); } catch { /* malformed row */ } }
  });
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, kick);
  ch.subscribe();
  return () => { window.clearTimeout(timer); supabase.removeChannel(ch); };
}
