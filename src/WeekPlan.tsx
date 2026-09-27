import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CalendarEvent, ISODate, Person, Status, Task } from './types';
import { STATUS_COLOR, STATUS_LABEL, STATUS_ORDER, shortName } from './types';
import { addDays, dayIndex, dayOfMonth, isoWeekNumber, weekdayShort } from './dates';
import { InlineName } from './BigPlan';
import { confettiBurst } from './confetti';
import { renderInlineMd } from './richtext';

const EDGE = 8;
const SWIPE_TRIGGER = 120; // accumulated px of horizontal scroll that flips the week

interface Props {
  people: Person[];
  me: string;
  selected: string;
  onSelect: (id: string) => void;
  week: ISODate;
  today: ISODate;
  tasks: Task[];
  selectedId?: string;
  selectedIds?: Set<string>;
  editingId?: string;
  onToggleSelect: (id: string) => void;
  onAdd: (date?: ISODate) => void;
  onAddNamed: (title: string) => void; // from the placeholder row shown when the week is empty
  onRename: (id: string, title: string, viaEnter?: boolean) => void;
  onEdit?: (id: string) => void; // double-click on a title: rename it in place
  onUpdate: (id: string, patch: Partial<Task>) => void;
  onDelete: (id: string) => void;
  onDuplicate?: (id: string) => void; // right-click Duplicate
  onDeleteMany?: (ids: string[]) => void; // right-click Delete with a multi-selection
  onDeny?: (id: string) => void; // decline a review request shown in my week
  onCompleteReview?: (id: string) => void; // sign off on one
  onOpen: (t: Task) => void;
  onReorder: (id: string, afterId: string | null) => void; // drop the task right after this one (null = top of its day)
  onWeekChange: (monday: ISODate) => void;
  calendar: { enabled: boolean; available: boolean; events: CalendarEvent[]; note?: string; onReauth?: () => void; hidden?: boolean };
  onToggleCalendar: () => void;
  teamBadge?: (id: string) => { id?: string; name: string; icon?: string } | undefined; // set for tasks pulled in from OTHER teams
  allTeams?: { on: boolean; toggle: () => void }; // "All teams" pill (multi-team members only)
  headExtra?: React.ReactNode; // e.g. the widget's "open app" button
}

