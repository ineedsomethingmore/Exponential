import { useCallback, useEffect, useRef, useState } from 'react';
import type { CalendarEvent, Data, GoogleUser, ISODate, Project, Workspace } from './types';
import { addDays, todayISO, weekStart } from './dates';
import { appIdle } from './idle';
import { createTeam as cloudCreateTeam, deleteTeam as cloudDeleteTeam, ensureProfile, ensureSession, listMyTeams, loadTeam, persistDiff, subscribeTeam, supabase, type TeamSummary } from './cloud';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

declare global {
  interface Window {
    exponential?: {
      load: () => Promise<unknown>;
      save: (data: unknown) => Promise<void>;
      onChange: (cb: (data: unknown) => void) => () => void;
      openMain: (target?: { kind: string; id: string }) => void;
      closeWidget: () => void;
      isWidget: boolean;
      onWidgetShown: (cb: () => void) => () => void;
      version: () => Promise<string>;
      onUpdate: (cb: (s: { state: 'checking' | 'available' | 'none' | 'downloading' | 'ready' | 'error'; version?: string; percent?: number; message?: string }) => void) => () => void;
      installUpdate: () => void;
      checkForUpdate: () => void;
      onOpen: (cb: (target: { kind: string; id: string }) => void) => () => void;
      pingCloud?: () => void;
      onCloudPing?: (cb: () => void) => () => void;
      notify?: (p: { id: string; title: string; body: string; ref?: { kind: string; id: string } }) => void;
      onNotifyBlocked?: (cb: () => void) => () => void;
      onEditCommand?: (cb: (kind: 'undo' | 'redo') => void) => () => void;
      meetingAppend?: (id: string, buf: ArrayBuffer) => Promise<void>;
      meetingRead?: (id: string) => Promise<ArrayBuffer>;
      meetingDelete?: (id: string) => Promise<void>;
      linkPreview?: (url: string) => Promise<{ url: string; title: string; desc: string | null; image: string | null; site: string } | null>;
      download?: (url: string, name: string) => void;
      micEnsure?: () => Promise<boolean>;
      micOpenSettings?: () => Promise<void>;
      openNotificationSettings?: () => void;
      setSharedState?: (p: { teamId: string | null; teamName: string | null; planUnlocked: boolean }) => void;
      connectClaude?: () => Promise<{ ok: boolean; messages: string[] }>;
      sendToClaude?: (text: string) => Promise<'app' | 'app-paste' | 'web' | 'copied'>;
      claudeStatus?: () => Promise<{ connected: boolean; targets: string[]; entry: { command: string; serverPath: string } }>;
      platform: string;
      google: {
        getConfig: () => Promise<GoogleConfig | null>;
        setConfig: (c: GoogleConfig) => Promise<void>;
        status: () => Promise<GoogleUser | null>;
        signIn: () => Promise<GoogleUser>;
        signOut: () => Promise<void>;
        events: (calendarId: string, from: ISODate, to: ISODate) => Promise<CalendarEvent[]>;
        idToken: (force?: boolean) => Promise<string | null>;
        hasCalendar: () => Promise<boolean>;
        grantCalendar: () => Promise<boolean>;
      };
    };
  }
}

export const uid = () => crypto.randomUUID();

/**
 * Anything new that lands in my inbox becomes a system notification — even while the app is open.
 * Both windows run this; the main process dedupes by id, so it fires once regardless.
 * The first sight of a team's data only seeds the ledger (no blast of old notifications on launch).
 */
/** Ids already bannered straight off the realtime payload (the ungated path below) —
    the reload-driven pass must not fire them a second time. */
const bannered = new Set<string>();

export function useSystemNotifications(data: Data | null) {
  const seen = useRef<Set<string> | null>(null);
  const teamRef = useRef<string | null>(null);
  useEffect(() => {
    if (!data || !window.exponential?.notify) return;
    const mine = (data.notifications ?? []).filter((n) => n.to === data.me);
    if (seen.current === null || teamRef.current !== data.id) {
      teamRef.current = data.id;
      seen.current = new Set(mine.map((n) => n.id));
      return;
    }
    for (const n of mine) {
      if (seen.current.has(n.id)) continue;
      seen.current.add(n.id);
      if (bannered.has(n.id)) continue;
      window.exponential.notify({ id: n.id, title: 'Exponential', body: n.text, ref: n.ref });
    }
  }, [data]);
}

