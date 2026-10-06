import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { BigPlan } from './BigPlan';
import { Avatar, WeekPlan } from './WeekPlan';
import { DetailPanel, type Selection } from './DetailPanel';
import { appIdle, onAppWake } from './idle';
import { TeamPage } from './TeamPage';
import logoUrl from '../build/icon.png';
import utopiaUrl from '../build/utopia.svg';
import { LiquidMetal } from '@paper-design/shaders-react';
import { useData, useSystemNotifications, uid, type GoogleConfig } from './store';
import type { CalendarEvent, Data, Deadline, GoogleUser, Group, ISODate, Project, Retro, Task } from './types';
import { DEFAULT_RETRO_FIELDS, PROJECT_COLORS, shortName } from './types';
import { addTask, claimTask, completeReview, denyReview, nameOf, notify, patchTask, purgeTrash, renameTask, reorderTask, softDelete, unclaimTask } from './taskOps';
import { isPending, loadTeam, onPersistError, persistDiff, signOutCloud, subscribeTeam, supabase, usageMonthTotal, webSignIn } from './cloud';
import { enablePush, pushEnabled, pushSupport } from './push';
import { addDays, todayISO, weekStart } from './dates';
import { ChatPage } from './ChatPage';
import { fetchChat, mentionsToNames, onChatEvent, purgeExpiredChatFiles, subscribeChat, type Channel } from './chat';
import { MeetingsPage } from './MeetingsPage';
import { CrmPage } from './CrmPage';
import { hasCrm } from './crmSheet';
import { subscribeMeetings } from './meetings';

/** Layout proportions, remembered per machine (not part of the shared plan data). */
const PREFS_KEY = 'exponential-layout';
const DEFAULT_PREFS = { weekH: 400, detailW: 415, theme: '' as '' | 'light' | 'dark', calendar: true, allTeams: false };
const prefs: typeof DEFAULT_PREFS = (() => {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }; } catch { return DEFAULT_PREFS; }
})();
const savePrefs = (p: typeof DEFAULT_PREFS) => localStorage.setItem(PREFS_KEY, JSON.stringify(p));

/* ── render-storm control ─────────────────────────────────────────────────────
   The planners used to re-render on EVERY App render — a chat ping, a calendar refresh,
   a realtime reload each re-did the lanes math and repainted the whole window. They are
   memo()d with a comparator that IGNORES function props: App recreates its handler
   closures every render, and comparing them would defeat the memo entirely.
   THE CONTRACT that makes skipping safe: any state a planner handler reads must ALSO
   reach that planner as a non-function prop (or be a ref / setState setter) — then every
   change that could matter re-renders the planner and refreshes its closures. A handler
   that closes over state with no matching data prop WILL go stale. */
const skipFnProps = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const x = a[k], y = b[k];
    if (typeof x === 'function' && typeof y === 'function') continue;
    if (!Object.is(x, y)) return false;
  }
  return true;
};
const BigPlanM = memo(BigPlan, skipFnProps);
const WeekPlanM = memo(WeekPlan, skipFnProps);
const DetailPanelM = memo(DetailPanel, skipFnProps);

/* Identity caches for derived props (hook-free — some sit below App's early returns,
   where useMemo is illegal). Same inputs → the SAME object, so the memo()s above hold. */
const memo1 = <A extends unknown[], R>(fn: (...a: A) => R) => {
  let key: A | null = null; let val: R;
  return (...a: A): R => {
    if (!key || key.length !== a.length || a.some((x, i) => !Object.is(x, key![i]))) { key = a as A; val = fn(...a); }
    return val;
  };
};
const liveOf = memo1((d: Data) => ({ ...d, projects: d.projects.filter((p) => !p.deletedAt), tasks: d.tasks.filter((t) => !t.deletedAt) }));
const groupsOf = memo1((g: Group[] | undefined) => g ?? []);
const notifsOf = memo1((n: Data['notifications'] | undefined) => n ?? []);
const weekTasksOf = memo1((tasks: Task[], fTasks: Task[] | null, person: string, week: ISODate) =>
  [...tasks, ...(fTasks?.filter((t) => t.personId === person) ?? [])]
    .filter((t) => (t.personId === person || (t.reviewerId === person && (t.status === 'review' || t.reviewDone))) && (!t.date || (t.date <= addDays(week, 6) && (t.end ?? t.date) >= week))));
const allTeamsOf = memo1((enabled: boolean, on: boolean, set: (f: (v: boolean) => boolean) => void) =>
  enabled ? { on, toggle: () => set((v) => !v) } : undefined);
const foreignOf = memo1((foreignTeams: Map<string, Data> | null, currentId: string | undefined, teams: { id: string; name: string; icon?: string | null }[]) => {
  if (!foreignTeams) return null;
  const tasks: Task[] = [];
  const badge = new Map<string, { id: string; name: string; icon?: string }>();
  const teamOf = new Map<string, string>();
  for (const [tid, fd] of foreignTeams) {
    if (tid === currentId) continue; // just switched here: its tasks are the LIVE ones now (the refetch hasn't caught up yet)
    const info = teams.find((t) => t.id === tid);
    for (const t of fd.tasks) {
      if (t.deletedAt) continue;
      tasks.push(t);
      badge.set(t.id, { id: tid, name: info?.name ?? fd.name, icon: info?.icon ?? fd.icon ?? undefined });
      teamOf.set(t.id, tid);
    }
  }
  return { tasks, badge, teamOf };
});
const NO_EVENTS: CalendarEvent[] = []; // a fresh `?? []` every render would defeat the caches below
const calendarOf = memo1((enabled: boolean, available: boolean, hidden: boolean, events: CalendarEvent[], note: string | undefined, reauth: boolean, onReauth: () => void) =>
  ({ enabled, available, hidden, events, note, onReauth: reauth ? onReauth : undefined }));
const carriedOf = memo1((retros: Data['retros'], monday: string | null) => {
  if (monday === null) return undefined;
  // OKR scores roll forward: a new week starts where the last one left off
  const m: Record<string, number> = {};
  for (const w of Object.keys(retros ?? {}).sort()) {
    if (w >= monday) break;
    Object.assign(m, retros![w].answers.confidence ?? {});
  }
  return m;
});

// The splash shader starts on its clean frame and sweeps its stripes once per cycle;
// the splash holds for whole cycles so it always exits right as the stripes clear.
const SPLASH_SPEED = 1.28;
const SPLASH_CYCLE_MS = 1000 / (0.3 * SPLASH_SPEED); // ≈2.6s per sweep, from the shader's time scale
// Start the shader one second earlier in its own timeline (expressed positively as cycle − 1s of playback).
const SPLASH_FRAME = 1000 / 0.3 - 1000 * SPLASH_SPEED;

