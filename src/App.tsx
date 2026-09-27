import { useCallback, useEffect, useRef, useState } from 'react';
import { BigPlan } from './BigPlan';
import { Avatar, WeekPlan } from './WeekPlan';
import { DetailPanel, type Selection } from './DetailPanel';
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
import { subscribeMeetings } from './meetings';

/** Layout proportions, remembered per machine (not part of the shared plan data). */
const PREFS_KEY = 'exponential-layout';
const DEFAULT_PREFS = { weekH: 400, detailW: 415, theme: '' as '' | 'light' | 'dark', calendar: true, allTeams: false, sideOpen: false };
const prefs: typeof DEFAULT_PREFS = (() => {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }; } catch { return DEFAULT_PREFS; }
})();
const savePrefs = (p: typeof DEFAULT_PREFS) => localStorage.setItem(PREFS_KEY, JSON.stringify(p));

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
  // chat / meetings live in a LEFT side panel; both sides can be open at once — every
  // column (left panel, planners, right panel) keeps at least ~a fifth of the window.
  const [leftPanel, setLeftPanel] = useState<'chat' | 'meetings' | null>(null);
  const [sideOpen, setSideOpen] = useState(() => prefs.sideOpen); // sidebar toggled wide (was hover-expand)
  const [leftW, setLeftW] = useState(415);
  const [lResizing, setLResizing] = useState(false);
  const leftWRef = useRef(leftW); leftWRef.current = leftW;
  // The centre (planners) always keeps at least a third of the window; the two side
  // panels split what's left, each at least ~a fifth (never less than 240px).
  const sideBudget = () => window.innerWidth - (sideOpen ? 250 : 106) - Math.floor(window.innerWidth / 3); // 106/250 = closed/open sidebar + shell padding + slot margins, measured
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
    if (wasOpen !== isOpen) setSlotAnimating(true);
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
  const theme: 'light' | 'dark' = themePref || (sysDark ? 'dark' : 'light');
  // Light → Dark → Auto (follow the system) → Light …
  const cycleTheme = () => setThemePref((p) => (p === 'light' ? 'dark' : p === 'dark' ? '' : 'light'));
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const [calendarOn, setCalendarOn] = useState(() => prefs.calendar);
  const [allTeamsOn, setAllTeamsOn] = useState(() => prefs.allTeams);
  useEffect(() => { savePrefs({ weekH, detailW, theme: themePref, calendar: calendarOn, allTeams: allTeamsOn, sideOpen }); }, [weekH, detailW, themePref, calendarOn, allTeamsOn, sideOpen]);
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
      const mp = minPanelW();
      const budget = sideBudget();
      setDetailW((w) => Math.max(mp, Math.min(w, budget - 14 - (leftOpenRef.current ? leftWRef.current + 14 : 0))));
      setLeftW((w) => Math.max(mp, Math.min(w, budget - 14 - (detailRef.current ? detailWRef.current + 14 : 0))));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [leftPanel, selection?.kind, sideOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  const mainRef = useRef<HTMLDivElement>(null);

  // Launch splash: the mark slides in from the bottom, plays at least one full shader sweep,
  // and once the teams are loaded it slides up and fades — timed to a sweep boundary, so the
  // stripes have just cleared when it goes.
  // Hosted web app (the PWA): anything that isn't Electron and isn't the local dev preview
  // signs in with Google; localhost can opt in with ?cloud for testing the web flow.
  const hostedWeb = !window.exponential && (!['localhost', '127.0.0.1'].includes(location.hostname) || new URLSearchParams(location.search).has('cloud'));
  const [googleUser, setGoogleUser] = useState<GoogleUser | null>(null);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 700px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 700px)');
    const on = () => setIsMobile(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const mobileShell = !window.exponential && isMobile;
  const [mTab, setMTab] = useState<'chat' | 'plan' | 'week'>('chat');
  const [mTeamsOpen, setMTeamsOpen] = useState(false);
  const chatBackRef = useRef<(() => boolean) | null>(null);
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
      if (selRef.current) { setSelection(null); return; }
      chatBackRef.current?.();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
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

  /** Project edits notify everyone assigned (except the editor). */
  const updateProject = (id: string, patch: Partial<Project>, coalesce?: string) =>
    update((d) => {
      const before = d.projects.find((p) => p.id === id);
      if (!before) return d;
      if (Object.entries(patch).every(([k, v]) => Object.is(before[k as keyof Project], v))) return d; // no-op: no phantom undo step
      const after = { ...before, ...patch };
      let next: Data = { ...d, projects: d.projects.map((p) => (p.id === id ? after : p)) };
      const what = patch.name !== undefined && patch.name !== before.name ? 'renamed' : patch.start || patch.end ? 'moved' : patch.notes !== undefined ? 'updated the notes of' : patch.assignees ? null : 'changed';
      if (patch.assignees) {
        for (const pid of patch.assignees.filter((x) => !before.assignees?.includes(x))) {
          next = notify(next, { to: pid, from: d.me, kind: 'project-changed', text: `${nameOf(d, d.me)} added you to “${after.name}”`, ref: { kind: 'project', id } });
        }
      } else if (what && !coalesce) {
        for (const pid of after.assignees ?? []) {
          next = notify(next, { to: pid, from: d.me, kind: 'project-changed', text: `${nameOf(d, d.me)} ${what} “${after.name}”`, ref: { kind: 'project', id } });
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
    fetchChat(d.id, d.me, cloudMode).then((chs) => { setChat(chs); setChatActive((cur) => cur && chs.some((c) => c.id === cur) ? cur : chs[0]?.id ?? null); }).catch(() => {});
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
    const subs = others.map((t) => subscribeTeam(t.id, me, () => fetchOne(t.id)));
    const onFocus = () => { if (Date.now() - lastFetch > 300_000) fetchAll(); }; // realtime can drop while the machine sleeps
    window.addEventListener('focus', onFocus);
    return () => { dead = true; subs.forEach((off) => off()); window.removeEventListener('focus', onFocus); };
  }, [allTeamsOn, cloudMode, data?.id, data?.me, teamIds]); // eslint-disable-line react-hooks/exhaustive-deps
  const foreign = (() => {
    if (!foreignTeams) return null;
    const tasks: Task[] = [];
    const badge = new Map<string, { id: string; name: string; icon?: string }>();
    const teamOf = new Map<string, string>();
    for (const [tid, fd] of foreignTeams) {
      if (tid === data?.id) continue; // just switched here: its tasks are the LIVE ones now (the refetch hasn't caught up yet)
      const info = teams.find((t) => t.id === tid);
      for (const t of fd.tasks) {
        if (t.deletedAt) continue;
        tasks.push(t);
        badge.set(t.id, { id: tid, name: info?.name ?? fd.name, icon: info?.icon ?? fd.icon ?? undefined });
        teamOf.set(t.id, tid);
      }
    }
    return { tasks, badge, teamOf };
  })();
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
  const [calTick, setCalTick] = useState(0);
  useEffect(() => {
    if (!calendarOn || !googleUser) return;
    const iv = window.setInterval(() => setCalTick((t) => t + 1), 60_000);
    return () => window.clearInterval(iv);
  }, [calendarOn, googleUser]);

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
    window.exponential.google.events(calendarId, week, addDays(week, 6))
      .then((ev) => { if (!cancelled) { setCalEvents((c) => ({ ...c, [key]: ev })); setCalNote(undefined); setCalReauth(false); } })
      .catch((err: Error) => {
        if (cancelled) return;
        // My own calendar failing auth-wise = the grant was revoked or expired: offer to reconnect.
        if (calendarId === 'primary' && /401|403|invalid|insufficient|denied|scope/i.test(err.message)) {
          setCalNote('Calendar access was lost');
          setCalReauth(true);
        } else setCalNote(/404|403/.test(err.message) ? 'Calendar not shared with you' : err.message);
        setCalEvents((c) => (c[key] ? c : { ...c, [key]: [] })); // keep the last good events on a failed refresh
      });
    return () => { cancelled = true; };
  }, [!!data, calendarOn, googleUser, person, week, calTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const [calReauth, setCalReauth] = useState(false);
  const reauthCalendar = async () => {
    const g = window.exponential?.google;
    if (!g) return;
    setCalNote('Waiting for Google in your browser…');
    const ok = await g.grantCalendar().catch(() => false);
    if (!ok) { setCalNote('Calendar access was not granted'); return; }
    setCalReauth(false);
    setCalEvents({});
    setCalTick((t) => t + 1);
  };

  // Five minutes before one of my meetings a system notification fires. Today's own
  // calendar refreshes every 10 minutes; the countdown check runs every 30 seconds.
  const [myToday, setMyToday] = useState<CalendarEvent[]>([]);
  useEffect(() => {
    if (!calendarOn || !googleUser || !window.exponential) { setMyToday([]); return; }
    let dead = false;
    const load = () => {
      const day = todayISO();
      window.exponential!.google.events('primary', day, day)
        .then((ev) => { if (!dead) setMyToday(ev); })
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
  const live = { ...data, projects: data.projects.filter((p) => !p.deletedAt), tasks: data.tasks.filter((t) => !t.deletedAt) };
  const selProject = selection?.kind === 'project' ? live.projects.find((p) => p.id === selection.id) : undefined;
  const selTask = selection?.kind === 'task' ? live.tasks.find((t) => t.id === selection.id) : undefined;
  const selDeadline = selection?.kind === 'deadline' ? data.deadlines.find((d) => d.id === selection.id) : undefined;
  const detailOpen = !!(selProject || selTask || selDeadline) || selection?.kind === 'retro';
  detailRef.current = detailOpen;
  const leftOpen = leftPanel !== null;
  const unread = (data.notifications ?? []).filter((n) => n.to === data.me && !n.read).length;
  const chatUnread = chat.reduce((n, c) => n + c.unread, 0);

  const calKey = `${person === data.me ? 'primary' : data.people.find((x) => x.id === person)?.email}|${week}`;

  // The planner elements are SHARED between the desktop shell and the phone shell:
  // same props, same handlers — only the frame around them differs.
  const bigPlanEl = (
            <BigPlan
              projects={live.projects}
              groups={data.groups ?? []}
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
            <WeekPlan
              people={data.people}
              me={data.me}
              selected={person}
              onSelect={setSelectedPerson}
              week={week}
              today={today}
              tasks={[...live.tasks, ...(foreign?.tasks.filter((t) => t.personId === person) ?? [])]
                .filter((t) => (t.personId === person || (t.reviewerId === person && (t.status === 'review' || t.reviewDone))) && (!t.date || (t.date <= addDays(week, 6) && (t.end ?? t.date) >= week)))}
              teamBadge={foreign && data ? (id) => foreign.badge.get(id) ?? { id: data.id, name: data.name, icon: data.icon ?? undefined } : undefined}
              allTeams={cloudMode && teams.length > 1 ? { on: allTeamsOn, toggle: () => setAllTeamsOn((v) => !v) } : undefined}
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
              calendar={{
                enabled: calendarOn,
                available: !!googleUser,
                hidden: !window.exponential, // the web build has no Google Calendar at all
                events: calEvents[calKey] ?? [],
                note: !window.exponential ? 'Available in the desktop app' : !googleUser ? 'Sign in with Google to see events' : calNote,
                onReauth: calReauth ? reauthCalendar : undefined,
              }}
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
          <DetailPanel
            width={w}
            selection={selection}
            project={selProject}
            task={selTask}
            deadline={selDeadline}
            retro={selection.kind === 'retro' ? data.retros?.[selection.id] : undefined}
            prevRetro={selection.kind === 'retro' ? data.retros?.[addDays(selection.id, -7)] : undefined}
            carriedConfidence={selection.kind === 'retro' ? (() => {
              // OKR scores roll forward: a new week starts where the last one left off
              const m: Record<string, number> = {};
              for (const w of Object.keys(data.retros ?? {}).sort()) {
                if (w >= selection.id) break;
                Object.assign(m, data.retros![w].answers.confidence ?? {});
              }
              return m;
            })() : undefined}
            retroTemplate={data.retroTemplate}
            notifications={data.notifications ?? []}
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
            groups={data.groups ?? []}
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

  if (mobileShell) {
    return (
      <div className="mobile-shell">
        {mTab === 'chat' && (
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
            onOpenItem={(sel) => setSelection(sel)}
            onMarkRead={(ids) => update((d) => ({ ...d, notifications: (d.notifications ?? []).map((n) => (ids.includes(n.id) ? { ...n, read: true } : n)) }), 'mark-read')}
            onClose={() => {}}
            onError={(m) => { setSaveError(m); window.setTimeout(() => setSaveError(null), 6000); }}
            jumpToThread={chatJump}
            onJumped={() => setChatJump(false)}
            backRef={chatBackRef}
          />
        )}
        {mTab === 'plan' && <section className="panel mobile-pane">{bigPlanEl}</section>}
        {mTab === 'week' && <section className="panel mobile-pane">{weekPlanEl}</section>}
        {selection && <div className="mobile-detail">{detailEl(window.innerWidth)}</div>}
        <nav className="mobile-tabs">
          <button className={mTab === 'chat' ? 'on' : ''} onClick={() => { setSelection(null); setMTab('chat'); }}>
            <span className="nav-ico"><ChatIcon />{(chatUnread > 0 || unread > 0) && <span className="nav-dot" />}</span>
            Messages
          </button>
          <button className={mTab === 'plan' ? 'on' : ''} onClick={() => { setSelection(null); setMTab('plan'); }}><PlanIcon /> Plan</button>
          <button className={mTab === 'week' ? 'on' : ''} onClick={() => { setSelection(null); setMTab('week'); }}><WeekIcon /> Week</button>
          <button className={mTeamsOpen ? 'on' : ''} onClick={() => setMTeamsOpen((v) => !v)}>
            <TeamMark team={teams.find((t) => t.id === data.id) ?? { id: data.id, name: data.name, icon: data.icon }} />
            Teams
          </button>
        </nav>
        {mTeamsOpen && (
          <div className="mobile-teams" onPointerDown={() => setMTeamsOpen(false)}>
            <div className="mobile-teams-card" onPointerDown={(e) => e.stopPropagation()}>
              {teams.map((t) => (
                <button key={t.id} className={t.id === data.id ? 'current' : ''}
                  onClick={() => { setMTeamsOpen(false); if (t.id !== data.id) { switchTeam(t.id); setSelection(null); setSelectedPerson(null); setMTab('chat'); } }}>
                  <TeamMark team={t} /> <span>{t.name}</span>
                </button>
              ))}
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
        {saveError && <div className="toast error-toast">{saveError}</div>}
      </div>
    );
  }

  return (
    <div className="shell">
      <aside className={`sidebar${window.exponential?.platform === 'darwin' ? ' mac' : ''}${sideOpen ? ' open' : ''}`}>
       <div className="sidebar-inner">
        <div className="team-list">
          {teams.map((t) => (
            <div key={t.id} className={`team-row${t.id === data.id ? ' current' : ''}`} title={t.name}>
              <button className="team-main" onClick={() => { if (t.id !== data.id) { switchTeam(t.id); setSelection(null); setSelectedPerson(null); setView('plan'); } else setView('plan'); }}>
                <TeamMark team={t} />
                <span className="team-name">{t.name}</span>
              </button>
              <button className={`team-cog${t.id === data.id && view === 'team' ? ' on' : ''}`} title="Team settings"
                onClick={() => { if (t.id !== data.id) { switchTeam(t.id); setSelectedPerson(null); } setSelection(null); setView('team'); }}>
                <CogIcon />
              </button>
            </div>
          ))}
          <button className="team-row add" onClick={() => setSheet('new-team')}>
            <span className="team-mark plus">+</span>
            <span className="team-name">New team</span>
          </button>
        </div>
        <button className={`nav-item${view === 'plan' ? ' active' : ''}`} onClick={() => setView('plan')}><PlanIcon /> <span className="nav-text">Plan</span></button>
        <button className={`nav-item${leftPanel === 'chat' ? ' active' : ''}`} onClick={() => setLeftPanel(leftPanel === 'chat' ? null : 'chat')}>
          <span className="nav-ico"><ChatIcon />{(chatUnread > 0 || unread > 0) && <span className="nav-dot" />}</span>
          <span className="nav-text">Messages</span>
        </button>
        <button className={`nav-item${leftPanel === 'meetings' ? ' active' : ''}`} onClick={() => setLeftPanel(leftPanel === 'meetings' ? null : 'meetings')}>
          <span className="nav-ico"><MeetIcon />{meetDot && <span className="nav-dot" />}</span>
          <span className="nav-text">Meetings</span>
        </button>

        <div className="sidebar-bottom">
          <button className="nav-item theme-toggle" onClick={() => setSideOpen((v) => !v)}
            title={sideOpen ? 'Collapse the sidebar' : 'Expand the sidebar'}>
            <PanelIcon open={sideOpen} />
            <span className="nav-text">Collapse</span>
          </button>
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

      <div className={`main${detailOpen ? ' with-detail' : ''}`}>
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
                  onJumped={() => setChatJump(false)}
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
        {view === 'team' && (
          <TeamPage
            team={data}
            cloud={cloudMode}
            canDelete={cloudMode || teams.length > 1}
            onUpdate={(fn, coalesce) => update(fn, coalesce)}
            onDelete={() => { setView('plan'); setSelection(null); setSelectedPerson(null); deleteTeam(data.id); }}
          />
        )}
        <div className="planners" ref={mainRef} style={view !== 'plan' ? { display: 'none' } : undefined}>
          <section className="panel" style={{ flex: '1 1 0' }} ref={planSecRef}>
            <div className="panel-head">
              <div className="panel-title">Master plan</div>
              <div className="panel-spacer" />
              {!isThisWeek && <button className="pill" onClick={() => setWeek(weekStart(today))}>Back to this week</button>}
              <button
                className={`pill toggle${unlocked ? ' active' : ''}`}
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
          style={{ width: detailOpen ? detailW + 14 : 0 }}
          onTransitionEnd={(e) => { if (e.propertyName === 'width') setSlotAnimating(false); }}
        >
        {detailOpen && <div className={`vresizer${vResizing ? ' dragging' : ''}`} onPointerDown={onVResizeDown} />}
        {detailOpen && detailEl(detailW)}
        </div>
      </div>

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
        <NewTeamSheet onClose={() => setSheet(null)} onCreate={(name) => { createTeam(name); setSelection(null); setSelectedPerson(null); setView('team'); }} />
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

function PanelIcon({ open }: { open: boolean }) {
  return (
    <svg {...ICON}>
      <rect x="3" y="4.5" width="18" height="15" rx="3.5" />
      <path d="M9.5 4.5v15" />
      {open ? <path d="M16.5 9.5 14 12l2.5 2.5" /> : <path d="M14 9.5l2.5 2.5L14 14.5" />}
    </svg>
  );
}

function MeetIcon() {
  return (
    <svg {...ICON}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
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

function WeekIcon() {
  return <svg {...ICON}><rect x="3.5" y="5" width="17" height="15.5" rx="3.5" /><path d="M3.5 10.5h17M8.5 5.5V3m7 2.5V3" /></svg>;
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
