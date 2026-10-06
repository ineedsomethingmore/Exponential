import { useEffect, useRef, useState } from 'react';
import { WeekPlan } from './WeekPlan';
import { useData, useSystemNotifications } from './store';
import { onPersistError } from './cloud';
import type { CalendarEvent } from './types';
import { addTask, completeReview, denyReview, patchTask, renameTask, reorderTask, softDelete } from './taskOps';
import { todayISO, weekStart } from './dates';

/** Menu-bar popover: only the week panel, full featured, always synced with the main window. */
export default function Widget() {
  const { data, update, connectCloud, refresh, cloudMode } = useData();
  const cloudRef = useRef(cloudMode);
  cloudRef.current = cloudMode;
  // Keep trying to reach the cloud (30s + every open) instead of one silent attempt: during the
  // egress outage a single failure left widgets on the stale LOCAL file for the whole session,
  // quietly writing tasks nobody would ever see.
  const tryCloud = useRef(() => {});
  useEffect(() => {
    let dead = false;
    let timer: number | undefined;
    const attempt = () => {
      if (dead || cloudRef.current || !window.exponential) return;
      connectCloud().then((ok) => { if (!dead && !ok) retry(); }).catch((e) => { console.error('[widget] cloud', e); if (!dead) retry(); });
    };
    const retry = () => { window.clearTimeout(timer); timer = window.setTimeout(attempt, 30_000); };
    tryCloud.current = attempt;
    attempt();
    return () => { dead = true; window.clearTimeout(timer); };
  }, [connectCloud]);
  // Failed saves must be VISIBLE here too — the widget once swallowed every persist error.
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => onPersistError((m) => { setSaveError(m); window.setTimeout(() => setSaveError(null), 8000); }), []);
  useSystemNotifications(data);
  const [today, setToday] = useState(todayISO());
  const [week, setWeek] = useState(() => weekStart(todayISO()));
  const [person, setPerson] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Follow the theme and calendar preference chosen in the main window (same origin → same
  // localStorage); re-check whenever they change or the popover opens.
  const readCalPref = () => { try { return JSON.parse(localStorage.getItem('exponential-layout') ?? '{}').calendar !== false; } catch { return true; } };
  const [calOn, setCalOn] = useState(readCalPref);
  const applyTheme = () => {
    let saved = '';
    try { saved = JSON.parse(localStorage.getItem('exponential-layout') ?? '{}').theme || ''; } catch { /* ignore */ }
    document.documentElement.dataset.theme = saved || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  };
  useEffect(() => {
    document.documentElement.classList.add('widget-window');
    applyTheme();
    const sync = () => { applyTheme(); setCalOn(readCalPref()); };
    window.addEventListener('storage', sync);
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener('change', applyTheme);
    return () => { window.removeEventListener('storage', sync); mq?.removeEventListener('change', applyTheme); };
  }, []);

  // My calendar for the shown week, when the main window has calendar on and access is granted.
  // Refetched every time the popover opens and once a minute.
  const [calEvents, setCalEvents] = useState<CalendarEvent[]>([]);
  const [calTick, setCalTick] = useState(0);
  useEffect(() => {
    if (!calOn) return;
    // the widget pre-loads hidden and lives all day — don't poll Google for a popover
    // nobody can see; becoming visible (popover open) refreshes immediately instead
    const tick = () => { if (document.visibilityState !== 'hidden') setCalTick((t) => t + 1); };
    const iv = window.setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(iv); document.removeEventListener('visibilitychange', tick); };
  }, [calOn]);
  useEffect(() => {
    const g = window.exponential?.google;
    if (!g || !calOn) { setCalEvents([]); return; }
    let dead = false;
    g.hasCalendar()
      .then((ok) => (ok && !dead ? g.events('primary', week, addDaysISO(week, 6)) : []))
      .then((ev) => { if (!dead) setCalEvents(ev); })
      .catch(() => { /* keep the last good events */ });
    return () => { dead = true; };
  }, [calOn, week, calTick]);

  const me = data?.me ?? '';
  const who = person ?? me;

  // The shown handler is registered once, so everything it touches must be read fresh through
  // refs — the data it saw at registration is the LOCAL file snapshot from before connectCloud
  // finished, and a task created against that gets a person id the cloud rejects.
  const dataRef = useRef(data);
  dataRef.current = data;

  const startNewTask = (personId?: string) => {
    if (!dataRef.current) return;
    const w = personId ?? who;
    let id = '';
    // at the top of the backlog, so the week's tasks stay in view while you type
    update((d) => { const r = addTask(d, w, undefined, 'start'); id = r.id; return r.data; });
    setEditingId(id);
  };
  const startRef = useRef(startNewTask);
  startRef.current = startNewTask;

  // Each time the popover opens — or as soon as data arrives, when it opened before the data —
  // a fresh task is ready to type into, on the current week, for me.
  const pendingOpen = useRef(false);
  useEffect(() => {
    if (pendingOpen.current && data) { pendingOpen.current = false; startRef.current(data.me); }
  }, [!!data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    return window.exponential?.onWidgetShown(() => {
      applyTheme();
      setCalOn(readCalPref());
      setCalTick((t) => t + 1); // fresh events every time the popover opens
      setToday(todayISO());
      setWeek(weekStart(todayISO()));
      setPerson(null);
      tryCloud.current(); // still on local data? another shot at signing in before the user types
      refresh(); // catch up on anything missed while the window was hidden (throttled timers)
      const d = dataRef.current;
      if (d) startRef.current(d.me);
      else pendingOpen.current = true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(document.activeElement as HTMLElement)?.matches('input, textarea')) window.exponential?.closeWidget(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  if (!data) return null;

  return (
    <div className="widget">
      {window.exponential && !cloudMode && (
        <div className="toast error-toast">Not connected — tasks added here won't sync</div>
      )}
      {saveError && <div className="toast error-toast">{saveError}</div>}
      <section className="panel widget-panel">
        <WeekPlan
          people={data.people.filter((p) => p.id === me)}
          me={me}
          selected={who}
          onSelect={setPerson}
          week={week}
          today={today}
          tasks={data.tasks.filter((t) => !t.deletedAt && (t.personId === who || (t.reviewerId === who && (t.status === 'review' || t.reviewDone))) && (!t.date || (t.date <= addDaysISO(week, 6) && (t.end ?? t.date) >= week)))}
          editingId={editingId ?? undefined}
          onToggleSelect={() => {}}
          onAdd={(date) => { let id = ''; update((d) => { const r = addTask(d, who, date); id = r.id; return r.data; }); setEditingId(id); }}
          onRename={(id, title, viaEnter) => {
            setEditingId(null);
            let nextId = '';
            update((d) => {
              const renamed = renameTask(d, id, title);
              if (viaEnter && title) { const r = addTask(renamed, who, undefined); nextId = r.id; return r.data; }
              return renamed;
            });
            if (nextId) setEditingId(nextId);
          }}
          onAddNamed={(title) => update((d) => { const r = addTask(d, who, undefined); return renameTask(r.data, r.id, title); })}
          onUpdate={(id, patch) => update((d) => patchTask(d, id, patch))}
          onDelete={(id) => update((d) => softDelete(d, [id]))}
          onDeny={(id) => update((d) => denyReview(d, id))}
          onCompleteReview={(id) => update((d) => completeReview(d, id))}
          onOpen={(t) => window.exponential?.openMain({ kind: 'task', id: t.id })}
          onReorder={(id, afterId) => update((d) => reorderTask(d, id, afterId))}
          onWeekChange={setWeek}
          calendar={{ enabled: calOn && !!window.exponential, available: true, events: calEvents }}
          onToggleCalendar={() => {}}
          headExtra={
            <button className="pill" onClick={() => window.exponential?.openMain()} title="Open Exponential">
              Open app <span className="arrow">↗</span>
            </button>
          }
        />
      </section>
    </div>
  );
}

function addDaysISO(iso: string, n: number) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