export default function App() {
  const { data, teams, update, undo, redo, switchTeam, createTeam, deleteTeam, connectCloud, cloudMode } = useData();
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [updateInfo, setUpdateState] = useState<{ state: string; version?: string; percent?: number } | null>(null);
  const [appVersion, setAppVersion] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => onPersistError((m) => { setSaveError(m); window.setTimeout(() => setSaveError(null), 8000); }), []);
  useEffect(() => {
    window.exponential?.version().then(setAppVersion);
    return window.exponential?.onUpdate((s) => setUpdateState((prev) => (s.state === 'checking' ? prev : s)));
  }, []);
  const [view, setView] = useState<'plan' | 'team'>('plan');
  // Chat and Meetings use a LEFT side panel (both sides can be open at once); CRM owns the entire content area when selected.
  const [leftPanel, setLeftPanel] = useState<'chat' | 'meetings' | 'crm' | null>(null);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 700px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 700px)');
    const on = () => setIsMobile(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const mobileShell = !window.exponential && isMobile;
  const [leftW, setLeftW] = useState(415);
  const [lResizing, setLResizing] = useState(false);
  const leftWRef = useRef(leftW); leftWRef.current = leftW;
  // The centre (planners) always keeps at least a third of the window; the two side
  // panels split what's left, each at least ~a fifth (never less than 240px).
  const sideBudget = () => window.innerWidth - 106 - Math.floor(window.innerWidth / 3); // 106 = sidebar + shell padding + slot margins, measured (hover-expand overlaps briefly, no re-clamp)
  const minPanelW = () => Math.max(240, Math.min(Math.floor(window.innerWidth / 5), Math.floor((sideBudget() - 28) / 2)));
  const onLResizeDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX, startW = leftW;
    setLResizing(true);
    const move = (ev: PointerEvent) => {
      const max = sideBudget() - 14 - (detailRef.current ? detailWRef.current + 14 : 0);
      setLeftW(Math.max(minPanelW(), Math.min(max, startW + (ev.clientX - startX))));
    };
    const up = () => { setLResizing(false); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const [today, setToday] = useState(todayISO());
  const [week, setWeek] = useState(() => weekStart(todayISO()));
  const [selectedPerson, setSelectedPerson] = useState<string | null>(null);
  const [weekH, setWeekH] = useState(() => prefs.weekH);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [sheet, setSheet] = useState<'settings' | 'new-team' | 'group' | null>(null);
  // The master plan is read-only until unlocked; it locks itself again when attention moves elsewhere.
  const [unlocked, setUnlocked] = useState(false);
  const planSecRef = useRef<HTMLElement>(null);
  const [editGroup, setEditGroup] = useState<Group | null>(null); // group being edited in the group sheet
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingNew = useRef(false); // fresh task (Enter chains another) vs a double-click rename (Enter just commits)
  const [multi, setMulti] = useState<Set<string>>(new Set()); // shift/cmd-click selection across both panels
  const toggleSelect = (id: string) => setMulti((m) => {
    const n = new Set(m);
    // the item open in the side panel looks selected, so it joins the multi-selection on the first modifier-click
    if (n.size === 0 && selection && ['project', 'task', 'deadline'].includes(selection.kind) && selection.id !== id) n.add(selection.id);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const [resizing, setResizing] = useState(false);
  const [detailW, setDetailW] = useState(() => prefs.detailW);
  const [slotAnimating, setSlotAnimating] = useState(false); // clip the slot only while its width is changing
  const openKind = selection?.kind ?? null;
  const prevOpenKind = useRef(openKind);
  useEffect(() => {
    const wasOpen = prevOpenKind.current !== null, isOpen = openKind !== null;
    prevOpenKind.current = openKind;
    // phone: the slot is a fixed overlay with no width transition — a transitionend would
    // never fire and 'clip' would stick, hiding the panel forever
    const phone = !window.exponential && window.matchMedia('(max-width: 700px)').matches;
    if (wasOpen !== isOpen && !phone) setSlotAnimating(true);
  }, [openKind]);

  // The plan stays unlocked while you work in the app; it relocks only when the window
  // loses focus, Team settings opens, or the team changes.
  useEffect(() => {
    if (!unlocked) return;
    const blur = () => setUnlocked(false);
    window.addEventListener('blur', blur);
    return () => window.removeEventListener('blur', blur);
  }, [unlocked]);
  useEffect(() => { if (view !== 'plan') setUnlocked(false); }, [view]);
  const teamIdForLock = data?.id;
  useEffect(() => { setUnlocked(false); }, [teamIdForLock]);

  // macOS says notifications are off for the app: offer the settings pane once.
  const [notifyBlocked, setNotifyBlocked] = useState(false);
  useEffect(() => window.exponential?.onNotifyBlocked?.(() => setNotifyBlocked(true)), []);

  // Theme follows the system by default ('' = auto, live); toggling to the opposite of the system
  // is an explicit override, toggling back to what the system shows returns to following it.
  const [themePref, setThemePref] = useState<'' | 'light' | 'dark'>(prefs.theme);
  const [sysDark, setSysDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const h = () => setSysDark(mq.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  const theme: 'light' | 'dark' = (mobileShell ? '' : themePref) || (sysDark ? 'dark' : 'light'); // phones always follow the system
  // Light → Dark → Auto (follow the system) → Light …
  const cycleTheme = () => setThemePref((p) => (p === 'light' ? 'dark' : p === 'dark' ? '' : 'light'));
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const [calendarOn, setCalendarOn] = useState(() => prefs.calendar);
  const [allTeamsOn, setAllTeamsOn] = useState(() => prefs.allTeams);
  useEffect(() => { savePrefs({ weekH, detailW, theme: themePref, calendar: calendarOn, allTeams: allTeamsOn }); }, [weekH, detailW, themePref, calendarOn, allTeamsOn]);
  const [vResizing, setVResizing] = useState(false);

  const detailWRef = useRef(detailW); detailWRef.current = detailW;
  const detailRef = useRef(false);
  const leftOpenRef = useRef(false);
  const onVResizeDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX, startW = detailW;
    setVResizing(true);
    const move = (ev: PointerEvent) => {
      const max = sideBudget() - 14 - (leftOpenRef.current ? leftWRef.current + 14 : 0);
      setDetailW(Math.max(minPanelW(), Math.min(max, startW - (ev.clientX - startX))));
    };
    const up = () => { setVResizing(false); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  // window resizes (and panels opening) re-fit both widths so no column gets squished
  useEffect(() => {
    const fit = () => {
      if (mobileShell) return; // phone: both slots are full-screen overlays, no width budget
      const mp = minPanelW();
      const budget = sideBudget();
      setDetailW((w) => Math.max(mp, Math.min(w, budget - 14 - (leftOpenRef.current ? leftWRef.current + 14 : 0))));
      setLeftW((w) => Math.max(mp, Math.min(w, budget - 14 - (detailRef.current ? detailWRef.current + 14 : 0))));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [leftPanel, selection?.kind, mobileShell]); // eslint-disable-line react-hooks/exhaustive-deps
  const mainRef = useRef<HTMLDivElement>(null);

  // Launch splash: the mark slides in from the bottom, plays at least one full shader sweep,
  // and once the teams are loaded it slides up and fades — timed to a sweep boundary, so the
  // stripes have just cleared when it goes.
  // Hosted web app (the PWA): anything that isn't Electron and isn't the local dev preview
  // signs in with Google; localhost can opt in with ?cloud for testing the web flow.
  const hostedWeb = !window.exponential && (!['localhost', '127.0.0.1'].includes(location.hostname) || new URLSearchParams(location.search).has('cloud'));
  const [googleUser, setGoogleUser] = useState<GoogleUser | null>(null);
  const [mTeamsOpen, setMTeamsOpen] = useState(false);
  const chatBackRef = useRef<(() => boolean) | null>(null);
  const crmBackRef = useRef<(() => boolean) | null>(null);
  // The CRM item appears only for a team whose crm_people table has rows (one head count per team switch),
  // so the other teams on Exponential never see an empty CRM.
  const [crmTeam, setCrmTeam] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setCrmTeam(null);
    if (data?.id) hasCrm(data.id, cloudMode).then((yes) => { if (live && yes) setCrmTeam(data.id); }).catch(() => {});
    return () => { live = false; };
  }, [data?.id, cloudMode]);
  // A tapped push notification's target conversation. Kept in a ref because the deep-link
  // arrives at mount, BEFORE the team loads — the team-load chat reset used to wipe the
  // chatActive it had set, so every cold start landed on the plan instead of the thread.
  const pendingChatRef = useRef<{ id: string; at: number } | null>(null);
  const selRef = useRef<Selection | null>(null);
  selRef.current = selection;
  // iOS back-swipe must navigate INSIDE the app — the browser history behind it holds the
  // Google OAuth pages. A sentinel entry absorbs every back gesture and maps it to app
  // navigation: close the open item, else leave the thread, else stay put.
  useEffect(() => {
    if (!mobileShell) return;
    // TWO sentinels: even if a gesture races the re-push, the second entry still stands
    // between the user and the OAuth pages further down the stack.
    history.pushState({ exp: 1 }, '');
    history.pushState({ exp: 2 }, '');
    const onPop = () => {
      history.pushState({ exp: 2 }, '');
      if (crmBackRef.current) { if (!crmBackRef.current()) setLeftPanel(null); return; }
      if (selRef.current) { setSelection(null); return; }
      if (chatBackRef.current?.()) return;
      if (leftOpenRef.current) setLeftPanel(null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [mobileShell]);

  // Web self-update: the served version.json changes on every deploy; when it stops
  // matching the running build, offer a one-tap refresh (the service worker fetches
  // navigations network-first, so the reload really gets the new build). Checked on
  // focus and every 15 minutes — no reinstall, no waiting for iOS to evict the page.
  const [webUpdate, setWebUpdate] = useState(false);
  useEffect(() => {
    if (window.exponential) return; // Electron has its own updater
    let stop = false;
    const check = async () => {
      try {
        const r = await fetch('./version.json', { cache: 'no-store' });
        if (!r.ok) return; // dev server has no version.json
        const v = await r.json() as { build?: string };
        if (!stop && v.build && v.build !== __BUILD__) setWebUpdate(true);
      } catch { /* offline — try again later */ }
    };
    const t = window.setInterval(check, 15 * 60_000);
    const vis = () => { if (!document.hidden) check(); };
    document.addEventListener('visibilitychange', vis);
    check();
    return () => { stop = true; window.clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, []);

  // A tapped push notification lands IN that conversation: the service worker either
  // postMessages a running window or opens ./?chat=<id> for a cold start.
  useEffect(() => {
    if (window.exponential) return;
    const openChat = (id: string, src: string) => {
      pendingChatRef.current = { id, at: Date.now() };
      try { localStorage.setItem('exponential-link-log', `${src} ${new Date().toTimeString().slice(0, 8)}`); } catch { /* private mode */ }
      setLeftPanel('chat'); setChatActive(id); setChatJump(true);
    };
    const boot = new URLSearchParams(location.search).get('chat');
    if (boot) {
      openChat(boot, 'url');
      const url = new URL(location.href);
      url.searchParams.delete('chat');
      history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    }
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; channelId?: string } | null;
      if (d?.type === 'open-chat' && d.channelId) openChat(d.channelId, 'msg');
    };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    navigator.serviceWorker?.startMessages?.(); // without this, worker→page messages stay queued forever
    // The reliable path: the worker leaves the pending chat in the shared cache; consume
    // it on boot and whenever the app returns to the foreground (suspended-page
    // postMessage delivery is flaky on iOS).
    const consumePending = async () => {
      try {
        const store = await caches.open('exp-pending');
        const note = await store.match('./pending-chat');
        if (!note) return;
        await store.delete('./pending-chat');
        const raw = (await note.text()).trim();
        let id = raw, at = 0;
        try { const j = JSON.parse(raw) as { id?: string; at?: number }; id = j.id ?? ''; at = j.at ?? 0; } catch { /* pre-JSON note: the bare id */ }
        // a note an old page never consumed shouldn't ghost-open a chat days later
        if (id && (!at || Date.now() - at < 10 * 60_000)) openChat(id, 'note');
      } catch { /* cache unavailable (private mode etc.) */ }
    };
    consumePending();
    const onVis = () => { if (!document.hidden) consumePending(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pageshow', onVis);
    return () => {
      navigator.serviceWorker?.removeEventListener('message', onMsg);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pageshow', onVis);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Kill Safari's edge-swipe navigation OUTRIGHT: the gesture only starts when a touch
  // BEGINS in the screen-edge bezel, and preventDefault on that touchstart stops it cold.
  // preventDefault also swallows the tap's synthesized click, so a still tap in the strip
  // re-triggers its control manually (buttons/links click, editables focus).
  useEffect(() => {
    if (!mobileShell) return;
    const EDGE = 28;
    let edge: { id: number; x: number; y: number; lx: number; ly: number; target: EventTarget | null; scroller: HTMLElement | null | undefined } | null = null;
    // preventDefault killed the NATIVE scroll too — a swipe that starts in the edge strip
    // now scrolls the nearest scrollable ancestor manually (thumbs live in that strip)
    const findScroller = (from: EventTarget | null): HTMLElement | null => {
      let el = from as HTMLElement | null;
      if (el?.closest?.('.wk-block, .wk-list, .timeline')) return null; // those own their touches
      while (el) {
        const cs = getComputedStyle(el);
        if ((/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4)
          || (/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 4)) return el;
        el = el.parentElement;
      }
      return null;
    };
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (e.touches.length === 1 && (t.pageX < EDGE || t.pageX > window.innerWidth - EDGE)) {
        e.preventDefault();
        edge = { id: t.identifier, x: t.pageX, y: t.pageY, lx: t.pageX, ly: t.pageY, target: e.target, scroller: undefined };
      }
    };
    const onMove = (e: TouchEvent) => {
      if (!edge) return;
      const t = [...e.touches].find((x) => x.identifier === edge!.id);
      if (!t) return;
      const dx = t.pageX - edge.lx, dy = t.pageY - edge.ly;
      edge.lx = t.pageX; edge.ly = t.pageY;
      if (edge.scroller === undefined && (Math.abs(t.pageX - edge.x) > 8 || Math.abs(t.pageY - edge.y) > 8)) edge.scroller = findScroller(edge.target);
      if (edge.scroller) { edge.scroller.scrollTop -= dy; edge.scroller.scrollLeft -= dx; }
    };
    const onEnd = (e: TouchEvent) => {
      if (!edge) return;
      const t = [...e.changedTouches].find((x) => x.identifier === edge!.id);
      const was = edge;
      edge = null;
      if (!t || Math.abs(t.pageX - was.x) > 8 || Math.abs(t.pageY - was.y) > 8) return;
      const el = (was.target as HTMLElement | null)?.closest?.('input, textarea, [contenteditable="true"], button, a, [role="button"]') as HTMLElement | null;
      if (!el) return;
      if (el.matches('input, textarea, [contenteditable="true"]')) el.focus();
      else el.click();
    };
    document.addEventListener('touchstart', onStart, { passive: false });
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    };
  }, [mobileShell]);
  // Web Push (iPhone): 'ok-off' shows the enable pill, 'install' explains Add-to-Home-Screen.
  const [pushState, setPushState] = useState<'unknown' | 'ok-off' | 'on' | 'install' | 'none'>('unknown');
  useEffect(() => {
    if (window.exponential) return;
    const s = pushSupport();
    if (s === 'ok') pushEnabled().then((on) => setPushState(on ? 'on' : 'ok-off')).catch(() => setPushState('ok-off'));
    else setPushState(s === 'needs-install' ? 'install' : 'none');
  }, []);
  const [authChecked, setAuthChecked] = useState(!window.exponential); // browser preview has no Google

  const [splash, setSplash] = useState<'in' | 'out' | 'gone'>(() => (window.exponential || hostedWeb ? 'in' : 'gone'));
  const splashStart = useRef(performance.now());
  useEffect(() => {
    // web without a session exits the splash into the sign-in gate; everyone else holds it until the team is loaded
    if (splash === 'in' && (cloudMode || (hostedWeb && authChecked && !googleUser))) {
      const elapsed = performance.now() - splashStart.current;
      const target = Math.max(1, Math.ceil(elapsed / SPLASH_CYCLE_MS)) * SPLASH_CYCLE_MS;
      const t = window.setTimeout(() => setSplash('out'), target - elapsed);
      return () => window.clearTimeout(t);
    }
    if (splash === 'out') { const t = window.setTimeout(() => setSplash('gone'), 480); return () => window.clearTimeout(t); }
  }, [splash, cloudMode, hostedWeb, authChecked, googleUser]); // eslint-disable-line react-hooks/exhaustive-deps
  const [googleConfig, setGoogleConfig] = useState<GoogleConfig | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [calEvents, setCalEvents] = useState<Record<string, CalendarEvent[]>>({});
  const [calNote, setCalNote] = useState<string | undefined>();

  useEffect(() => {
    const t = setInterval(() => setToday(todayISO()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Undo/redo has ONE brain for its two routes: in Electron the Edit menu owns ⌘Z (menu
  // accelerators consume the key before the page sees any keydown) and sends edit:command;
  // in the browser preview the keydown below catches it. Plain inputs/textareas (inline
  // renames, sheet fields) keep the browser's own text undo — their text is transient until
  // blur/Enter. Contenteditables (notes blocks, task titles) commit every keystroke to data,
  // so app history IS their text undo. The 80ms guard collapses a double delivery.
  const lastEditCmd = useRef(0);
  const editCommand = useCallback((kind: 'undo' | 'redo') => {
    const t = performance.now();
    if (t - lastEditCmd.current < 80) return;
    lastEditCmd.current = t;
    const el = document.activeElement as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) { document.execCommand(kind); return; }
    if (kind === 'undo') undo(); else redo();
  }, [undo, redo]);
  useEffect(() => window.exponential?.onEditCommand?.(editCommand), [editCommand]);
  // Native history mutations inside contenteditables (any route the menu rewire missed)
  // would rewrite the DOM behind the markdown model — block them outright.
  useEffect(() => {
    const block = (e: Event) => {
      const ie = e as InputEvent;
      if ((ie.inputType === 'historyUndo' || ie.inputType === 'historyRedo') && (e.target as HTMLElement).isContentEditable) e.preventDefault();
    };
    window.addEventListener('beforeinput', block, true);
    return () => window.removeEventListener('beforeinput', block, true);
  }, []);

  // ⌘Z / ⌘⇧Z (Ctrl on Windows); Backspace/Delete removes the multi-selection; Escape clears it.
  // Text fields keep their other keys while focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return; // native text undo
        e.preventDefault();
        editCommand(e.shiftKey ? 'redo' : 'undo');
        return;
      }
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.key === 'Backspace' || e.key === 'Delete') {
        // A block selection in the notes editor owns Backspace (it blurs the input, so
        // the focus check above doesn't catch it) — deleting blocks must not delete the item.
        if (document.querySelector('.blk-list.selecting')) return;
        // The multi-selection wins; otherwise whatever is open in the side panel gets deleted.
        const ids = multi.size ? multi
          : selection && ['project', 'task', 'deadline'].includes(selection.kind) ? new Set([selection.id])
          : null;
        if (!ids) return;
        // The master plan is read-only while locked: its projects and deadlines survive
        // Backspace (week-view tasks have no lock and always delete).
        const allowed = unlocked ? ids : new Set([...ids].filter((id) => !(data?.projects.some((p) => p.id === id) || data?.deadlines.some((x) => x.id === id))));
        if (!allowed.size) return;
        e.preventDefault();
        update((d) => softDelete(d, allowed));
        if (selection && allowed.has(selection.id)) setSelection(null);
        setMulti(new Set());
      }
      if (e.key === 'Escape') { if (multi.size) setMulti(new Set()); setUnlocked(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editCommand, multi, selection, update, unlocked, data]);

  /** Right-click Delete on a multi-selection removes everything selected, like Backspace. */
  const deleteMany = (ids: string[]) => {
    update((d) => softDelete(d, ids));
    if (selection && ids.includes(selection.id)) setSelection(null);
    setMulti(new Set());
  };

  /** Plain click on a single item: the multi-selection gives way to it. */
  const open = (kind: Selection['kind'], id: string) => {
    setMulti((m) => (m.size ? new Set<string>() : m));
    setSelection({ kind, id } as Selection);
  };

  const updateTask = (id: string, patch: Partial<Task>, coalesce?: string) => update((d) => patchTask(d, id, patch), coalesce);

  /** Master-plan edits are QUIET — moving/renaming/retouching a project notifies nobody
   *  (it used to ping every assignee). Being ADDED to a project still notifies you. */
  const updateProject = (id: string, patch: Partial<Project>, coalesce?: string) =>
    update((d) => {
      const before = d.projects.find((p) => p.id === id);
      if (!before) return d;
      if (Object.entries(patch).every(([k, v]) => Object.is(before[k as keyof Project], v))) return d; // no-op: no phantom undo step
      const after = { ...before, ...patch };
      let next: Data = { ...d, projects: d.projects.map((p) => (p.id === id ? after : p)) };
      if (patch.assignees) {
        for (const pid of patch.assignees.filter((x) => !before.assignees?.includes(x))) {
          next = notify(next, { to: pid, from: d.me, kind: 'project-changed', text: `${nameOf(d, d.me)} added you to “${after.name}”`, ref: { kind: 'project', id } });
        }
      }
      return next;
    }, coalesce);

  /* ── chat: channel list + unread live at App level so the sidebar badges and native
     notifications work from any view; messages themselves load inside ChatPage. ── */
  const [chat, setChat] = useState<Channel[]>([]);
  const [chatActive, setChatActive] = useState<string | null>(null);
  const [chatJump, setChatJump] = useState(false); // a clicked notification opens the thread itself, not the list
  const chatTeam = data?.id;
  const chatViewRef = useRef({ panel: null as string | null, chatActive });
  chatViewRef.current = { panel: leftPanel, chatActive };
  const refreshChat = useCallback(() => {
    const d = { id: chatTeam, me: data?.me };
    if (!d.id || !d.me) return;
    fetchChat(d.id, d.me, cloudMode).then((chs) => {
      setChat(chs);
      const want = pendingChatRef.current; // a push deep-link outlives the team-load reset below
      if (want && Date.now() - want.at < 2 * 60_000 && chs.some((c) => c.id === want.id)) {
        setLeftPanel('chat'); setChatActive(want.id); setChatJump(true);
        return;
      }
      setChatActive((cur) => cur && chs.some((c) => c.id === cur) ? cur : chs[0]?.id ?? null);
    }).catch(() => {});
  }, [chatTeam, data?.me, cloudMode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setChat([]); setChatActive(null); refreshChat(); }, [chatTeam, cloudMode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!chatTeam || !cloudMode) return; return subscribeChat(chatTeam, cloudMode); }, [chatTeam, cloudMode]);
  useEffect(() => { // 30-day chat-file lifetime: sweep my expired uploads (moderators: everyone's), once per team per session
    if (!chatTeam || !cloudMode || !data) return;
    purgeExpiredChatFiles(chatTeam, data.me, data.moderators.includes(data.me), true).catch(() => {});
  }, [chatTeam, cloudMode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onChatEvent((e) => {
    if (e.teamId !== chatTeam || !data) return;
    if (e.type === 'channels') { refreshChat(); return; }
    if (e.type !== 'message' || e.message.author === data.me) return;
    const { panel, chatActive: act } = chatViewRef.current;
    const reading = panel === 'chat' && act === e.message.channelId && document.hasFocus();
    if (!reading) {
      setChat((chs) => chs.map((c) => (c.id === e.message.channelId ? { ...c, unread: c.unread + 1, lastAt: e.message.at } : c)));
      const who = shortName(data.people.find((x) => x.id === e.message.author)?.name ?? 'Someone');
      const ch = chat.find((c) => c.id === e.message.channelId);
      const body = mentionsToNames(e.message.body, data.people) || (e.message.attachments?.length ? (e.message.attachments[0].type.startsWith('image/') ? '📷 Image' : e.message.attachments[0].name) : '');
      const title = ch && ch.name.startsWith('dm:') ? who : `#${ch?.name ?? 'chat'} · ${who}`;
      window.exponential?.notify?.({ id: e.message.id, title, body, ref: { kind: 'chat', id: e.message.channelId } });
    }
  }), [chatTeam, data, chat, refreshChat]);

  // Egress early-warning: the team's own metered usage (usage_log, patch 009) summed
  // for the month — moderators see a banner at 70% of the Pro quota, red at 90%,
  // long before Supabase itself would restrict anything.
  const QUOTA_GB = 250;
  const [usageWarn, setUsageWarn] = useState<{ gb: number; pct: number } | null>(null);
  const [usageDismissed, setUsageDismissed] = useState(false);
  useEffect(() => {
    if (!cloudMode) return;
    let stop = false;
    const check = async () => {
      const bytes = await usageMonthTotal();
      if (stop || bytes === null) return;
      const gb = bytes / 1e9;
      const pct = Math.round((gb / QUOTA_GB) * 100);
      setUsageWarn(pct >= 70 ? { gb: Math.round(gb), pct } : null);
    };
    check();
    const t = window.setInterval(check, 6 * 60 * 60 * 1000);
    return () => { stop = true; window.clearInterval(t); };
  }, [cloudMode]);

  // Meetings shared with me: a red dot on the sidebar + a system notification, from an
  // app-level realtime subscription (the page has its own for its list).
  const [meetDot, setMeetDot] = useState(false);
  const meetSeen = useRef(new Set<string>());
  const meetTeam = data?.id;
  useEffect(() => {
    if (!cloudMode || !meetTeam || !data?.me) return;
    return subscribeMeetings(meetTeam, cloudMode, (m, ev) => {
      if (!m || ev !== 'INSERT' || m.owner === data.me || meetSeen.current.has(m.id)) return;
      meetSeen.current.add(m.id);
      setMeetDot(true);
      const who = shortName(data.people.find((x) => x.id === m.owner)?.name ?? 'Someone');
      window.exponential?.notify?.({ id: `meet-${m.id}`, title: 'New meeting', body: `${who} shared “${m.title}”`, ref: { kind: 'meeting', id: m.id } });
    }, 'meetings-inbox');
  }, [cloudMode, meetTeam, data?.me]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (leftPanel === 'meetings') setMeetDot(false); }, [leftPanel]);
  useEffect(() => { leftOpenRef.current = leftPanel !== null; }, [leftPanel]);

  // The menu-bar widget can ask the main window to open a specific item.
  useEffect(() => window.exponential?.onOpen((t) => {
    if (t.kind === 'chat') { setLeftPanel('chat'); setChatActive(t.id); setChatJump(true); return; }
    if (t.kind === 'meeting') { setLeftPanel('meetings'); return; }
    setLeftPanel((current) => current === 'crm' ? null : current);
    setView('plan'); setSelection(t as Selection);
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  useSystemNotifications(data);

  // Trash housekeeping: anything deleted more than 7 days ago is removed for real (once per team per session).
  const purgedTeam = useRef<string | null>(null);
  useEffect(() => {
    if (!data || purgedTeam.current === data.id) return;
    purgedTeam.current = data.id;
    if (purgeTrash(data) !== data) update((d) => purgeTrash(d));
  }, [data, update]);

  // The MCP server (Claude) reads this to know the current team and whether plan edits are allowed.
  useEffect(() => {
    window.exponential?.setSharedState?.({ teamId: data?.id ?? null, teamName: data?.name ?? null, planUnlocked: unlocked });
  }, [data?.id, data?.name, unlocked]);

  // Google: restore session on launch. Web (the hosted PWA): a persisted Supabase session
  // — or the one arriving via the OAuth redirect — IS the sign-in.
  useEffect(() => {
    const g = window.exponential?.google;
    if (g) {
      g.getConfig().then(setGoogleConfig);
      g.status().then((u) => { if (u) setGoogleUser(u); }).finally(() => setAuthChecked(true));
      return;
    }
    const fromSession = (s: { user: { id: string; email?: string; user_metadata?: Record<string, string> } } | null) => {
      if (!s) return;
      const m = s.user.user_metadata ?? {};
      setGoogleUser({ id: s.user.id, email: s.user.email ?? '', name: m.full_name || m.name || s.user.email || '', picture: m.avatar_url || m.picture });
    };
    supabase.auth.getSession().then(({ data: d }) => { fromSession(d.session); setAuthChecked(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => fromSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Once signed in: open the Supabase session and load the team; keep the profile's name/photo fresh.
  // Retries every 10s on failure — a brief backend outage (Supabase restarts instances during
  // incidents) used to strand the splash on an error until the app was relaunched.
  const [connectTick, setConnectTick] = useState(0);
  useEffect(() => {
    if (!googleUser) return;
    let cancelled = false;
    let timer: number | undefined;
    connectCloud()
      .then(async (ok) => {
        if (cancelled || !ok) return;
        setCloudError(null);
        const { data: u } = await supabase.auth.getUser();
        if (u.user) await supabase.from('profiles').update({ name: googleUser.name, photo: googleUser.picture ?? null }).eq('id', u.user.id);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        // A raw response body (e.g. a Cloudflare 522 page) is not an error message.
        const msg = err.message && err.message.length < 200 && !err.message.includes('<') ? err.message : 'Can’t reach the server — it may be briefly down.';
        setCloudError(`${msg} Retrying…`);
        timer = window.setTimeout(() => setConnectTick((t) => t + 1), 10_000);
      });
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [googleUser, connectCloud, connectTick]);

  const person = selectedPerson ?? data?.me ?? '';

  // "All teams": the week view also shows the selected person's tasks from every OTHER team,
  // fully editable, each wearing that team's badge. The whole team Data is kept so edits can be
  // applied with the normal taskOps and persisted with persistDiff against the right team.
  // Loaded once per toggle/team-change, then kept fresh by REALTIME per foreign team — full team
  // loads are heavy (notes carry inline images) and the old 60s/every-focus polling is what blew
  // the Supabase egress quota. Focus refetch survives only as a ≥5min safety net.
  const [foreignTeams, setForeignTeams] = useState<Map<string, Data> | null>(null);
  const fSeq = useRef(0); // bumps on every foreign edit; a refetch that started earlier must not clobber it
  const teamIds = teams.map((t) => t.id).join(',');
  useEffect(() => {
    if (!allTeamsOn || !cloudMode || !data || teams.length < 2) { setForeignTeams(null); return; }
    let dead = false;
    const me = data.me;
    const others = teams.filter((t) => t.id !== data.id);
    let lastFetch = 0;
    const fetchOne = async (tid: string) => {
      const seqAtStart = fSeq.current;
      const td = await loadTeam(tid, me).catch(() => null);
      if (dead || !td || fSeq.current !== seqAtStart) return;
      setForeignTeams((m) => new Map(m ?? []).set(tid, td));
    };
    const fetchAll = async () => {
      lastFetch = Date.now();
      const seqAtStart = fSeq.current;
      const loaded = await Promise.all(others.map((t) => loadTeam(t.id, me).catch(() => null)));
      if (dead || fSeq.current !== seqAtStart) return;
      const m = new Map<string, Data>();
      loaded.forEach((td, k) => { if (td) m.set(others[k].id, td); });
      setForeignTeams(m);
    };
    fetchAll();
    const stale = new Set<string>(); // teams whose edits arrived while nobody was looking — drained per team on focus
    const subs = others.map((t) => subscribeTeam(t.id, me, () => {
      if (document.visibilityState === 'hidden' || appIdle()) { stale.add(t.id); return; }
      fetchOne(t.id);
    }));
    const onFocus = () => {
      if (stale.size) { for (const tid of stale) fetchOne(tid); stale.clear(); }
      else if (Date.now() - lastFetch > 300_000) fetchAll(); // realtime can drop while the machine sleeps
    };
    window.addEventListener('focus', onFocus);
    return () => { dead = true; subs.forEach((off) => off()); window.removeEventListener('focus', onFocus); };
  }, [allTeamsOn, cloudMode, data?.id, data?.me, teamIds]); // eslint-disable-line react-hooks/exhaustive-deps
  const foreign = foreignOf(foreignTeams, data?.id, teams);
  /** Apply a taskOp to the foreign team that holds the task and persist it there. Returns false when the task isn't foreign. */
  const foreignOp = (taskId: string, fn: (d: Data) => Data): boolean => {
    const tid = foreign?.teamOf.get(taskId);
    const fd = tid ? foreignTeams?.get(tid) : undefined;
    if (!tid || !fd) return false;
    const next = fn(fd);
    if (next !== fd) {
      fSeq.current++;
      persistDiff(fd, next); // failures surface through the same red save toast
      setForeignTeams((m) => new Map(m).set(tid, next));
    }
    return true;
  };

  // The visible calendar refreshes quietly once a minute; the cache bridges the gaps.
  // calTick only bumps on a manual reconnect now — the minutely refresh lives inside the
  // fetch effect below and re-renders NOTHING unless the events actually changed.
  const [calTick, setCalTick] = useState(0);

  // Fetch the selected person's calendar for the visible week (silently when already cached).
  const calEventsRef = useRef(calEvents);
  calEventsRef.current = calEvents;
  const dataRef2 = useRef(data);
  dataRef2.current = data;
  useEffect(() => {
    const d = dataRef2.current;
    if (!d || !calendarOn || !googleUser || !window.exponential) return;
    const p = d.people.find((x) => x.id === person);
    const calendarId = p?.id === d.me ? 'primary' : p?.email;
    if (!calendarId) { setCalNote(`${shortName(p?.name ?? '')} hasn't signed in with Google yet`); return; }
    const key = `${calendarId}|${week}`;
    if (!calEventsRef.current[key]) setCalNote('Loading…'); // first look shows a note; refreshes are invisible
    let cancelled = false;
    const load = () => window.exponential!.google.events(calendarId, week, addDays(week, 6))
      .then((ev) => {
        if (cancelled) return;
        // identical events keep the SAME object, so a quiet refresh re-renders nothing
        setCalEvents((c) => (JSON.stringify(c[key]) === JSON.stringify(ev) ? c : { ...c, [key]: ev }));
        setCalNote(undefined); setCalReauth(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        // My own calendar failing auth-wise = the grant was revoked or expired: offer to reconnect.
        if (calendarId === 'primary' && /401|403|invalid|insufficient|denied|scope/i.test(err.message)) {
          setCalNote('Calendar access was lost');
          setCalReauth(true);
        } else setCalNote(/404|403/.test(err.message) ? 'Calendar not shared with you' : err.message);
        setCalEvents((c) => (c[key] ? c : { ...c, [key]: [] })); // keep the last good events on a failed refresh
      });
    load();
    // minutely refresh, parked while the window sits unfocused/hidden; wake refreshes at once
    const iv = window.setInterval(() => { if (!appIdle() && document.visibilityState !== 'hidden') load(); }, 60_000);
    const offWake = onAppWake(load);
    return () => { cancelled = true; window.clearInterval(iv); offWake(); };
  }, [!!data, calendarOn, googleUser, person, week, calTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const [calReauth, setCalReauth] = useState(false);
  const reauthCalendar = useCallback(async () => {
    const g = window.exponential?.google;
    if (!g) return;
    setCalNote('Waiting for Google in your browser…');
    const ok = await g.grantCalendar().catch(() => false);
    if (!ok) { setCalNote('Calendar access was not granted'); return; }
    setCalReauth(false);
    setCalEvents({});
    setCalTick((t) => t + 1);
  }, []);

  // Five minutes before one of my meetings a system notification fires. Today's own
  // calendar refreshes every 10 minutes; the countdown check runs every 30 seconds.
  const [myToday, setMyToday] = useState<CalendarEvent[]>([]);
  useEffect(() => {
    if (!calendarOn || !googleUser || !window.exponential) { setMyToday([]); return; }
    let dead = false;
    const load = () => {
      const day = todayISO();
      window.exponential!.google.events('primary', day, day)
        // unchanged events keep the same array — no 10-minute whole-app re-render.
        // NOT gated on focus: the 5-minute reminder matters most while you work elsewhere.
        .then((ev) => { if (!dead) setMyToday((old) => (JSON.stringify(old) === JSON.stringify(ev) ? old : ev)); })
        .catch(() => {});
    };
    load();
    const iv = window.setInterval(load, 10 * 60_000);
    return () => { dead = true; window.clearInterval(iv); };
  }, [calendarOn, googleUser]);
  const remindedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!myToday.length || !window.exponential?.notify) return;
    const check = () => {
      const now = Date.now();
      for (const ev of myToday) {
        if (ev.allDay || !ev.start || remindedRef.current.has(ev.id)) continue;
        const delta = new Date(`${ev.date}T${ev.start}:00`).getTime() - now;
        if (delta > 0 && delta <= 5 * 60_000) {
          remindedRef.current.add(ev.id);
          window.exponential!.notify!({ id: `meeting-${ev.id}`, title: 'Meeting in 5 minutes', body: `${ev.title} starts at ${ev.start}` });
        }
      }
    };
    check();
    const iv = window.setInterval(check, 30_000);
    return () => window.clearInterval(iv);
  }, [myToday]);

  const signIn = useCallback(async () => {
    setAuthError(null);
    if (!window.exponential) {
      try { await webSignIn(); } catch (err) { setAuthError((err as Error).message); } // redirects away on success
      return;
    }
    const g = window.exponential.google;
    try {
      setGoogleUser(await g.signIn());
      setSheet(null);
    } catch (err) {
      setAuthError((err as Error).message);
    }
  }, []);

  const signOut = useCallback(async () => {
    await signOutCloud();
    if (window.exponential) await window.exponential.google.signOut();
    else await supabase.auth.signOut();
    setGoogleUser(null);
    setCalEvents({});
    window.location.reload();
  }, []);

  if (!authChecked) return null;

  // Desktop app: sign in with Google before anything else (name, photo, email and calendar access).
  if (window.exponential && !googleUser) {
    return (
      <SignInGate
        config={googleConfig}
        error={authError}
        onSaveConfig={async (c) => { await window.exponential!.google.setConfig(c); setGoogleConfig(c); }}
        onSignIn={signIn}
      />
    );
  }

  // Launch splash (desktop AND the hosted web app): holds while the team loads; on web
  // without a session it sweeps once and hands over to the sign-in gate below.
  if ((window.exponential && (!cloudMode || splash !== 'gone'))
    || (hostedWeb && (splash !== 'gone' || (!!googleUser && !cloudMode)))) {
    return (
      <div className={`splash${splash === 'out' ? ' out' : ''}`}>
        <div className="splash-mark">
          {/* The utopialabs.com mark through Paper's LiquidMetal shader, at double speed. */}
          <LiquidMetal
            image={utopiaUrl}
            colorBack="#00000000"
            colorTint="#ffffff"
            repetition={1}
            softness={0.13}
            shiftRed={0.3}
            shiftBlue={0.3}
            distortion={0}
            contour={0.49}
            angle={70}
            speed={SPLASH_SPEED}
            frame={SPLASH_FRAME}
            scale={0.66}
            fit="contain"
            style={{ width: 150, height: 100 }}
          />
          {cloudError && <p className="error">{cloudError}</p>}
        </div>
      </div>
    );
  }

  // Hosted web, no session: sign in with Google (the tiny build stamp answers "is my
  // phone running the latest deploy?" without any tooling).
  if (hostedWeb && !googleUser) {
    return (
      <div className="gate">
        <div className="gate-card">
          <img className="gate-logo" src={logoUrl} alt="" />
          <h1>Welcome to Exponential</h1>
          {authError && <p className="error">{authError}</p>}
          <button className="gate-btn" onClick={signIn}><GoogleG /> Continue with Google</button>
          <p className="gate-build">{__BUILD__}</p>
        </div>
      </div>
    );
  }
  if (!data) {
    // Signed in but in no team yet: create one, or wait for an invite (the list re-checks on focus).
    return (
      <div className="gate">
        <div className="gate-card">
          <img className="gate-logo" src={logoUrl} alt="" />
          <h1>You're not in a team yet</h1>
          <p className="muted" style={{ maxWidth: 380 }}>Ask a teammate to invite <b>{googleUser?.email}</b> from their Team page — it shows up here by itself — or start a team of your own.</p>
          <button className="gate-btn" onClick={() => setSheet('new-team')}>Create a team</button>
        </div>
        {sheet === 'new-team' && (
          <NewTeamSheet onClose={() => setSheet(null)} onCreate={(name) => { createTeam(name); }} />
        )}
      </div>
    );
  }

  const onResizeDown = (e: React.PointerEvent) => {
    const rect = mainRef.current!.getBoundingClientRect();
    setResizing(true);
    const move = (ev: PointerEvent) => setWeekH(Math.min(rect.height - 200, Math.max(160, rect.bottom - ev.clientY - 7)));
    const up = () => {
      setResizing(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
  };

  const isThisWeek = week === weekStart(today);
  const me = data.people.find((p) => p.id === data.me)!;
  // Everything the planners render comes from `live`; soft-deleted rows stay only in `data` (for the trash).
  const live = liveOf(data); // identity-cached: same data → the SAME object, so the planner memos hold
  const selProject = selection?.kind === 'project' ? live.projects.find((p) => p.id === selection.id) : undefined;
  const selTask = selection?.kind === 'task' ? live.tasks.find((t) => t.id === selection.id) : undefined;
  const selDeadline = selection?.kind === 'deadline' ? data.deadlines.find((d) => d.id === selection.id) : undefined;
  const detailOpen = !!(selProject || selTask || selDeadline) || selection?.kind === 'retro';
  detailRef.current = detailOpen;
  const crmOpen = leftPanel === 'crm';
  const showCrm = crmTeam === data.id || crmOpen; // only a team that has a CRM record shows the item
  const leftOpen = leftPanel !== null && !crmOpen;
  const unread = (data.notifications ?? []).filter((n) => n.to === data.me && !n.read).length;
  const chatUnread = chat.reduce((n, c) => n + c.unread, 0);

  const calKey = `${person === data.me ? 'primary' : data.people.find((x) => x.id === person)?.email}|${week}`;

  // The planner elements are SHARED between the desktop shell and the phone shell:
  // same props, same handlers — only the frame around them differs.
  const bigPlanEl = (
            <BigPlanM
              projects={live.projects}
              groups={groupsOf(data.groups)}
              deadlines={data.deadlines}
              people={data.people}
              locked={!unlocked || mobileShell}
              onAddGroup={() => { setEditGroup(null); setSheet('group'); }}
              today={today}
              week={week}
              selectedId={selection?.id}
              selectedIds={multi}
              onToggleSelect={toggleSelect}
              editingId={editingId ?? undefined}
              onWeekChange={setWeek}
              onOpenProject={(p) => open('project', p.id)}
              onOpenDeadline={(d) => open('deadline', d.id)}
              onMoveProject={(id, patch) => updateProject(id, patch)}
              onOpenRetro={(monday) => setSelection({ kind: 'retro', id: monday })}
              onOpenGroup={(g) => { setEditGroup(g); setSheet('group'); }}
              onReorderGroups={(ids) => update((d) => ({ ...d, groups: (d.groups ?? []).map((g) => ({ ...g, sort: ids.indexOf(g.id) })) }))}
              onDuplicateProject={(id) => update((d) => {
                const p = d.projects.find((x) => x.id === id);
                if (!p) return d;
                // the copy lands on a fresh lane in the same group, right below the original
                const lane = d.projects.filter((x) => !x.deletedAt && (x.groupId ?? null) === (p.groupId ?? null)).reduce((m, x) => Math.max(m, x.lane + 1), 0);
                return { ...d, projects: [...d.projects, { ...p, id: uid(), lane }] };
              })}
              onCollapseGroup={(ids) => setMulti((m) => (ids.some((id) => m.has(id)) ? new Set([...m].filter((id) => !ids.includes(id))) : m))}
              onMoveDeadline={(id, date) => update((d) => ({ ...d, deadlines: d.deadlines.map((x) => (x.id === id ? { ...x, date } : x)) }))}
              onCreateDeadline={(date) => {
                const id = uid();
                update((d) => ({ ...d, deadlines: [...d.deadlines, { id, name: 'New deadline', date }] }));
                editingNew.current = true;
                setEditingId(id);
              }}
              onRenameDeadline={(id, name) => {
                setEditingId(null);
                if (!name) update((d) => ({ ...d, deadlines: d.deadlines.filter((x) => x.id !== id) }));
                else update((d) => ({ ...d, deadlines: d.deadlines.map((x) => (x.id === id ? { ...x, name } : x)) }));
              }}
              onCreateProject={(start, lane, groupId, atTop) => {
                const id = uid();
                update((d) => {
                  // From a group's label row the new bar goes on TOP of the group: everyone below moves down a lane.
                  const projects = atTop
                    ? d.projects.map((p) => (!p.deletedAt && (p.groupId ?? null) === (groupId ?? null) ? { ...p, lane: p.lane + 1 } : p))
                    : d.projects;
                  return { ...d, projects: [...projects, { id, name: 'New project', start, end: addDays(start, 6), lane, groupId }] };
                });
                editingNew.current = true;
                setEditingId(id);
              }}
              onStartRename={(id) => { editingNew.current = false; setEditingId(id); }}
              onRename={(id, name) => {
                setEditingId(null);
                // An empty name removes a freshly created project but keeps the old name on a rename.
                if (!name) { if (editingNew.current) update((d) => ({ ...d, projects: d.projects.filter((p) => p.id !== id) })); return; }
                update((d) => ({ ...d, projects: d.projects.map((p) => (p.id === id ? { ...p, name } : p)) }));
              }}
              onMoveMany={(ids, dd) => update((d) => ({ ...d, projects: d.projects.map((p) => (ids.includes(p.id) ? { ...p, start: addDays(p.start, dd), end: addDays(p.end, dd) } : p)) }))}
              onDeleteMany={deleteMany}
              onDeleteProject={(id) => {
                update((d) => softDelete(d, [id]));
                if (selection?.id === id) setSelection(null);
                setMulti((m) => { if (!m.has(id)) return m; const n = new Set(m); n.delete(id); return n; });
              }}
            />
  );
  const weekPlanEl = (
            <WeekPlanM
              people={data.people}
              me={data.me}
              selected={person}
              onSelect={setSelectedPerson}
              week={week}
              today={today}
              tasks={weekTasksOf(live.tasks, foreign?.tasks ?? null, person, week)}
              teamBadge={foreign && data ? (id) => foreign.badge.get(id) ?? { id: data.id, name: data.name, icon: data.icon ?? undefined } : undefined}
              allTeams={allTeamsOf(cloudMode && teams.length > 1, allTeamsOn, setAllTeamsOn)}
              selectedId={selection?.id}
              selectedIds={multi}
              onToggleSelect={toggleSelect}
              editingId={editingId ?? undefined}
              onWeekChange={setWeek}
              onAdd={(date) => {
                if (isPending(person)) return; // they need to sign in once before they can own tasks
                let id = '';
                update((d) => { const r = addTask(d, person, date); id = r.id; return r.data; });
                editingNew.current = true;
                setEditingId(id);
              }}
              onEdit={(id) => { editingNew.current = false; setEditingId(id); }}
              onRename={(id, title, viaEnter) => {
                setEditingId(null);
                if (!title && !editingNew.current) return; // clearing the name of an existing task keeps the old one
                if (foreignOp(id, (d) => renameTask(d, id, title, editingNew.current))) return;
                let nextId = '';
                update((d) => {
                  const t = d.tasks.find((x) => x.id === id);
                  const renamed = renameTask(d, id, title, editingNew.current);
                  // Enter keeps the flow going after a NEW task: a fresh one right after, ready to type.
                  if (viaEnter && title && t && editingNew.current) { const r = addTask(renamed, t.personId, t.date); nextId = r.id; return r.data; }
                  return renamed;
                });
                if (nextId) setEditingId(nextId);
              }}
              onAddNamed={(title) => { if (isPending(person)) return; update((d) => { const r = addTask(d, person, undefined); return renameTask(r.data, r.id, title); }); }}
              onUpdate={(id, patch) => { if (!foreignOp(id, (d) => patchTask(d, id, patch))) updateTask(id, patch); }}
              onDelete={(id) => {
                if (!foreignOp(id, (d) => softDelete(d, [id]))) update((d) => softDelete(d, [id]));
                if (selection?.id === id) setSelection(null);
              }}
              onDuplicate={(id) => {
                const dup = (d: Data): Data => {
                  const t = d.tasks.find((x) => x.id === id);
                  if (!t) return d;
                  // land right below the original; reorderTask renumbers the whole group with INTEGERS (sort_order column)
                  const copy = { ...t, id: uid(), reviewerId: undefined, reviewDone: undefined };
                  return reorderTask({ ...d, tasks: [...d.tasks, copy] }, copy.id, t.id);
                };
                if (!foreignOp(id, dup)) update(dup);
              }}
              onDeleteMany={deleteMany}
              onDeny={(id) => { if (!foreignOp(id, (d) => denyReview(d, id))) update((d) => denyReview(d, id)); }}
              onCompleteReview={(id) => { if (!foreignOp(id, (d) => completeReview(d, id))) update((d) => completeReview(d, id)); }}
              onOpen={(t) => {
                // A row from another team opens in that team: switch first, then select.
                const tid = foreign?.teamOf.get(t.id);
                if (tid) switchTeam(tid).then(() => open('task', t.id));
                else open('task', t.id);
              }}
              onReorder={(id, afterId) => { if (!foreignOp(id, (d) => reorderTask(d, id, afterId))) update((d) => reorderTask(d, id, afterId)); }}
              calendar={calendarOf(
                calendarOn,
                !!googleUser,
                !window.exponential, // the web build has no Google Calendar at all
                calEvents[calKey] ?? NO_EVENTS,
                !window.exponential ? 'Available in the desktop app' : !googleUser ? 'Sign in with Google to see events' : calNote,
                calReauth,
                reauthCalendar,
              )}
              onToggleCalendar={async () => {
                if (calendarOn) { setCalendarOn(false); return; }
                // First use: Google may not have granted calendar access with the sign-in; ask for it now.
                const g = window.exponential?.google;
                if (g && !(await g.hasCalendar())) {
                  setCalNote('Waiting for Google in your browser…');
                  const ok = await g.grantCalendar().catch(() => false);
                  if (!ok) { setCalNote('Calendar access was not granted'); return; }
                  setCalEvents({});
                }
                setCalendarOn(true);
              }}
            />
  );
  const detailEl = (w: number) => (selection ? (
          <DetailPanelM
            width={w}
            selection={selection}
            project={selProject}
            task={selTask}
            deadline={selDeadline}
            retro={selection.kind === 'retro' ? data.retros?.[selection.id] : undefined}
            prevRetro={selection.kind === 'retro' ? data.retros?.[addDays(selection.id, -7)] : undefined}
            carriedConfidence={carriedOf(data.retros, selection.kind === 'retro' ? selection.id : null)}
            retroTemplate={data.retroTemplate}
            notifications={notifsOf(data.notifications)}
            people={data.people}
            me={data.me}
            onClose={() => setSelection(null)}
            onOpen={setSelection}
            tasks={live.tasks}
            onCreateLinked={(link, title, coalesce) => {
              let id = '';
              update((d) => { const r = addTask(d, undefined, undefined, 'end', link); id = r.id; return { ...r.data, tasks: r.data.tasks.map((t) => (t.id === r.id ? { ...t, title } : t)) }; }, coalesce);
              return id;
            }}
            onDeleteTask={(id, coalesce) => update((d) => softDelete(d, [id]), coalesce)}
            onClaimTask={(id, personId) => update((d) => claimTask(d, id, personId))}
            onUnclaimTask={(id) => update((d) => unclaimTask(d, id))}
            onMarkRead={(ids) => update((d) => ({ ...d, notifications: (d.notifications ?? []).map((n) => (ids.includes(n.id) ? { ...n, read: true } : n)) }), 'mark-read')}
            onUpdateProject={updateProject}
            groups={groupsOf(data.groups)}
            onNewGroup={() => { setEditGroup(null); setSheet('group'); }}
            onToggleAssignee={(pid, who) => {
              const cur = data.projects.find((x) => x.id === pid)?.assignees ?? [];
              updateProject(pid, { assignees: cur.includes(who) ? cur.filter((i) => i !== who) : [...cur, who] });
            }}
            onUpdateTask={updateTask}
            onUpdateDeadline={(id, patch, key) => update((d) => {
              const before = d.deadlines.find((x) => x.id === id);
              if (!before || Object.entries(patch).every(([k, v]) => Object.is(before[k as keyof Deadline], v))) return d; // no-op: no phantom undo step
              return { ...d, deadlines: d.deadlines.map((x) => (x.id === id ? { ...x, ...patch } : x)) };
            }, key)}
            onUpdateRetro={(wk, patch, key) => update((d) => {
              const cur: Retro = d.retros?.[wk] ?? { week: wk, answers: {} };
              return { ...d, retros: { ...d.retros, [wk]: { ...cur, ...patch, answers: { ...cur.answers, ...(patch.answers ?? {}) } } } };
            }, key)}
            retroFields={data.retroFields ?? DEFAULT_RETRO_FIELDS}
            onDelete={() => {
              const { kind, id } = selection;
              update((d) =>
                kind === 'project' || kind === 'task' ? softDelete(d, [id])
                : kind === 'deadline' ? { ...d, deadlines: d.deadlines.filter((x) => x.id !== id) }
                : d,
              );
              setSelection(null);
            }}
          />
  ) : null);

  return (
    <div className={`shell${mobileShell ? ' phone' : ''}`}>
      <aside className={`sidebar${window.exponential?.platform === 'darwin' ? ' mac' : ''}`}>
       <div className="sidebar-inner">
        <div className="team-list">
          {teams.map((t) => (
            <div key={t.id} className={`team-row${t.id === data.id ? ' current' : ''}`} title={t.name}>
              <button className="team-main" onClick={() => { if (t.id !== data.id) { switchTeam(t.id); setSelection(null); setSelectedPerson(null); setView('plan'); } else setView('plan'); if (crmOpen) setLeftPanel(null); }}>
                <TeamMark team={t} />
                <span className="team-name">{t.name}</span>
              </button>
              <button className={`team-cog${t.id === data.id && view === 'team' && !crmOpen ? ' on' : ''}`} title="Team settings"
                onClick={() => { if (t.id !== data.id) { switchTeam(t.id); setSelectedPerson(null); } setSelection(null); setView('team'); if (crmOpen) setLeftPanel(null); }}>
                <CogIcon />
              </button>
            </div>
          ))}
          <button className="team-row add" onClick={() => setSheet('new-team')}>
            <span className="team-mark plus">+</span>
            <span className="team-name">New team</span>
          </button>
        </div>
        <button className={`nav-item${view === 'plan' && !crmOpen ? ' active' : ''}`} onClick={() => { setView('plan'); if (crmOpen) setLeftPanel(null); }}><PlanIcon /> <span className="nav-text">Plan</span></button>
        <button className={`nav-item${leftPanel === 'chat' ? ' active' : ''}`} onClick={() => setLeftPanel(leftPanel === 'chat' ? null : 'chat')}>
          <span className="nav-ico"><ChatIcon />{(chatUnread > 0 || unread > 0) && <span className="nav-dot" />}</span>
          <span className="nav-text">Messages</span>
        </button>
        <button className={`nav-item${leftPanel === 'meetings' ? ' active' : ''}`} onClick={() => setLeftPanel(leftPanel === 'meetings' ? null : 'meetings')}>
          <span className="nav-ico"><MeetIcon />{meetDot && <span className="nav-dot" />}</span>
          <span className="nav-text">Meetings</span>
        </button>
        {showCrm && (
          <button className={`nav-item${leftPanel === 'crm' ? ' active' : ''}`} onClick={() => setLeftPanel(leftPanel === 'crm' ? null : 'crm')} title="The customer record: today's overview and the live sheet">
            <span className="nav-ico"><CrmIcon /></span>
            <span className="nav-text">CRM</span>
          </button>
        )}

        <div className="sidebar-bottom">
          {(!updateInfo || updateInfo.state === 'none' || updateInfo.state === 'error' || updateInfo.state === 'available') && (
            <button
              className="nav-item theme-toggle"
              onClick={() => { setUpdateState({ state: 'checking-ui' }); window.exponential?.checkForUpdate(); window.setTimeout(() => setUpdateState((u) => (u?.state === 'checking-ui' ? { state: 'none' } : u)), 15000); }}
              title={updateInfo?.state === 'error' ? `Update failed: ${(updateInfo as { message?: string }).message ?? ''}` : `Exponential ${appVersion} — check GitHub for a newer version`}
            >
              <UpdateIcon />
              <span className="nav-text">{updateInfo?.state === 'none' ? 'Up to date' : updateInfo?.state === 'error' ? 'Update failed' : 'Check for updates'}</span>
            </button>
          )}
          {updateInfo?.state === 'checking-ui' && (
            <div className="nav-item update-pill quiet"><UpdateIcon /> <span className="nav-text">Checking…</span></div>
          )}
          {updateInfo?.state === 'ready' && (
            <button className="nav-item update-pill" onClick={() => window.exponential?.installUpdate()} title={`Version ${updateInfo.version} is ready — restart to update`}>
              <UpdateIcon /> <span className="nav-text">Restart to update</span>
            </button>
          )}
          {updateInfo?.state === 'downloading' && (
            <div className="nav-item update-pill quiet" title={`Downloading version ${updateInfo.version ?? ''}`}>
              <UpdateIcon /> <span className="nav-text">Updating… {updateInfo.percent ?? 0}%</span>
            </div>
          )}
          <button className="nav-item theme-toggle" onClick={cycleTheme}
            title={themePref === 'light' ? 'Theme: Light — click for Dark' : themePref === 'dark' ? 'Theme: Dark — click for Auto' : 'Theme: Auto (follows the system) — click for Light'}>
            {themePref === 'light' ? <SunIcon /> : themePref === 'dark' ? <MoonIcon /> : <AutoThemeIcon />}
            <span className="nav-text">{themePref === 'light' ? 'Light' : themePref === 'dark' ? 'Dark' : 'Auto'}</span>
          </button>
          {googleUser ? (
            <button className="account has-avatar" onClick={() => setSheet('settings')} title={googleUser.email}>
              <Avatar person={me} size={28} />
              <span className="account-name nav-text">{shortName(googleUser.name)}</span>
            </button>
          ) : (
            <button className="account" onClick={() => setSheet('settings')}>
              <GoogleG />
              <span className="account-name nav-text">Sign in</span>
            </button>
          )}
        </div>
       </div>
      </aside>

      <div className={`main${detailOpen && !crmOpen ? ' with-detail' : ''}${crmOpen ? ' crm-active' : ''}`}>
        {crmOpen && (
          <CrmPage
            teamId={data.id}
            me={data.me}
            people={data.people}
            cloud={cloudMode}
            onClose={() => setLeftPanel(null)}
            onError={(m) => { setSaveError(m); window.setTimeout(() => setSaveError(null), 6000); }}
            backRef={crmBackRef}
          />
        )}
        <div
          className={`detail-slot left-slot${lResizing ? ' no-anim' : ''}${!leftOpen ? ' clip' : ''}`}
          style={{ width: leftOpen ? leftW + 14 : 0 }}
        >
          {leftOpen && (
            <aside className="detail side-embed" style={{ width: leftW }}>
              {leftPanel === 'chat' && (
                <ChatPage
                  teamId={data.id}
                  me={data.me}
                  people={data.people}
                  canModerate={data.moderators.includes(data.me)}
                  cloud={cloudMode}
                  channels={chat}
                  activeId={chatActive}
                  onActive={setChatActive}
                  onRefreshChannels={refreshChat}
                  notifications={data.notifications ?? []}
                  notifUnread={unread}
                  onOpenItem={(sel) => { setView('plan'); setSelection(sel); }}
                  onMarkRead={(ids) => update((d) => ({ ...d, notifications: (d.notifications ?? []).map((n) => (ids.includes(n.id) ? { ...n, read: true } : n)) }), 'mark-read')}
                  onClose={() => setLeftPanel(null)}
                  onError={(m) => { setSaveError(m); window.setTimeout(() => setSaveError(null), 6000); }}
                  jumpToThread={chatJump}
                  onJumped={() => { setChatJump(false); pendingChatRef.current = null; }}
                  backRef={chatBackRef}
                />
              )}
              {leftPanel === 'meetings' && (
                <MeetingsPage
                  teamId={data.id}
                  me={data.me}
                  people={data.people}
                  canModerate={data.moderators.includes(data.me)}
                  cloud={cloudMode}
                  onClose={() => setLeftPanel(null)}
                  onError={(m) => { setSaveError(m); window.setTimeout(() => setSaveError(null), 6000); }}
                />
              )}
            </aside>
          )}
          {leftOpen && <div className={`vresizer${lResizing ? ' dragging' : ''}`} onPointerDown={onLResizeDown} />}
        </div>
        {view === 'team' && !crmOpen && (
          <TeamPage
            team={data}
            cloud={cloudMode}
            canDelete={cloudMode || teams.length > 1}
            onUpdate={(fn, coalesce) => update(fn, coalesce)}
            onDelete={() => { setView('plan'); setSelection(null); setSelectedPerson(null); deleteTeam(data.id); }}
          />
        )}
        <div className="planners" ref={mainRef} style={view !== 'plan' || crmOpen ? { display: 'none' } : undefined}>
          <section className="panel" style={{ flex: '1 1 0' }} ref={planSecRef}>
            <div className="panel-head">
              <div className="panel-title">Master plan</div>
              <div className="panel-spacer" />
              {!isThisWeek && <button className="pill" onClick={() => setWeek(weekStart(today))}>Back to this week</button>}
              <button
                className={`pill toggle plan-lock${unlocked ? ' active' : ''}`}
                onClick={() => setUnlocked((v) => !v)}
                title={unlocked ? 'Lock the master plan' : 'Unlock to add and move projects, deadlines and groups'}
              >
                <LockIcon open={unlocked} /> {unlocked ? 'Unlocked' : 'Unlock'}
              </button>
            </div>
            {bigPlanEl}
          </section>

          <div className={`resizer${resizing ? ' dragging' : ''}`} onPointerDown={onResizeDown} />

          <section className="panel" style={{ flex: 'none', height: weekH }}>
            {weekPlanEl}
          </section>
        </div>

        {/* The slot animates its width so the planners squeeze smoothly; the panel inside keeps a fixed width. */}
        <div
          className={`detail-slot${vResizing ? ' no-anim' : ''}${slotAnimating || !detailOpen ? ' clip' : ''}`}
          style={{ width: detailOpen ? detailW + 14 : 0, display: crmOpen ? 'none' : undefined }}
          onTransitionEnd={(e) => { if (e.propertyName === 'width') setSlotAnimating(false); }}
        >
        {detailOpen && <div className={`vresizer${vResizing ? ' dragging' : ''}`} onPointerDown={onVResizeDown} />}
        {detailOpen && detailEl(detailW)}
        </div>
      </div>

      {!window.exponential && webUpdate && (
        <button className="web-update" onClick={() => window.location.reload()}>Update ready — tap to refresh</button>
      )}
      {mobileShell && (
        <>
          <nav className="float-tabs">
            <button className={!leftPanel && !selection && view === 'plan' ? 'on' : ''}
              onClick={() => { setLeftPanel(null); setSelection(null); setMTeamsOpen(false); setView('plan'); }}>
              <PlanIcon />
              Plan
            </button>
            <button className={leftPanel === 'chat' ? 'on' : ''} onClick={() => setLeftPanel(leftPanel === 'chat' ? null : 'chat')}>
              <span className="nav-ico"><ChatIcon />{(chatUnread > 0 || unread > 0) && <span className="nav-dot" />}</span>
              Messages
            </button>
            <button className={leftPanel === 'meetings' ? 'on' : ''} onClick={() => setLeftPanel(leftPanel === 'meetings' ? null : 'meetings')}>
              <span className="nav-ico"><MeetIcon />{meetDot && <span className="nav-dot" />}</span>
              Meetings
            </button>
            {showCrm && (
              <button className={leftPanel === 'crm' ? 'on' : ''} onClick={() => setLeftPanel(leftPanel === 'crm' ? null : 'crm')}>
                <span className="nav-ico"><CrmIcon /></span>
                CRM
              </button>
            )}
            <button className={mTeamsOpen ? 'on' : ''} onClick={() => setMTeamsOpen((v) => !v)}>
              <TeamMark team={teams.find((t) => t.id === data.id) ?? { id: data.id, name: data.name, icon: data.icon }} size={18} />
              Teams
            </button>
          </nav>
          {mTeamsOpen && (
            <div className="mobile-teams" onPointerDown={() => setMTeamsOpen(false)}>
              <div className="mobile-teams-card" onPointerDown={(e) => e.stopPropagation()}>
                {teams.map((t) => (
                  <button key={t.id} className={t.id === data.id ? 'current' : ''}
                    onClick={() => { setMTeamsOpen(false); if (t.id !== data.id) { switchTeam(t.id); setSelection(null); setSelectedPerson(null); } }}>
                    <TeamMark team={t} /> <span>{t.name}</span>
                  </button>
                ))}
                <div className="mobile-build">
                  {__BUILD__}{(() => { try { const l = localStorage.getItem('exponential-link-log'); return l ? ` · ${l}` : ''; } catch { return ''; } })()}
                </div>
              </div>
            </div>
          )}
          {pushState === 'ok-off' && (
            <button className="pill push-banner" onClick={async () => setPushState((await enablePush()) === 'on' ? 'on' : 'ok-off')}>
              Enable notifications
            </button>
          )}
          {pushState === 'install' && (
            <div className="push-banner note">For notifications: Share → Add to Home Screen, then open Exponential from there</div>
          )}
        </>
      )}
      {saveError && <div className="toast error-toast">{saveError}</div>}
      {usageWarn && !usageDismissed && !saveError && data.moderators.includes(data.me) && (
        <div className={`toast usage-toast${usageWarn.pct >= 90 ? ' hot' : ''}`}>
          Supabase egress ≈ {usageWarn.gb} GB of {QUOTA_GB} GB this month ({usageWarn.pct}%).
          {usageWarn.pct >= 90 ? ' The backend may be restricted at 100% — check the spend cap in Supabase billing.' : ' Worth a look at Supabase billing before it climbs.'}
          <button className="usage-x" onClick={() => setUsageDismissed(true)}>×</button>
        </div>
      )}
      {notifyBlocked && !saveError && (
        <div className="toast">
          Notifications are turned off for Exponential
          <button className="toast-btn" onClick={() => { window.exponential?.openNotificationSettings?.(); setNotifyBlocked(false); }}>Turn on</button>
          <button className="toast-x" onClick={() => setNotifyBlocked(false)}>×</button>
        </div>
      )}
      {sheet === 'group' && (
        <GroupSheet
          group={editGroup}
          onClose={() => setSheet(null)}
          onSave={(g) => update((d) => ({ ...d, groups: editGroup ? (d.groups ?? []).map((x) => (x.id === g.id ? g : x)) : [...(d.groups ?? []), g] }))}
          onDelete={(id) => update((d) => ({ ...d, groups: (d.groups ?? []).filter((x) => x.id !== id), projects: d.projects.map((p) => (p.groupId === id ? { ...p, groupId: undefined } : p)) }))}
          nextSort={(data.groups ?? []).reduce((m, g) => Math.max(m, g.sort + 1), 0)}
        />
      )}
      {sheet === 'new-team' && (
        <NewTeamSheet onClose={() => setSheet(null)} onCreate={(name) => { createTeam(name); setSelection(null); setSelectedPerson(null); setView('team'); if (crmOpen) setLeftPanel(null); }} />
      )}
      {sheet === 'settings' && (
        <SettingsSheet
          user={googleUser}
          config={googleConfig}
          error={authError}
          onClose={() => { setSheet(null); setAuthError(null); }}
          onSaveConfig={async (c) => { await window.exponential?.google.setConfig(c); setGoogleConfig(c); }}
          onSignIn={signIn}
          onSignOut={signOut}
          appVersionText={appVersion ? `Exponential ${appVersion}` : undefined}
          updateText={updateInfo ? (updateInfo.state === 'error' ? `update failed: ${(updateInfo as { message?: string }).message ?? 'unknown'}` : updateInfo.state === 'none' ? 'up to date' : updateInfo.state === 'ready' ? `v${updateInfo.version} ready` : updateInfo.state) : undefined}
        />
      )}
    </div>
  );
}

export function TeamMark({ team, size = 30 }: { team: { name: string; icon?: string }; size?: number }) {
  const style = { width: size, height: size, borderRadius: size / 3, fontSize: size / 2 };
  return team.icon
    ? <img className="team-mark img" src={team.icon} alt="" style={style} />
    : <span className="team-mark" style={style}>{team.name.trim()[0]?.toUpperCase()}</span>;
}

const ICON = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

function MeetIcon() {
  return (
    <svg {...ICON}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </svg>
  );
}

function CrmIcon() {
  // a person with a small list beside them: the record
  return (
    <svg {...ICON}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0M16 7h4.5M16 11h4.5M16 15h4.5" />
    </svg>
  );
}
function ChatIcon() {
  return (
    <svg {...ICON}>
      <path d="M6 4.5h12A2.5 2.5 0 0 1 20.5 7v6a2.5 2.5 0 0 1-2.5 2.5h-6.4L7.5 19v-3.5H6A2.5 2.5 0 0 1 3.5 13V7A2.5 2.5 0 0 1 6 4.5Z" />
    </svg>
  );
}

function PlanIcon() {
  return (
    <svg {...ICON} fill="currentColor" stroke="none">
      <rect x="3" y="5" width="12" height="3.6" rx="1.8" />
      <rect x="7.5" y="10.2" width="13.5" height="3.6" rx="1.8" />
      <rect x="4.5" y="15.4" width="9" height="3.6" rx="1.8" />
    </svg>
  );
}
function InboxIcon() {
  return (
    <svg {...ICON}>
      <path d="M4.5 13.5l1.8-6.2A1.8 1.8 0 0 1 8 6h8a1.8 1.8 0 0 1 1.7 1.3l1.8 6.2V17a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z" />
      <path d="M4.5 13.5h4.2a3.3 3.3 0 0 0 6.6 0h4.2" />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg {...ICON}>
      <path d="M19.5 14.8A7.8 7.8 0 0 1 9.2 4.5a8 8 0 1 0 10.3 10.3z" />
    </svg>
  );
}
function AutoThemeIcon() {
  return (
    <svg {...ICON}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg {...ICON}>
      <circle cx="12" cy="12" r="3.6" />
      <path d="M12 3.5v1.8M12 18.7v1.8M3.5 12h1.8M18.7 12h1.8M6 6l1.3 1.3M16.7 16.7L18 18M6 18l1.3-1.3M16.7 7.3L18 6" />
    </svg>
  );
}

function LockIcon({ open }: { open?: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4.5" y="10.5" width="15" height="10" rx="3.5" />
      {open ? <path d="M8.5 10.5V7a3.5 3.5 0 0 1 6.8-1.2" /> : <path d="M8.5 10.5V7a3.5 3.5 0 0 1 7 0v3.5" />}
    </svg>
  );
}

function UpdateIcon() {
  return (
    <svg {...ICON}>
      <path d="M12 16V5M7.5 9.5L12 5l4.5 4.5" />
      <path d="M5 18.5h14" />
    </svg>
  );
}

function CogIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3h.1a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8v.1a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </svg>
  );
}


function GoogleG() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.4-4.1 7-10.1 7-17.6z" />
      <path fill="#FBBC05" d="M10.5 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.5 0 20.1 0 24s.9 7.5 2.6 10.8l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.3 0 11.7-2.1 15.6-5.7l-7.6-5.9c-2.1 1.4-4.8 2.3-8 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}

function SheetShell({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" style={wide ? { width: 460 } : undefined}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function GroupSheet({ group, onClose, onSave, onDelete, nextSort }: {
  group: Group | null; onClose: () => void; onSave: (g: Group) => void; onDelete: (id: string) => void; nextSort: number;
}) {
  const [name, setName] = useState(group?.name ?? '');
  const [color, setColor] = useState(group?.color ?? PROJECT_COLORS[nextSort % PROJECT_COLORS.length]);
  const submit = () => { if (!name.trim()) return; onSave({ id: group?.id ?? uid(), name: name.trim(), color, sort: group?.sort ?? nextSort }); onClose(); };
  return (
    <SheetShell title={group ? 'Edit group' : 'New group'} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="field"><label>Name</label><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Aerodynamics" /></div>
        <div className="field"><label>Colour</label>
          <div className="swatches" style={{ padding: '4px 0' }}>
            {PROJECT_COLORS.map((c) => (
              <button type="button" key={c} className={`swatch${color === c ? ' on' : ''}`} style={{ ['--pc' as string]: c }} onClick={() => setColor(c)} />
            ))}
          </div>
        </div>
        <div className="sheet-actions">
          <button type="submit" className="btn primary" disabled={!name.trim()}>{group ? 'Save' : 'Create group'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <span style={{ flex: 1 }} />
          {group && <button type="button" className="btn" style={{ color: 'var(--today)' }} onClick={() => { onDelete(group.id); onClose(); }}>Delete</button>}
        </div>
      </form>
    </SheetShell>
  );
}

function NewTeamSheet({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => void }) {
  const [name, setName] = useState('');
  const submit = () => { if (!name.trim()) return; onCreate(name.trim()); onClose(); };
  return (
    <SheetShell title="New team" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="field"><label>Team name</label><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Powertrain" /></div>
        <p className="muted">You'll be its first moderator. Add people from the Team page.</p>
        <div className="sheet-actions">
          <button type="submit" className="btn primary" disabled={!name.trim()}>Create team</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </SheetShell>
  );
}

function SignInGate({ config, error, onSaveConfig, onSignIn }: {
  config: GoogleConfig | null;
  error: string | null;
  onSaveConfig: (c: GoogleConfig) => Promise<void>;
  onSignIn: () => Promise<void> | void;
}) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const configured = !!config?.clientId;
  const go = async () => {
    setBusy(true);
    try {
      if (!configured) await onSaveConfig({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
      await onSignIn();
    } finally { setBusy(false); }
  };
  return (
    <div className="gate">
      <div className="gate-card">
        <img className="gate-logo" src={logoUrl} alt="" />
        <h1>Welcome to Exponential</h1>
        {!configured && (
          <div className="gate-setup">
            <div className="field"><label>Client ID</label><input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="xxxx.apps.googleusercontent.com" /></div>
            <div className="field"><label>Client secret</label><input value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="GOCSPX-…" /></div>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <button className="gate-btn" disabled={busy || (!configured && !clientId.trim())} onClick={go}>
          <GoogleG /> {busy ? 'Waiting for your browser…' : 'Continue with Google'}
        </button>
      </div>
    </div>
  );
}

function SettingsSheet({ user, config, error, onClose, onSaveConfig, onSignIn, onSignOut, appVersionText, updateText }: {
  appVersionText?: string;
  updateText?: string;
  user: GoogleUser | null;
  config: GoogleConfig | null;
  error: string | null;
  onClose: () => void;
  onSaveConfig: (c: GoogleConfig) => Promise<void>;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  const [clientId, setClientId] = useState(config?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState(config?.clientSecret ?? '');
  const [busy, setBusy] = useState(false);
  const desktop = !!window.exponential;
  const configured = !!clientId.trim();

  const connect = async () => {
    setBusy(true);
    try {
      await onSaveConfig({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
      await onSignIn();
    } finally { setBusy(false); }
  };

  return (
    <SheetShell title="Google account" onClose={onClose} wide>
      {!desktop && <p className="muted">Google sign-in works in the desktop app, not in the browser preview.</p>}
      {user ? (
        <>
          <p className="muted">Signed in as <b>{user.name}</b> ({user.email}). Your name and photo come from Google, and the Calendar toggle in the week panel reads your calendar.</p>
          {appVersionText && <p className="hint">{appVersionText}{updateText ? ` · ${updateText}` : ''}</p>}
          <div className="sheet-actions">
            <button className="btn" onClick={() => { onSignOut(); onClose(); }}>Sign out</button>
            <button className="btn primary" onClick={onClose}>Done</button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">
            Sign-in opens your browser and asks for your name, email, photo and read-only calendar access.
            Exponential needs an OAuth client from Google Cloud (type <b>Desktop app</b>) — paste it once below.
          </p>
          <div className="field"><label>Client ID</label><input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="xxxx.apps.googleusercontent.com" /></div>
          <div className="field"><label>Client secret</label><input value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="GOCSPX-…" /></div>
          {error && <p className="error">{error}</p>}
          <div className="sheet-actions">
            <button className="btn primary" disabled={!desktop || !configured || busy} onClick={connect}>
              <GoogleG /> {busy ? 'Waiting for browser…' : 'Sign in with Google'}
            </button>
            <button className="btn" onClick={onClose}>Cancel</button>
          </div>
        </>
      )}
    </SheetShell>
  );
}