function seed(): Data {
  const today = todayISO();
  const monday = weekStart(today);
  return {
    id: uid(),
    name: 'Airy Automotive',
    moderators: ['me'],
    me: 'me',
    people: [
      { id: 'me', name: 'Rasmus Hauschild', color: '#3b82f6' },
      { id: 'p2', name: 'Adam Lind', color: '#f59e0b' },
      { id: 'p3', name: 'Sebastian Berg', color: '#10b981' },
    ],
    projects: [
      { id: uid(), name: 'Chassis prototype', start: addDays(today, -40), end: addDays(today, 25), lane: 0 },
      { id: uid(), name: 'Battery pack v2', start: addDays(today, -10), end: addDays(today, 60), lane: 1 },
      { id: uid(), name: 'Investor deck', start: addDays(today, 3), end: addDays(today, 18), lane: 2 },
      { id: uid(), name: 'Supplier onboarding', start: addDays(today, 30), end: addDays(today, 95), lane: 0 },
    ],
    deadlines: [
      { id: uid(), name: 'Design freeze', date: addDays(today, 12) },
      { id: uid(), name: 'Board meeting', date: addDays(today, 21) },
      { id: uid(), name: 'Test drive', date: addDays(today, 70) },
    ],
    tasks: [
      { id: uid(), personId: 'me', title: 'Review CAD from Adam', date: addDays(monday, 0), status: 'done' },
      { id: uid(), personId: 'me', title: 'Draft battery spec', date: addDays(monday, 1), status: 'progress' },
      { id: uid(), personId: 'me', title: 'Call supplier about cells', date: addDays(monday, 2), status: 'todo' },
      { id: uid(), personId: 'me', title: 'Deck outline', date: addDays(monday, 4), status: 'todo' },
      { id: uid(), personId: 'p2', title: 'Finish chassis welds', date: addDays(monday, 0), status: 'progress' },
      { id: uid(), personId: 'p2', title: 'Order brackets', date: addDays(monday, 2), status: 'review' },
      { id: uid(), personId: 'p3', title: 'BMS firmware test', date: addDays(monday, 1), status: 'todo' },
      { id: uid(), personId: 'p3', title: 'Write test plan', date: addDays(monday, 3), status: 'cancelled' },
    ],
    notifications: [],
  };
}

/** Notes used to be stored as HTML from a contenteditable; convert the common tags to Markdown. */
export function htmlToMarkdown(html: string): string {
  if (!html || !/<[a-z][\s\S]*>/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = (node: Node, depth = 0): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    const el = node as HTMLElement;
    const inner = () => Array.from(el.childNodes).map((n) => walk(n, depth)).join('');
    switch (el.tagName) {
      case 'H1': return `\n# ${inner().trim()}\n`;
      case 'H2': return `\n## ${inner().trim()}\n`;
      case 'H3': return `\n### ${inner().trim()}\n`;
      case 'P': case 'DIV': { const t = inner(); return t.trim() ? `${t}\n` : '\n'; }
      case 'BR': return '\n';
      case 'B': case 'STRONG': return `**${inner()}**`;
      case 'I': case 'EM': return `*${inner()}*`;
      case 'UL': case 'OL': return `\n${Array.from(el.children).map((li, i) => `${'  '.repeat(depth)}${el.tagName === 'OL' ? `${i + 1}.` : '-'} ${walk(li, depth + 1).trim().replace(/^\[( |x)\]\s+/, '[$1] ')}`).join('\n')}\n`;
      case 'LI': return inner();
      case 'IMG': return `\n![](${el.getAttribute('src')})\n`;
      case 'INPUT': return el.hasAttribute('checked') || (el as HTMLInputElement).checked ? '[x] ' : '[ ] ';
      default: return inner();
    }
  };
  return walk(doc.body).replace(/\n{3,}/g, '\n\n').trim();
}

function migrate(d: Data): Data {
  d = {
    ...d,
    id: d.id ?? uid(),
    name: d.name ?? 'My team',
    moderators: d.moderators ?? [d.me],
    projects: d.projects.map((p) => (p.notes ? { ...p, notes: htmlToMarkdown(p.notes) } : p)),
    tasks: d.tasks.map((t) => (t.notes ? { ...t, notes: htmlToMarkdown(t.notes) } : t)),
    deadlines: d.deadlines.map((x) => (x.notes ? { ...x, notes: htmlToMarkdown(x.notes) } : x)),
    retros: d.retros && Object.fromEntries(Object.entries(d.retros).map(([k, r]) => {
      // older retros kept each answer as its own field
      const legacy = r as unknown as Record<string, string>;
      const answers = r.answers ?? Object.fromEntries(['wentWell', 'improve', 'learnings', 'nextFocus'].filter((f) => legacy[f]).map((f) => [f, legacy[f]]));
      return [k, { week: r.week, answers, notes: r.notes ? htmlToMarkdown(r.notes) : r.notes }];
    })),
  };
  if (d.projects.every((p) => typeof p.lane === 'number')) return d;
  const laneEnds: string[] = [];
  const projects = [...d.projects]
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((p): Project => {
      if (typeof p.lane === 'number') return p;
      let lane = laneEnds.findIndex((end) => end < p.start);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(p.end); } else laneEnds[lane] = p.end;
      return { ...p, lane };
    });
  return { ...d, projects };
}