/** Everyone has full freedom in everyone's week — the owner just hears about changes others make. */
export function WeekPlan(props: Props) {
  const { people, me, selected, onSelect, week, today, tasks, selectedId, selectedIds, editingId, onToggleSelect, onAdd, onAddNamed, onRename, onEdit, onUpdate, onDelete, onDuplicate, onDeleteMany, onDeny, onCompleteReview, onOpen, onReorder, onWeekChange, onToggleCalendar, teamBadge, allTeams, headExtra } = props;
  const calendar = props.calendar.hidden ? { ...props.calendar, enabled: false } : props.calendar; // web build: no calendar at all
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  // Invited members who haven't signed in yet can't own tasks (their rows wouldn't persist).
  const readonly = selected.startsWith('pending:');
  const other = selected !== me; // wording only — someone else's week is fully editable
  const todayIdx = dayIndex(today) - dayIndex(week);
  const bodyRef = useRef<HTMLDivElement>(null);
  // phones: the day columns scroll horizontally (148px title col + 616px of days, see the
  // .shell.phone .wk-row CSS) — open with today's column centred; other weeks keep their scroll
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || el.scrollWidth <= el.clientWidth + 8) return; // desktop layout: nothing scrolls
    if (todayIdx < 0 || todayIdx > 6) return;
    el.scrollLeft = Math.max(0, ((todayIdx + 0.5) * 616) / 7 - (el.clientWidth - 148) / 2);
  }, [week, todayIdx]);
  const [todayX, setTodayX] = useState<number | null>(null);
  // Sideways scrolling only exists when the panel is genuinely too narrow; otherwise the body is
  // overflow-hidden so the swipe animation's transform can never leave a few stray scrollable pixels.
  const [narrow, setNarrow] = useState(false);
  const narrowRef = useRef(false);
  narrowRef.current = narrow;
  const [ghost, setGhost] = useState<number | null>(null);
  const [swipe, setSwipe] = useState({ x: 0, animate: false });
  const [lift, setLift] = useState<{ id: string; dy: number; rowH: number } | null>(null);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const compute = () => {
      setNarrow(el.clientWidth < 600); // .wk-swipe min-width 560 + body side padding
      if (todayIdx < 0 || todayIdx > 6) return setTodayX(null);
      const tl = el.querySelector<HTMLElement>('.wk-days');
      if (!tl) return;
      setTodayX(tl.offsetLeft + ((todayIdx + 0.5) / 7) * tl.offsetWidth);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [todayIdx, week]);

  // Horizontal trackpad swipe: flip exactly once per gesture, then ignore the rest of that gesture
  // (including its momentum tail). No rubber-banding — the content just eases in on the flip.
  const weekRef = useRef(week);
  weekRef.current = week;
  useEffect(() => {
    const el = bodyRef.current!;
    let acc = 0, locked = false, lockDir = 0, last = 0, prevAbs = 0;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      if (narrowRef.current) return; // too narrow: sideways wheel scrolls instead of flipping weeks
      e.preventDefault();
      const now = performance.now();
      const abs = Math.abs(e.deltaX);
      const newGesture = now - last > 150
        || (locked && Math.sign(e.deltaX) === -lockDir && abs > 6)
        || (locked && prevAbs < 4 && abs > prevAbs * 2.5 && abs > 6);
      if (newGesture) { acc = 0; locked = false; lockDir = 0; }
      last = now;
      prevAbs = abs;
      if (locked) return;
      acc += e.deltaX;
      if (Math.abs(acc) >= SWIPE_TRIGGER) {
        locked = true;
        lockDir = Math.sign(acc);
        onWeekChange(addDays(weekRef.current, lockDir * 7));
        setSwipe({ x: lockDir * 28, animate: false });
        requestAnimationFrame(() => requestAnimationFrame(() => setSwipe({ x: 0, animate: true })));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onWeekChange]);

  // Dated tasks first by day, then the backlog (undated) at the bottom.
  const dateKey = (t: Task) => t.date ?? '9999-99-99';
  const sorted = [...tasks].sort((a, b) => (dateKey(a) < dateKey(b) ? -1 : dateKey(a) > dateKey(b) ? 1 : 0) || (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title));

  // Completed tasks can be tucked away; the choice sticks per machine. A finished review of
  // someone else's task counts as completed here even though the task itself is In progress.
  const doneRow = (t: Task) => t.status === 'done' || (t.personId !== selected && !!t.reviewDone);
  const [showDone, setShowDone] = useState(() => localStorage.getItem('exponential-show-done') === '1'); // hidden by default
  const toggleDone = () => setShowDone((v) => { localStorage.setItem('exponential-show-done', v ? '0' : '1'); return !v; });
  const doneCount = sorted.filter(doneRow).length;
  const visible = showDone ? sorted : sorted.filter((t) => !doneRow(t));

  // While a row is lifted, same-day neighbours slide out of its way so the drop position is obvious.
  const lifted = lift ? visible.find((t) => t.id === lift.id) : undefined;
  const group = lifted ? visible.filter((t) => t.date === lifted.date) : [];
  const liftIdx = lifted ? group.findIndex((t) => t.id === lifted.id) : -1;
  const liftSteps = lift ? Math.min(group.length - 1 - liftIdx, Math.max(-liftIdx, Math.round(lift.dy / lift.rowH))) : 0;
  const liftStepsRef = useRef(0); // read at drop time: the row's pointer handlers were bound before the drag began
  liftStepsRef.current = liftSteps;
  // The exact visible row the drop lands after (among the same person's own rows), so the commit
  // matches the preview even when hidden done rows or review rows sit in between.
  const dropAfterRef = useRef<string | null>(null);
  dropAfterRef.current = (() => {
    if (!lift || !lifted) return null;
    const arr = group.filter((t) => t.id !== lifted.id);
    arr.splice(liftIdx + liftSteps, 0, lifted);
    // reordering stays within one team's group: the drop target must live where the dragged task lives
    const sub = arr.filter((t) => t.personId === lifted.personId && teamBadge?.(t.id)?.id === teamBadge?.(lifted.id)?.id);
    const i = sub.findIndex((t) => t.id === lifted.id);
    return i > 0 ? sub[i - 1].id : null;
  })();
  const rowOffset = (t: Task) => {
    if (!lift) return 0;
    if (t.id === lift.id) return Math.min((group.length - 1 - liftIdx) * lift.rowH, Math.max(-liftIdx * lift.rowH, lift.dy));
    const j = group.findIndex((x) => x.id === t.id);
    if (j < 0) return 0;
    if (j > liftIdx && j <= liftIdx + liftSteps) return -lift.rowH;
    if (j < liftIdx && j >= liftIdx + liftSteps) return lift.rowH;
    return 0;
  };
  const events = calendar.enabled ? calendar.events.filter((e) => days.includes(e.date)) : [];
  // Via Google's account chooser: it switches to (or asks the user to pick) the right account,
  // then continues to the event itself — the one way the event deep link works cross-account.
  const openEvent = (e: CalendarEvent) => {
    const target = e.link ?? `https://calendar.google.com/calendar/r/day/${e.date.replaceAll('-', '/')}`;
    const myEmail = people.find((p) => p.id === me)?.email;
    window.open(myEmail
      ? `https://accounts.google.com/AccountChooser?Email=${encodeURIComponent(myEmail)}&continue=${encodeURIComponent(target)}`
      : target);
  };
  // Each day's first still-upcoming event is pinned as an overlay on the bottom row while its real
  // row is scrolled below the fold; each pill yields to its own row as it comes into view.
  const pinnedCandidates = (() => {
    if (!events.length) return [] as CalendarEvent[];
    const nowT = new Date().toTimeString().slice(0, 5);
    const out: CalendarEvent[] = [];
    for (const d of days) {
      if (d < today) continue;
      const dayEvs = events.filter((e) => e.date === d).sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));
      const pick = d === today ? dayEvs.find((e) => e.allDay || !e.start || (e.end ?? e.start) >= nowT) : dayEvs[0];
      if (pick) out.push(pick);
    }
    return out;
  })();
  const evRowEls = useRef(new Map<string, HTMLElement>());
  const candidatesRef = useRef(pinnedCandidates);
  candidatesRef.current = pinnedCandidates;
  const candidatesKey = pinnedCandidates.map((e) => e.id).join(',');
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  useEffect(() => {
    const rows = bodyRef.current?.querySelector<HTMLElement>('.wk-rows');
    if (!rows || !candidatesKey) { setPinnedIds([]); return; }
    const check = () => {
      const rb = rows.getBoundingClientRect().bottom;
      const next = candidatesRef.current
        .filter((e) => { const el = evRowEls.current.get(e.id); return el ? el.getBoundingClientRect().bottom > rb + 1 : false; })
        .map((e) => e.id);
      setPinnedIds((prev) => (prev.join(',') === next.join(',') ? prev : next));
    };
    check();
    rows.addEventListener('scroll', check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(rows);
    return () => { rows.removeEventListener('scroll', check); ro.disconnect(); };
  }, [candidatesKey, tasks, week, calendar.enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const eventBlock = (e: CalendarEvent) => (
    <div
      key={e.id}
      className="wk-block ev"
      style={{ left: `${(days.indexOf(e.date) / 7) * 100}%`, width: `calc(100% / 7 - 6px)` }}
      onClick={() => openEvent(e)}
      title={`${e.title} — open in Google Calendar`}
    >
      {!e.allDay && <span>{e.start}</span>} {e.title}
    </div>
  );

  const dayAt = (el: HTMLElement, clientX: number) => {
    const r = el.getBoundingClientRect();
    return Math.min(6, Math.max(0, Math.floor(((clientX - r.left) / r.width) * 7)));
  };

  return (
    <>
      <div className="panel-head">
        <div className="panel-title">Week {isoWeekNumber(week)}</div>
        {!calendar.hidden && (
          <button
            className={`pill toggle${calendar.enabled ? ' active' : ''}`}
            onClick={onToggleCalendar}
            title={calendar.available ? 'Show Google Calendar events' : 'Sign in with Google to show calendar events'}
          >
            <CalIcon /> Calendar
          </button>
        )}
        {allTeams && (
          <button className={`pill toggle${allTeams.on ? ' active' : ''}`} onClick={allTeams.toggle} title="Show your tasks from every team you're in">
            All teams
          </button>
        )}
        <div className="panel-spacer" />
        {headExtra}
        <PersonDropdown people={people} me={me} selected={selected} onSelect={onSelect} />
      </div>

      <div className={`wk-body${narrow ? ' narrow' : ''}`} ref={bodyRef}>
        <div className="wk-swipe" style={{ transform: `translateX(${swipe.x}px)`, transition: swipe.animate ? 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)' : 'none' }}>
          <div className="wk-row wk-header">
            <div className="wk-list">
              {(doneCount > 0 || !showDone) && (
                <button className="done-toggle" onClick={toggleDone}>
                  {showDone ? 'Hide completed' : 'Show completed'}
                </button>
              )}
            </div>
            <div className="wk-days">
              {days.map((d, i) => (
                <div key={d} className={`wk-day${i === todayIdx ? ' today' : ''}${i >= 5 ? ' weekend' : ''}`}>
                  <span className="num">{dayOfMonth(d)}</span> {weekdayShort(d)}
                </div>
              ))}
            </div>
          </div>

          <div className="wk-rows">
            {visible.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                week={week}
                readonly={readonly && editingId !== t.id}
                reviewRow={t.personId !== selected}
                team={teamBadge?.(t.id)}
                people={people}
                me={me}
                selected={selectedId === t.id || !!selectedIds?.has(t.id)}
                editing={editingId === t.id}
                onUpdate={onUpdate}
                onDelete={onDelete}
                onDuplicate={onDuplicate}
                selCount={selectedIds?.has(t.id) ? selectedIds.size : 1}
                onDeleteSel={selectedIds?.has(t.id) && selectedIds.size > 1 && onDeleteMany ? () => onDeleteMany([...selectedIds]) : undefined}
                onDeny={onDeny}
                onCompleteReview={onCompleteReview}
                onOpen={onOpen}
                onToggleSelect={onToggleSelect}
                onRename={onRename}
                onEdit={onEdit}
                offset={rowOffset(t)}
                lifting={lift?.id === t.id}
                onLift={(dy, rowH) => setLift({ id: t.id, dy, rowH })}
                onDrop={() => { if (liftStepsRef.current !== 0) onReorder(t.id, dropAfterRef.current); setLift(null); }}
                onMoveToNow={
                  // unfinished task in a past week: offer to pull it to the top of the backlog
                  dayIndex(today) >= dayIndex(week) + 7 && !readonly && t.personId === selected && !!t.date && t.status !== 'done' && t.status !== 'cancelled'
                    ? () => {
                        const top = tasks.reduce((m, x) => (!x.date && x.personId === t.personId && !x.deletedAt ? Math.min(m, (x.order ?? 0) - 1) : m), 0);
                        onUpdate(t.id, { date: undefined, end: undefined, order: top });
                      }
                    : undefined
                }
              />
            ))}
            {readonly && visible.length === 0 && <div className="hint wk-empty">Nothing planned this week.</div>}
            {!readonly && visible.length === 0 && <PlaceholderRow onAdd={onAddNamed} />}

            {(
              <div className="wk-row wk-free">
                <div className="wk-list" />
                <div
                  className="wk-days ghost-zone"
                  onPointerMove={(e) => setGhost(dayAt(e.currentTarget, e.clientX))}
                  onPointerLeave={() => setGhost(null)}
                  onClick={(e) => { onAdd(days[dayAt(e.currentTarget, e.clientX)]); setGhost(null); }}
                >
                  {ghost !== null && (
                    <div className="wk-block ghost" style={{ left: `${(ghost / 7) * 100}%`, width: `calc(100% / 7 - 6px)` }} />
                  )}
                </div>
              </div>
            )}

            {calendar.enabled && (
              <>
                <div className="wk-section">
                  Calendar
                  {calendar.note && <span className="wk-note"> · {calendar.note}</span>}
                  {calendar.onReauth && <button className="pill cal-reauth" onClick={calendar.onReauth}>Reconnect</button>}
                </div>
                {events.map((e) => (
                  <div key={e.id} className="wk-row event" ref={(el) => { if (el) evRowEls.current.set(e.id, el); else evRowEls.current.delete(e.id); }}>
                    <div className="wk-list">
                      <span className="ev-time">{e.allDay ? 'All day' : e.start}</span>
                      <span className="ev-title">{e.title}</span>
                    </div>
                    <div className="wk-days">{eventBlock(e)}</div>
                  </div>
                ))}
                {events.length === 0 && !calendar.note && <div className="hint wk-empty">No events this week.</div>}
              </>
            )}
          </div>
        </div>

        {todayX !== null && <div className="week-today-line" style={{ left: todayX }} />}
        {pinnedIds.length > 0 && (
          <div className="wk-row event pinned">
            <div className="wk-list" />
            <div className="wk-days">{pinnedCandidates.filter((e) => pinnedIds.includes(e.id)).map(eventBlock)}</div>
          </div>
        )}
      </div>

      <button className="fab" onClick={() => onAdd()} title={other ? `Add a task for ${shortName(people.find((p) => p.id === selected)?.name ?? '')}` : 'Add a task (goes to your backlog)'}>
        <span className="plus">+</span> Add task
      </button>
    </>
  );
}

type BlockDrag = { mode: 'move' | 'start' | 'end'; s: number; e: number };

function TaskRow({ task, week, readonly, reviewRow, team, people, me, selected, editing, onUpdate, onDelete, onDuplicate, selCount = 1, onDeleteSel, onDeny, onCompleteReview, onOpen, onToggleSelect, onRename, onEdit, offset, lifting, onLift, onDrop, onMoveToNow }: {
  task: Task;
  team?: { name: string; icon?: string }; // the OTHER team this task came from (all-teams view)
  week: ISODate;
  readonly: boolean;
  reviewRow: boolean; // someone else's task, here because they asked this week's person for a review
  people: Person[];
  me: string;
  selected: boolean;
  editing: boolean;
  onUpdate: Props['onUpdate'];
  onDelete: Props['onDelete'];
  onDuplicate?: Props['onDuplicate'];
  selCount?: number;
  onDeleteSel?: () => void;
  onDeny?: Props['onDeny'];
  onCompleteReview?: Props['onCompleteReview'];
  onOpen: Props['onOpen'];
  onToggleSelect: Props['onToggleSelect'];
  onRename: Props['onRename'];
  onEdit?: Props['onEdit'];
  offset: number;
  lifting: boolean;
  onLift: (dy: number, rowH: number) => void;
  onDrop: () => void;
  onMoveToNow?: () => void; // past weeks: pull this unfinished task to the top of the backlog
}) {
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null); // right-click menu
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (editing) rowRef.current?.scrollIntoView({ block: 'nearest' }); }, [editing]);
  useEffect(() => {
    if (!ctx) return;
    const close = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.ctx-menu')) setCtx(null); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtx(null); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', key); };
  }, [ctx]);
  const [live, setLive] = useState<BlockDrag | null>(null);
  const [hoverCursor, setHoverCursor] = useState('grab');
  const daysRef = useRef<HTMLDivElement>(null);
  const w0 = dayIndex(week);
  const backlog = !task.date;
  const [scheduleGhost, setScheduleGhost] = useState<number | null>(null);
  const s0 = task.date ? dayIndex(task.date) - w0 : 0;
  const e0 = task.date ? (task.end ? dayIndex(task.end) : dayIndex(task.date)) - w0 : 0;

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.status-menu')) setMenu(null);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);

  const onBlockDown = (e: React.PointerEvent) => {
    if (readonly || reviewRow || e.button !== 0) return;
    e.preventDefault();
    const rect = daysRef.current!.getBoundingClientRect();
    const bar = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const local = e.clientX - bar.left;
    const mode: BlockDrag['mode'] = local < EDGE ? 'start' : bar.width - local < EDGE ? 'end' : 'move';
    // Pin the cursor for the whole drag: the pointer leaves the bar between day snaps, which
    // otherwise flickers the cursor between resize/grab and the row's default.
    document.body.classList.add(mode === 'move' ? 'cursor-grabbing' : 'cursor-ew');
    const colW = rect.width / 7;
    const startX = e.clientX, startY = e.clientY;
    const rowH = rowRef.current?.offsetHeight ?? 36;
    const multi = e.metaKey || e.shiftKey || e.ctrlKey;
    let moved = false;
    let axis: 'x' | 'y' | null = null; // decided by the first clear movement
    let latest: BlockDrag = { mode, s: s0, e: e0 };
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!axis && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) axis = mode === 'move' && Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
      if (axis === 'y') { moved = true; onLift(dy, rowH); return; }
      if (Math.abs(dx) > 3) moved = true;
      const dd = Math.round(dx / colW);
      if (mode === 'move') latest = { mode, s: s0 + dd, e: e0 + dd };
      else if (mode === 'start') latest = { mode, s: Math.min(s0 + dd, e0), e: e0 };
      else latest = { mode, s: s0, e: Math.max(e0 + dd, s0) };
      setLive(latest);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('cursor-grabbing', 'cursor-ew');
      setLive(null);
      if (axis === 'y') { onDrop(); return; }
      if (!moved) { if (multi) onToggleSelect(task.id); else onOpen(task); }
      else if (latest.s !== s0 || latest.e !== e0) {
        onUpdate(task.id, { date: addDays(week, latest.s), end: latest.e === latest.s ? undefined : addDays(week, latest.e) });
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Vertical drag anywhere on the row's list cell reorders it within its day; a still click opens the task.
  const onRowDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.status-btn, .status-menu, .inline-name')) return;
    e.preventDefault();
    const startY = e.clientY;
    const rowH = rowRef.current?.offsetHeight ?? 36;
    const multi = e.metaKey || e.shiftKey || e.ctrlKey;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      if (Math.abs(dy) > 4) moved = true;
      if (moved && !readonly && !reviewRow) onLift(dy, rowH);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) { if (multi) onToggleSelect(task.id); else onOpen(task); }
      else onDrop();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onBlockHover = (e: React.PointerEvent) => {
    if (readonly || reviewRow) return;
    const bar = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const local = e.clientX - bar.left;
    setHoverCursor(local < EDGE || bar.width - local < EDGE ? 'ew-resize' : 'grab');
  };

  const s = live ? live.s : s0;
  const en = live ? live.e : e0;
  const vs = Math.max(0, s), ve = Math.min(6, en);
  const creator = !reviewRow && task.createdBy && task.createdBy !== task.personId ? people.find((p) => p.id === task.createdBy) : undefined;
  const reviewer = !reviewRow && task.status === 'review' && task.reviewerId ? people.find((p) => p.id === task.reviewerId) : undefined;
  const reviewOwner = reviewRow ? people.find((p) => p.id === task.personId) : undefined;
  // A review I've signed off on reads as Completed in my week, whatever the task itself says.
  const displayStatus = reviewRow && task.reviewDone ? 'done' as const : task.status;
  return (
    <div
      ref={rowRef}
      className={`wk-row task ${displayStatus}${selected ? ' selected' : ''}${reviewRow ? ' from-other' : ''}${lifting ? ' lifting' : ''}${offset && !lifting ? ' shifted' : ''}${backlog ? ' backlog' : ''}`}
      style={offset ? { transform: `translateY(${offset}px)` } : undefined}
      onContextMenu={(e) => { if (readonly || (reviewRow && task.reviewDone)) return; e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY }); }}
    >
      <div className="wk-list" onPointerDown={onRowDown} style={{ cursor: readonly ? 'default' : 'grab' }}>
        <button className="status-btn" title={reviewRow && task.reviewDone ? 'Review completed' : STATUS_LABEL[displayStatus]}
          onClick={(e) => {
            if (readonly || (reviewRow && task.reviewDone)) return;
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setMenu((m) => (m ? null : r));
          }}
          style={{ cursor: readonly || (reviewRow && task.reviewDone) ? 'default' : 'pointer' }}>
          <StatusDot status={displayStatus} />
        </button>
        {editing
          ? <InlineName initial={task.title} placeholder="Task name…" onDone={(t, viaEnter) => onRename(task.id, t, viaEnter)} />
          : <button className="task-title" onDoubleClick={() => { if (!readonly && !reviewRow) onEdit?.(task.id); }}>{renderInlineMd(task.title)}</button>}
        {onMoveToNow && !editing && (
          <button className="move-now" title="Move to the top of the backlog so it can be planned into this week"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onMoveToNow(); }}>Move to this week</button>
        )}
        {creator && (
          <span className="from-chip" title={`Added by ${creator.name}`}>
            <Avatar person={creator} size={14} /> {creator.id === me ? 'you' : shortName(creator.name).split(' ')[0]}
          </span>
        )}
        {reviewer && (
          <span className="from-chip review" title={`Review requested from ${reviewer.name}`}>
            <Avatar person={reviewer} size={14} />
          </span>
        )}
        {reviewOwner && (
          <span className="from-chip review named" title={`${reviewOwner.name} asked for a review`}>
            <Avatar person={reviewOwner} size={14} /> {shortName(reviewOwner.name).split(' ')[0]}
          </span>
        )}
        {team && (
          <span className="team-chip" title={`From ${team.name}`}>
            {team.icon ? <img src={team.icon} alt="" /> : team.name.slice(0, 1).toUpperCase()}
          </span>
        )}
        {menu && (reviewRow ? (
          <ReviewMenu
            anchor={menu}
            onComplete={() => {
              setMenu(null);
              confettiBurst(menu.left + menu.width / 2, menu.top + menu.height / 2);
              onCompleteReview?.(task.id);
            }}
            onDeny={() => { setMenu(null); onDeny?.(task.id); }}
          />
        ) : (
          <StatusMenu
            value={task.status}
            reviewerId={task.reviewerId}
            people={people.filter((x) => x.id !== task.personId)}
            onPick={(status, reviewerId) => { onUpdate(task.id, reviewerId !== undefined ? { status, reviewerId } : { status }); setMenu(null); }}
            onDelete={() => { setMenu(null); onDelete(task.id); }}
            anchor={menu}
          />
        ))}
      </div>
      <div
        className={`wk-days${backlog && !readonly && !reviewRow ? ' ghost-zone' : ''}`}
        ref={daysRef}
        onPointerMove={backlog && !readonly && !reviewRow ? (e) => { const r = e.currentTarget.getBoundingClientRect(); setScheduleGhost(Math.min(6, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * 7)))); } : undefined}
        onPointerLeave={backlog ? () => setScheduleGhost(null) : undefined}
        onClick={backlog && !readonly && !reviewRow ? (e) => { const r = e.currentTarget.getBoundingClientRect(); const i = Math.min(6, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * 7))); onUpdate(task.id, { date: addDays(week, i) }); setScheduleGhost(null); } : undefined}
      >
        {backlog && scheduleGhost !== null && (
          <div className="wk-block ghost" style={{ left: `${(scheduleGhost / 7) * 100}%`, width: `calc(100% / 7 - 6px)` }} />
        )}
        {ctx && createPortal(
          <div className="status-menu ctx-menu" style={{ position: 'fixed', left: Math.min(ctx.x, window.innerWidth - 180), top: Math.min(ctx.y, window.innerHeight - 52) }} onPointerDown={(e) => e.stopPropagation()}>
            {reviewRow
              ? (onDeny && <button className="danger" onClick={() => { setCtx(null); onDeny(task.id); }}>Deny</button>)
              : (
                <>
                  {onDuplicate && !onDeleteSel && <button onClick={() => { setCtx(null); onDuplicate(task.id); }}>Duplicate</button>}
                  <button className="danger" onClick={() => { setCtx(null); if (onDeleteSel) onDeleteSel(); else onDelete(task.id); }}>
                    {onDeleteSel ? `Delete ${selCount} items` : 'Delete'}
                  </button>
                </>
              )}
          </div>,
          document.body,
        )}
        {!backlog && ve >= vs && (
          <div
            className={`wk-block${live ? ' live' : ''}${s < 0 ? ' cut-l' : ''}${en > 6 ? ' cut-r' : ''}`}
            style={{
              left: `${(vs / 7) * 100}%`,
              width: `calc(${((ve - vs + 1) / 7) * 100}% - 6px)`,
              ['--sc' as string]: STATUS_COLOR[displayStatus],
              cursor: readonly || reviewRow ? 'pointer' : live ? (live.mode === 'move' ? 'grabbing' : 'ew-resize') : hoverCursor,
            }}
            onPointerDown={onBlockDown}
            onPointerMove={onBlockHover}
            onClick={readonly || reviewRow ? () => onOpen(task) : undefined}
            title={task.title}
          />
        )}
      </div>
    </div>
  );
}