const LS_KEY = 'exponential-data';

/** A saved file is either a workspace or (older) a single team's data. */
function toWorkspace(raw: unknown): Workspace {
  const r = raw as Partial<Workspace> & Partial<Data>;
  if (Array.isArray(r.teams)) {
    const teams = r.teams.map(migrate);
    return { teams, current: teams.some((t) => t.id === r.current) ? r.current! : teams[0].id };
  }
  const one = migrate(r as Data);
  return { teams: [one], current: one.id };
}

async function load(): Promise<Workspace> {
  if (window.exponential) {
    const d = await window.exponential.load();
    if (d) return toWorkspace(d);
  } else {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return toWorkspace(JSON.parse(raw));
  }
  const first = seed();
  return { teams: [first], current: first.id };
}

async function persist(ws: Workspace) {
  if (window.exponential) await window.exponential.save(ws);
  else localStorage.setItem(LS_KEY, JSON.stringify(ws));
}

const HISTORY = 100;

/**
 * Data + undo/redo. `update(fn, coalesceKey)` records a history step; consecutive updates with the
 * same key (e.g. typing into one notes field) collapse into one step.
 */
const CURRENT_TEAM_KEY = 'exponential-current-team';

/**
 * Data for the UI. Two modes behind one API:
 *  - local: a workspace in a JSON file / localStorage (browser preview, or before sign-in);
 *  - cloud: one team at a time from Supabase, every `update()` diffed into row writes,
 *    realtime changes reloaded. `connectCloud()` switches modes once Google sign-in is done.
 */