/** The reviewer's verdict on a task sent to them: sign off or decline, nothing else. */
function ReviewMenu({ anchor, onComplete, onDeny }: { anchor: DOMRect; onComplete: () => void; onDeny: () => void }) {
  const menuH = 44 * 2 + 12;
  const up = anchor.bottom + menuH > window.innerHeight - 8;
  const style: React.CSSProperties = { position: 'fixed', left: Math.min(anchor.left, window.innerWidth - 200), ...(up ? { bottom: window.innerHeight - anchor.top + 6 } : { top: anchor.bottom + 6 }) };
  return createPortal(
    <div className="status-menu" style={style} onPointerDown={(e) => e.stopPropagation()}>
      <button onClick={onComplete}><StatusDot status="done" /> Completed</button>
      <button className="danger" onClick={onDeny}><span style={{ width: 14 }} /> Deny</button>
    </div>,
    document.body,
  );
}

/**
 * Status picker. Hovering "Needs review" slides out a list of people so a review can be requested
 * in the same gesture; clicking "Needs review" itself just sets the status.
 */
export function StatusMenu({ value, reviewerId, people, onPick, onDelete, onDeny, anchor }: {
  value: Status;
  reviewerId?: string;
  people: Person[];
  onPick: (status: Status, reviewerId?: string) => void;
  onDelete?: () => void;
  onDeny?: () => void; // review request aimed at me: decline instead of delete
  anchor: DOMRect; // the button that opened it; the menu renders in a portal so panels can't clip it
}) {
  const [sub, setSub] = useState(false);
  const menuH = 44 * 5 + (onDelete || onDeny ? 50 : 0) + 12;
  const up = anchor.bottom + menuH > window.innerHeight - 8;
  // In a very short window (the widget) even the flipped menu can't fit: pin it and scroll inside.
  const cramped = menuH > window.innerHeight - 16;
  const style: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(anchor.left, window.innerWidth - 420),
    maxHeight: window.innerHeight - 16,
    ...(cramped ? { top: 8, overflowY: 'auto' } : up ? { bottom: window.innerHeight - anchor.top + 6 } : { top: anchor.bottom + 6 }),
  };
  // Completing a task pops a little confetti from the status dot the menu was opened from.
  const pick = (s: Status, reviewerId?: string) => {
    if (s === 'done' && value !== 'done') confettiBurst(anchor.left + anchor.width / 2, anchor.top + anchor.height / 2);
    onPick(s, reviewerId);
  };
  return createPortal(
    <div className="status-menu" style={style} onPointerDown={(e) => e.stopPropagation()}>
      {STATUS_ORDER.map((s) => (
        <div key={s} className="status-item" onPointerEnter={() => setSub(s === 'review')}>
          <button className={s === value ? 'current' : ''} onClick={() => pick(s)}>
            <StatusDot status={s} /> {STATUS_LABEL[s]}
            {s === 'review' && <span className="chev">›</span>}
          </button>
          {s === 'review' && sub && (
            <div className="submenu">
              <div className="submenu-title">Request a review from</div>
              {people.map((x) => (
                <button key={x.id} className={x.id === reviewerId && value === 'review' ? 'current' : ''} onClick={() => onPick('review', x.id)}>
                  <Avatar person={x} size={18} /> {shortName(x.name)}
                </button>
              ))}
              {people.length === 0 && <div className="hint" style={{ padding: '6px 10px' }}>No one else to ask</div>}
            </div>
          )}
        </div>
      ))}
      {(onDelete || onDeny) && (
        <>
          <div className="sep" />
          <button className="danger" onClick={onDelete ?? onDeny}><span style={{ width: 14 }} /> {onDelete ? 'Delete' : 'Deny'}</button>
        </>
      )}
    </div>,
    document.body,
  );
}