export function useData() {
  const [ws, setWs] = useState<Workspace | null>(null);
  const wsRef = useRef<Workspace | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const past = useRef<Data[]>([]);
  const future = useRef<Data[]>([]);
  const lastKey = useRef<string | undefined>(undefined);
  const lastKeyAt = useRef(0);

  const [cloud, setCloud] = useState<{ me: string; teams: TeamSummary[]; data: Data | null } | null>(null);
  const cloudRef = useRef(cloud);
  cloudRef.current = cloud;
  const inflight = useRef(0);
  const reloadWanted = useRef(false);
  const editSeq = useRef(0); // bumps on every local edit; a reload that started before an edit must not overwrite it

  useEffect(() => {
    load().then((w) => { wsRef.current = w; setWs(w); });
    return window.exponential?.onChange((raw) => {
      if (cloudRef.current) return; // cloud mode syncs through realtime instead
      const incoming = toWorkspace(raw);
      const cur = wsRef.current?.current;
      const next = cur && incoming.teams.some((t) => t.id === cur) ? { ...incoming, current: cur } : incoming;
      wsRef.current = next;
      setWs(next);
    });
  }, []);

  /* ── cloud plumbing ── */
  const reload = useCallback(async (teamId?: string) => {
    const c = cloudRef.current;
    if (!c) return;
    const id = teamId ?? c.data?.id;
    if (!id) return;
    if (inflight.current > 0) { reloadWanted.current = true; return; } // don't clobber edits still being written
    const seqAtStart = editSeq.current;
    const [data, teams] = await Promise.all([loadTeam(id, c.me), listMyTeams()]);
    const cur = cloudRef.current;
    if (!cur || (cur.data && cur.data.id !== id)) return; // switched meanwhile
    if (editSeq.current !== seqAtStart) { reloadWanted.current = true; return; } // stale: an edit happened while fetching
    setCloud({ me: cur.me, teams, data });
  }, []);

  const connectCloud = useCallback(async () => {
    let me = await ensureSession();
    if (!me) return false;
    try {
      await ensureProfile();
    } catch {
      // A cached session for a user that no longer exists (or a revoked one): start over with a fresh Google token.
      await supabase.auth.signOut();
      me = await ensureSession();
      if (!me) return false;
      await ensureProfile();
    }
    const teams = await listMyTeams();
    const saved = localStorage.getItem(CURRENT_TEAM_KEY);
    const teamId = teams.length ? (teams.some((t) => t.id === saved) ? saved! : teams[0].id) : null;
    const data = teamId ? await loadTeam(teamId, me) : null; // no teams yet: the app shows the create/wait screen
    past.current = []; future.current = []; lastKey.current = undefined;
    setCloud({ me, teams, data });
    return true;
  }, []);

  // Invites land as team_members rows we can't subscribe to before we're a member, so re-check the
  // team list when the window regains focus and every 30s (ensure_profile attaches pending invites).
  useEffect(() => {
    if (!cloud) return;
    let busy = false;
    const check = async () => {
      if (busy || !cloudRef.current) return;
      // a parked window (hidden widget, covered main window) skips the poll; the focus
      // listener below runs this immediately when the user comes back
      if (document.visibilityState === 'hidden' || appIdle()) return;
      busy = true;
      try {
        await ensureProfile();
        const teams = await listMyTeams();
        const cur = cloudRef.current;
        if (!cur) return;
        const changed = JSON.stringify(teams) !== JSON.stringify(cur.teams);
        const lostCurrent = cur.data && !teams.some((t) => t.id === cur.data!.id);
        if (lostCurrent) {
          const data = teams.length ? await loadTeam(teams[0].id, cur.me) : null;
          setCloud({ me: cur.me, teams, data });
        } else if (changed) {
          const data = cur.data ?? (teams.length ? await loadTeam(teams[0].id, cur.me) : null);
          setCloud({ me: cur.me, teams, data });
        }
      } catch (e) { console.warn('[cloud] team check', e); }
      finally { busy = false; }
    };
    const iv = window.setInterval(check, 30_000);
    window.addEventListener('focus', check);
    return () => { window.clearInterval(iv); window.removeEventListener('focus', check); };
  }, [!!cloud]); // eslint-disable-line react-hooks/exhaustive-deps

  // Realtime: one channel per open team. A HIDDEN window (the pre-loaded menu-bar widget all
  // day, a closed-but-alive main window) doesn't reload on every teammate edit — that burned
  // battery re-fetching and re-rendering for nobody; it catches up the moment it's shown.
  const teamId = cloud?.data?.id;
  const me = cloud?.me;
  useEffect(() => {
    if (!teamId || !me) return;
    let lastReload = 0;
    return subscribeTeam(teamId, me, () => {
      // appIdle: the transparent mac window never reports occlusion, so 'hidden' alone
      // missed the covered-behind-other-apps case — teammate edits reloaded the whole
      // team all day for nobody. Parked edits catch up on focus/wake below — and a
      // 5-minute trickle bounds the staleness for a window someone merely WATCHES
      // (second monitor): parked is never more than 5 minutes behind.
      const parked = document.visibilityState === 'hidden' || appIdle();
      if (parked && Date.now() - lastReload < 300_000) { reloadWanted.current = true; return; }
      lastReload = Date.now();
      reload(teamId);
    }, (n) => {
      // banners must NOT park: a review request matters most while you work elsewhere.
      // Fired straight off the realtime row; the reload pass skips ids seen here.
      if (n.read || n.to !== me || bannered.has(n.id) || !window.exponential?.notify) return;
      bannered.add(n.id);
      window.exponential.notify({ id: n.id, title: 'Exponential', body: n.text, ref: n.ref });
    });
  }, [teamId, me, reload]);
  useEffect(() => {
    const vis = () => {
      if (document.visibilityState === 'visible' && reloadWanted.current && inflight.current === 0) { reloadWanted.current = false; reload(); }
    };
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('focus', vis);
    return () => { document.removeEventListener('visibilitychange', vis); window.removeEventListener('focus', vis); };
  }, [reload]);

  // The widget and the main window are separate renderers on the same machine: after either one
  // writes, it pings the other through the main process so changes (deletes included) show instantly.
  useEffect(() => {
    let timer: number | undefined;
    const off = window.exponential?.onCloudPing?.(() => {
      if (!cloudRef.current) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (document.visibilityState === 'hidden') { reloadWanted.current = true; return; }
        reload();
      }, 150);
    });
    return () => { window.clearTimeout(timer); off?.(); };
  }, [reload]);

  const writeDiff = (prev: Data, next: Data) => {
    editSeq.current++;
    inflight.current++;
    persistDiff(prev, next).finally(() => {
      inflight.current--;
      window.exponential?.pingCloud?.();
      if (inflight.current === 0 && reloadWanted.current) { reloadWanted.current = false; reload(); }
    });
  };

  /* ── shared ── */
  const currentData = (): Data | null => (cloudRef.current ? cloudRef.current.data : wsRef.current ? wsRef.current.teams.find((t) => t.id === wsRef.current!.current)! : null);

  const commitLocal = (next: Workspace) => {
    wsRef.current = next;
    setWs(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => persist(next), 300);
  };
  const replaceTeam = (w: Workspace, team: Data): Workspace => ({ ...w, teams: w.teams.map((t) => (t.id === team.id ? team : t)) });

  const commit = (next: Data) => {
    const c = cloudRef.current;
    if (c) { const nc = { ...c, data: next, teams: c.teams.map((t) => (t.id === next.id ? { id: t.id, name: next.name, icon: next.icon } : t)) }; cloudRef.current = nc; setCloud(nc); }
    else if (wsRef.current) commitLocal(replaceTeam(wsRef.current, next));
  };

  // Side effects stay outside React's updater functions (which run twice in Strict Mode).
  const update = useCallback((fn: (d: Data) => Data, coalesceKey?: string) => {
    const prev = currentData();
    if (!prev) return;
    const next = fn(prev);
    if (next === prev) return;
    // Same-key edits collapse only while they keep coming: a pause starts a fresh step,
    // so undo rewinds typing burst by burst instead of zapping the whole session.
    const now = Date.now();
    if (!coalesceKey || coalesceKey !== lastKey.current || now - lastKeyAt.current > 1200) {
      past.current.push(prev);
      if (past.current.length > HISTORY) past.current.shift();
    }
    lastKey.current = coalesceKey;
    lastKeyAt.current = now;
    future.current = [];
    editSeq.current++;
    commit(next);
    if (cloudRef.current) writeDiff(prev, next);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const undo = useCallback(() => {
    const cur = currentData();
    const prev = past.current.pop();
    if (!cur || !prev || prev.id !== cur.id) return;
    future.current.push(cur);
    lastKey.current = undefined;
    commit(prev);
    if (cloudRef.current) writeDiff(cur, prev);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const redo = useCallback(() => {
    const cur = currentData();
    const next = future.current.pop();
    if (!cur || !next || next.id !== cur.id) return;
    past.current.push(cur);
    lastKey.current = undefined;
    commit(next);
    if (cloudRef.current) writeDiff(cur, next);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Switching teams resets the undo stack; history is per team. */
  const switchTeam = useCallback(async (id: string) => {
    past.current = []; future.current = []; lastKey.current = undefined;
    const c = cloudRef.current;
    if (c) {
      if (!c.teams.some((t) => t.id === id)) return;
      localStorage.setItem(CURRENT_TEAM_KEY, id);
      const data = await loadTeam(id, c.me);
      setCloud({ ...cloudRef.current!, data });
      return;
    }
    const w = wsRef.current;
    if (!w || !w.teams.some((t) => t.id === id)) return;
    commitLocal({ ...w, current: id });
  }, []);

  const createTeam = useCallback(async (name: string) => {
    const c = cloudRef.current;
    if (c) {
      const id = await cloudCreateTeam(name);
      const teams = await listMyTeams();
      localStorage.setItem(CURRENT_TEAM_KEY, id);
      const data = await loadTeam(id, c.me);
      past.current = []; future.current = []; lastKey.current = undefined;
      setCloud({ me: c.me, teams, data });
      return;
    }
    const w = wsRef.current;
    if (!w) return;
    const me0 = current(w).people.find((p) => p.id === current(w).me)!;
    const team: Data = { id: uid(), name, moderators: ['me'], me: 'me', people: [{ ...me0, id: 'me' }], projects: [], deadlines: [], tasks: [], notifications: [] };
    past.current = []; future.current = []; lastKey.current = undefined;
    commitLocal({ teams: [...w.teams, team], current: team.id });
  }, []);

  const deleteTeam = useCallback(async (id: string) => {
    const c = cloudRef.current;
    if (c) {
      await cloudDeleteTeam(id);
      const teams = await listMyTeams();
      const data = teams.length ? await loadTeam(teams[0].id, c.me) : null;
      past.current = []; future.current = []; lastKey.current = undefined;
      setCloud({ me: c.me, teams, data });
      return;
    }
    const w = wsRef.current;
    if (!w || w.teams.length <= 1) return;
    const teams = w.teams.filter((t) => t.id !== id);
    commitLocal({ teams, current: w.current === id ? teams[0].id : w.current });
  }, []);

  const current = (w: Workspace) => w.teams.find((t) => t.id === w.current)!;

  const data = cloud ? cloud.data : ws ? current(ws) : null;
  const teams: TeamSummary[] = cloud ? cloud.teams : (ws?.teams ?? []).map((t) => ({ id: t.id, name: t.name, icon: t.icon }));
  return { data, teams, update, undo, redo, switchTeam, createTeam, deleteTeam, connectCloud, cloudMode: !!cloud, refresh: reload };
}