/** An empty week shows one ready-to-type row so the list never looks blank; typing creates the task. */
function PlaceholderRow({ onAdd }: { onAdd: (title: string) => void }) {
  const [v, setV] = useState('');
  const commit = () => { const t = v.trim(); if (t) onAdd(t); setV(''); };
  return (
    <div className="wk-row task todo placeholder">
      <div className="wk-list">
        <span className="status-btn"><StatusDot status="todo" /></span>
        <input className="inline-name" placeholder="Task name…" value={v} onChange={(e) => setV(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setV(''); }} />
      </div>
      <div className="wk-days" />
    </div>
  );
}

/** Whose week is shown: me first, then teammates alphabetically. */
function PersonDropdown({ people, me, selected, onSelect }: { people: Person[]; me: string; selected: string; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.status-menu')) setOpen(null); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  const meP = people.find((p) => p.id === me);
  const rest = people.filter((p) => p.id !== me).sort((a, b) => a.name.localeCompare(b.name));
  const ordered = meP ? [meP, ...rest] : rest;
  const cur = people.find((p) => p.id === selected);
  if (people.length <= 1) return cur ? <span className="pill person active"><Avatar person={cur} /> Me</span> : null;
  return (
    <>
      <button className="pill person active" onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setOpen((o) => (o ? null : r)); }}>
        {cur && <Avatar person={cur} />}
        {selected === me ? 'Me' : shortName(cur?.name ?? '')}
        <ChevronIcon />
      </button>
      {open && createPortal(
        <div className="status-menu person-menu" style={{ position: 'fixed', top: open.bottom + 6, right: Math.max(8, window.innerWidth - open.right), minWidth: 200, maxHeight: Math.max(120, window.innerHeight - open.bottom - 14) }} onPointerDown={(e) => e.stopPropagation()}>
          {ordered.map((p) => (
            <button key={p.id} className={p.id === selected ? 'current' : ''} onClick={() => { onSelect(p.id); setOpen(null); }}>
              <Avatar person={p} size={18} /> {p.id === me ? 'Me' : shortName(p.name)}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

export function Avatar({ person, size = 20 }: { person: Person; size?: number }) {
  if (person.photo) {
    return <img className="avatar" src={person.photo} width={size} height={size} alt="" referrerPolicy="no-referrer" />;
  }
  return (
    <span className="avatar initials" style={{ width: size, height: size, background: person.color, fontSize: size * 0.5 }}>
      {person.name.trim()[0]?.toUpperCase()}
    </span>
  );
}

export function StatusDot({ status }: { status: Status }) {
  const c = STATUS_COLOR[status];
  const filled = status === 'done' || status === 'cancelled' || status === 'progress';
  return (
    <span className="status-ring" style={{ ['--c' as string]: c, ['--fill' as string]: filled ? c : 'transparent' }}>
      {status === 'done' && (
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1.5 5.5l2.5 2.5 4.5-5" />
        </svg>
      )}
      {status === 'cancelled' && (
        <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round">
          <path d="M2 2l6 6M8 2l-6 6" />
        </svg>
      )}
      {status === 'progress' && <span style={{ width: 4, height: 4, borderRadius: 2, background: '#fff' }} />}
      {status === 'review' && <span style={{ width: 6, height: 6, borderRadius: 3, background: c }} />}
    </span>
  );
}

function ChevronIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 2, opacity: 0.8 }}>
      <path d="M6 9.5l6 6 6-6" />
    </svg>
  );
}

function CalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="16" rx="4" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}
