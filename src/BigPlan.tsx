import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Deadline, Group, ISODate, Person, Project } from './types';
import { NO_GROUP_COLOR, crispColor } from './types';
import { dayIndex, dayOfMonth, formatShort, fromDayIndex, isoWeekNumber, monthShort, weekStart, weekdayShort } from './dates';
import { Avatar } from './WeekPlan';

const ROW_H = 32; // = the square dot grid: one dot row per lane boundary
const DEADLINE_ROW_H = 30;
const HEADER_H = 44; // month + day labels; tints and the band start below this
const RETRO_H = 30; // strip along the bottom that shows week labels / opens the retro
const GROUP_H = 32; // group label row above each section — one full lane, so the dot grid stays aligned
const GROUP_GAP = 0; // any gap would knock sections off the 19px dot grid
const MIN_PPD = 4;
const MAX_PPD = 90;
const EDGE = 10; // px from a bar's end that acts as a resize handle

interface Props {
  projects: Project[];
  groups: Group[];
  deadlines: Deadline[];
  people: Person[];
  locked: boolean; // read-only: open and navigate, but no creating or moving
  onAddGroup: () => void;
  today: ISODate;
  week: ISODate;
  selectedId?: string;
  selectedIds?: Set<string>; // multi-selection (shift/cmd-click)
  editingId?: string;
  onToggleSelect: (id: string) => void;
  onWeekChange: (monday: ISODate) => void;
  onOpenProject: (p: Project) => void;
  onOpenDeadline: (d: Deadline) => void;
  onMoveProject: (id: string, patch: Pick<Project, 'start' | 'end' | 'lane' | 'groupId'>) => void;
  onMoveMany: (ids: string[], deltaDays: number) => void; // shift a multi-selection in time
  onDeleteProject: (id: string) => void;
  onDeleteMany?: (ids: string[]) => void; // right-click Delete with a multi-selection
  onOpenGroup: (g: Group) => void;
  onReorderGroups: (ids: string[]) => void; // drag a group label vertically
  onDuplicateProject: (id: string) => void; // context menu Duplicate
  onCollapseGroup?: (projectIds: string[]) => void; // a collapsing group's bars leave the multi-selection
  onMoveDeadline: (id: string, date: ISODate) => void;
  onCreateProject: (start: ISODate, lane: number, groupId?: string, atTop?: boolean) => void; // atTop: from a group's label row — existing lanes shift down
  onRename: (id: string, name: string) => void;
  onStartRename: (id: string) => void; // double-click on a bar
  onOpenRetro: (monday: ISODate) => void;
  onCreateDeadline: (date: ISODate) => void;
  onRenameDeadline: (id: string, name: string) => void;
}

export function projectColor(p: Project, groups: Group[]) {
  return crispColor(groups.find((g) => g.id === p.groupId)?.color ?? NO_GROUP_COLOR);
}

type Drag = { id: string; mode: 'move' | 'start' | 'end'; start: number; end: number; lane: number; groupId?: string; moved: boolean; dd?: number; ids?: string[] };
type Section = { groupId?: string; name: string; color: string; headerTop: number; laneTop: number; lanes: number; collapsed: boolean };
type View = { ppd: number; origin: number };

const COLLAPSE_KEY = 'exponential-collapsed'; // collapsed group ids — a per-machine view preference, not plan data

/** Live preview of a group-label drag: `ins` = where among the other grouped sections the grabbed
 *  one would land, `shift` = how far each grouped section is displaced right now (px). The drop
 *  applies exactly what the preview shows, so sections never jump on release. */
function groupDragPreview(sections: Section[], gid: string, dy: number) {
  const gsecs = sections.filter((s) => s.groupId);
  const dragged = gsecs.find((s) => s.groupId === gid);
  const shift = new Map<string, number>();
  if (!dragged) return { ins: 0, shift };
  const hOf = (s: Section) => GROUP_H + s.lanes * ROW_H;
  const others = gsecs.filter((s) => s.groupId !== gid);
  const top0 = gsecs[0].headerTop;
  // the grabbed section can't leave the grouped region (the ungrouped section stays last)
  const cdy = Math.max(top0 - dragged.headerTop, Math.min(top0 + gsecs.reduce((s, x) => s + hOf(x), 0) - hOf(dragged) - dragged.headerTop, dy));
  // the label's TOP against the midpoint between its two candidate landing tops — symmetric
  // thresholds both directions, never 0px (a collapsed neighbour is only GROUP_H tall)
  const top = dragged.headerTop + cdy;
  let ins = 0, y = top0;
  others.forEach((o, k) => { if (top > y + hOf(o) / 2) ins = k + 1; y += hOf(o); });
  shift.set(gid, cdy);
  y = top0;
  others.forEach((o, k) => {
    if (k === ins) y += hOf(dragged); // the hole the grabbed section would drop into
    shift.set(o.groupId!, y - o.headerTop);
    y += hOf(o);
  });
  return { ins, shift };
}

export function BigPlan(props: Props) {
  const { projects, groups, deadlines, people, locked, onAddGroup, today, week, selectedId, selectedIds, editingId, onToggleSelect, onWeekChange, onOpenProject, onOpenDeadline, onMoveProject, onMoveMany, onDeleteProject, onDeleteMany, onMoveDeadline, onCreateProject, onRename, onStartRename, onOpenRetro, onCreateDeadline, onRenameDeadline, onOpenGroup, onReorderGroups, onCollapseGroup, onDuplicateProject } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const widthRef = useRef(0);
  const [view, setView] = useState<View>(() => ({ ppd: 22, origin: dayIndex(today) - 14 }));
  // phones open with TODAY centred — the desktop default (today ~308px in) is off-screen
  // at phone widths; measured after mount because the width isn't known before layout
  useEffect(() => {
    const w = ref.current?.clientWidth ?? 0;
    if (w > 0 && w < 700) setView((v) => ({ ...v, origin: dayIndex(today) - w / v.ppd / 2 }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const viewRef = useRef(view);
  viewRef.current = view;
  const { ppd, origin } = view;
  const [panning, setPanning] = useState(false);
  const [bandDrag, setBandDrag] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dlDrag, setDlDrag] = useState<{ id: string; date: number } | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; id: string } | null>(null); // right-click menu on a bar
  const [gDrag, setGDrag] = useState<{ id: string; dy: number } | null>(null); // group label being reordered
  const [hoverCursor, setHoverCursor] = useState<string>('');
  const [ghost, setGhost] = useState<{ day: number; lane: number; groupId?: string; hdr?: boolean } | null>(null);
  const [hoverWeek, setHoverWeek] = useState<number | null>(null); // day index of a Monday
  const [scrollY, setScrollY] = useState(0); // vertical offset of the lanes when they don't fit
  const scrollRef = useRef(0);
  scrollRef.current = scrollY;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try { return new Set<string>(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]')); } catch { return new Set<string>(); }
  });
  // A short window after toggling in which rows glide to their new spots and the
  // toggled group's bars fade out (still rendered) or in, instead of popping.
  const [fold, setFold] = useState<{ gid: string; on: boolean } | null>(null);
  const foldTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(foldTimer.current), []);
  const setCollapse = (gid: string, on: boolean) => {
    // commit any in-flight inline rename first — collapsing unmounts the group's bars,
    // and an input removed from the DOM never fires its blur (the typed name would be lost)
    if (on) (document.activeElement as HTMLElement | null)?.blur?.();
    const n = new Set(collapsed);
    if (on) n.add(gid); else n.delete(gid);
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...n]));
    setCollapsed(n);
    setFold({ gid, on });
    window.clearTimeout(foldTimer.current);
    foldTimer.current = window.setTimeout(() => setFold(null), 240);
    if (on) onCollapseGroup?.(projects.filter((p) => p.groupId === gid).map((p) => p.id));
  };
  // Vertical layout: one section per group (then ungrouped), each with its projects' lanes plus a spare lane.
  const sections: Section[] = (() => {
    const list: Section[] = [];
    const ordered = [...groups].sort((a, b) => a.sort - b.sort);
    const keys: (string | undefined)[] = [...ordered.map((g) => g.id), undefined];
    let y = HEADER_H + DEADLINE_ROW_H + 10;
    for (const gid of keys) {
      const inGroup = projects.filter((p) => (p.groupId ?? undefined) === gid || (gid === undefined && (!p.groupId || !groups.some((g) => g.id === p.groupId))));
      const g = ordered.find((x) => x.id === gid);
      // Unlocked, the ungrouped section's label doubles as the "Add group" button, so it must exist even with no groups.
      const showHeader = groups.length > 0 || !locked;
      const headerTop = y;
      if (showHeader) y += GROUP_H;
      // Compact: no spare lane (only the last, ungrouped section keeps one). Dropping a project onto a
      // group's label row appends it as a new row of that group, so the layout never jumps while dragging.
      const spare = gid === undefined ? 1 : 0;
      const shut = gid !== undefined && collapsed.has(gid);
      const lanes = shut ? 0 : Math.max(1, inGroup.reduce((m, p) => Math.max(m, p.lane + 1), 0) + spare);
      list.push({ groupId: gid, name: g?.name ?? 'No group', color: crispColor(g?.color ?? NO_GROUP_COLOR), headerTop, laneTop: y, lanes, collapsed: shut });
      y += lanes * ROW_H + GROUP_GAP;
    }
    return list;
  })();
  const sectionOf = (gid?: string) => sections.find((s) => s.groupId === gid) ?? sections[sections.length - 1];
  const laneCount = sections.reduce((m, s) => m + s.lanes, 0);
  // While a group label is being dragged, every grouped section (label + bars) rides its preview offset.
  const gPrev = gDrag ? groupDragPreview(sections, gDrag.id, gDrag.dy) : null;
  const gShift = (gid?: string) => (gPrev && gid ? gPrev.shift.get(gid) ?? 0 : 0);
  // The drop handler reads these mirrors, not its closure: a realtime edit landing mid-drag
  // re-flows the preview, and the drop must land in the hole the preview actually shows.
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const weekRef = useRef(week);
  weekRef.current = week;
  // The band eases between weeks by default; while the timeline itself moves (pan/zoom) it must
  // stay glued to the days, so `viewMoving` suppresses the transition until scrolling stops.
  const [viewMoving, setViewMoving] = useState(false);
  const movingTimer = useRef<number | undefined>(undefined);
  const touchView = () => {
    setViewMoving(true);
    window.clearTimeout(movingTimer.current);
    movingTimer.current = window.setTimeout(() => setViewMoving(false), 120);
  };
  const [height, setHeight] = useState(0);

  // The dot grid rides along when the plan pans, but zooming must not move it: panning
  // changes origin at fixed ppd (dots follow), while a ppd change folds into `comp` so
  // the grid's screen position stays exactly where it was.
  const dotRef = useRef({ prev: 0, prevPpd: 0, comp: 0 });
  {
    const cur = origin * ppd;
    if (dotRef.current.prevPpd !== ppd) dotRef.current.comp += cur - dotRef.current.prev;
    dotRef.current.prev = cur;
    dotRef.current.prevPpd = ppd;
  }
  const dotX = 9 - (origin * ppd - dotRef.current.comp);

  /* ── gesture engine: while the wheel (or an empty-space drag) is moving the plan, ONLY the
     composited layers' transforms are written — no React render per frame. The pending
     origin/scrollY commit to state when the gesture settles (or on pointer-up). ── */
  const panLayer = useRef<HTMLDivElement>(null);
  const panTopLayer = useRef<HTMLDivElement>(null);
  const ghostPanLayer = useRef<HTMLDivElement>(null);
  const barsPanLayer = useRef<HTMLDivElement>(null);
  const scrollLayer = useRef<HTMLDivElement>(null);
  const dotsLayer = useRef<HTMLDivElement>(null);
  const pendRef = useRef<{ origin: number; scrollY: number } | null>(null);
  const pinchRef = useRef(false); // two touch pointers down: zoom owns the gesture, drags stand down
  const dotXRef = useRef(dotX);
  dotXRef.current = dotX;
  const epochRef = useRef(Math.round(view.origin));
  const settleTimer = useRef<number | undefined>(undefined);
  const applyGesture = () => {
    const p = pendRef.current;
    if (!p) return;
    const v = viewRef.current;
    const px = (epochRef.current - p.origin) * v.ppd;
    const dxv = dotXRef.current + (v.origin - p.origin) * v.ppd;
    const mod = (n: number) => ((n % 32) + 32) % 32;
    if (panLayer.current) panLayer.current.style.transform = `translate3d(${px}px, 0, 0)`;
    if (panTopLayer.current) panTopLayer.current.style.transform = `translate3d(${px}px, 0, 0)`;
    if (ghostPanLayer.current) ghostPanLayer.current.style.transform = `translate3d(${px}px, 0, 0)`;
    if (barsPanLayer.current) barsPanLayer.current.style.transform = `translate3d(${px}px, 0, 0)`;
    if (scrollLayer.current) scrollLayer.current.style.transform = `translate3d(0, ${-p.scrollY}px, 0)`;
    if (dotsLayer.current) dotsLayer.current.style.transform = `translate3d(${mod(dxv)}px, ${mod(14 - p.scrollY)}px, 0)`;
    // Sticky content follows per-frame too: bar names pad against the viewport's left edge and
    // month labels clamp to it — React re-derives the exact same values on commit.
    if (barsPanLayer.current) for (const el of barsPanLayer.current.querySelectorAll<HTMLElement>('.tl-project[data-l]')) {
      const l = +el.dataset.l!;
      const pad = `${Math.max(12, Math.min(+el.dataset.w! - 12, 12 - (l + px)))}px`;
      if (el.style.paddingLeft !== pad) el.style.paddingLeft = pad;
    }
    if (panLayer.current) for (const el of panLayer.current.querySelectorAll<HTMLElement>('.tl-month[data-l]')) {
      const l = +el.dataset.l!;
      const left = `${Math.min(Math.max(l, -px), l + +el.dataset.w! - 70) + 18}px`;
      if (el.style.left !== left) el.style.left = left;
    }
  };
  const commitGesture = () => {
    window.clearTimeout(settleTimer.current);
    const p = pendRef.current;
    if (!p) return;
    pendRef.current = null;
    setScrollY(clampRef.current(p.scrollY));
    if (p.origin !== viewRef.current.origin) { viewRef.current = { ppd: viewRef.current.ppd, origin: p.origin }; setView(viewRef.current); }
  };
  const gesture = (originV: number, scrollYv: number) => {
    pendRef.current = { origin: originV, scrollY: scrollYv };
    applyGesture();
    window.clearTimeout(settleTimer.current);
    // outrun half the render buffer mid-fling → commit now so the chrome re-centres under you
    const v = viewRef.current;
    const buf = widthRef.current / v.ppd / 2;
    if (Math.abs(originV - v.origin) > buf) { commitGesture(); return; }
    settleTimer.current = window.setTimeout(commitGesture, 140);
  };

  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => { widthRef.current = el.clientWidth; setWidth(el.clientWidth); setHeight(el.clientHeight); });
    ro.observe(el);
    setWidth(el.clientWidth);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Wheel: pinch (ctrlKey) zooms so the day under the cursor stays put; otherwise scroll horizontally.
  useEffect(() => {
    const el = ref.current!;
    // Pan and vertical scroll never touch React mid-gesture (pure transform writes via
    // gesture()); zoom re-renders, coalesced to one setView per frame.
    let raf = 0;
    let pendingView: View | null = null; // NOT viewRef — that mirror is rewritten from state on every render
    const flush = () => {
      raf = 0;
      if (pendingView) { viewRef.current = pendingView; setView(pendingView); pendingView = null; }
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(flush); };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cur = pendRef.current ?? { origin: (pendingView ?? viewRef.current).origin, scrollY: scrollRef.current };
      if (!(e.ctrlKey || e.metaKey) && Math.abs(e.deltaX) <= Math.abs(e.deltaY)) {
        gesture(cur.origin, clampRef.current(cur.scrollY + e.deltaY));
        return;
      }
      touchView();
      if (e.ctrlKey || e.metaKey) {
        // zoom: fold any pending pan in, then go through React so every left/width refits
        const basePpd = (pendingView ?? viewRef.current).ppd;
        window.clearTimeout(settleTimer.current);
        if (pendRef.current) { setScrollY(clampRef.current(pendRef.current.scrollY)); pendRef.current = null; }
        const mx = e.clientX - el.getBoundingClientRect().left;
        const next = Math.min(MAX_PPD, Math.max(MIN_PPD, basePpd * Math.exp(-e.deltaY * 0.01)));
        const dayUnderCursor = cur.origin + mx / basePpd;
        pendingView = { ppd: next, origin: dayUnderCursor - mx / next };
        schedule();
      } else {
        gesture(cur.origin + e.deltaX / viewRef.current.ppd, cur.scrollY);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    // Touch pinch = exactly the ctrl+wheel zoom, anchored to the midpoint between the
    // fingers. While two fingers are down every drag handler stands down (pinchRef).
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;
    const onPtrDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        pinchRef.current = true;
      }
    };
    const onPtrMove = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || !pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size !== 2 || !pinchDist) return;
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist < 8) return;
      const factor = dist / pinchDist;
      pinchDist = dist;
      touchView();
      const basePpd = (pendingView ?? viewRef.current).ppd;
      window.clearTimeout(settleTimer.current);
      const cur = pendRef.current ?? { origin: (pendingView ?? viewRef.current).origin, scrollY: scrollRef.current };
      if (pendRef.current) { setScrollY(clampRef.current(pendRef.current.scrollY)); pendRef.current = null; }
      const mx = (a.x + b.x) / 2 - el.getBoundingClientRect().left;
      const next = Math.min(MAX_PPD, Math.max(MIN_PPD, basePpd * factor));
      const dayUnderMid = cur.origin + mx / basePpd;
      pendingView = { ppd: next, origin: dayUnderMid - mx / next };
      schedule();
    };
    const onPtrEnd = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId)) return;
      if (pointers.size < 2) pinchDist = 0;
      // clear AFTER the tap detectors' own pointerup handlers ran — the last finger of a
      // pinch must never read as a still tap on whatever it happened to land on
      if (pointers.size === 0) window.setTimeout(() => { pinchRef.current = false; }, 120);
    };
    el.addEventListener('pointerdown', onPtrDown);
    window.addEventListener('pointermove', onPtrMove);
    window.addEventListener('pointerup', onPtrEnd);
    window.addEventListener('pointercancel', onPtrEnd);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onPtrDown);
      window.removeEventListener('pointermove', onPtrMove);
      window.removeEventListener('pointerup', onPtrEnd);
      window.removeEventListener('pointercancel', onPtrEnd);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // All day-positioned chrome lives in transform-panned containers: children get STABLE
  // epoch-relative lefts (no per-frame layout/paint), only the containers' translate changes.
  const epoch = epochRef.current;
  // renders that happen MID-GESTURE (hover state etc.) must not stomp the imperative transforms
  const gOrigin = pendRef.current?.origin ?? origin;
  const gScroll = pendRef.current?.scrollY ?? scrollY;
  const panXg = (epoch - gOrigin) * ppd;
  const xe = (iso: ISODate) => (dayIndex(iso) - epoch) * ppd;
  const x = (iso: ISODate) => (dayIndex(iso) - origin) * ppd;

  const track = (move: (ev: PointerEvent) => void, up: (ev: PointerEvent) => void) => {
    const guarded = (ev: PointerEvent) => { if (pinchRef.current) return; move(ev); }; // a second finger means pinch-zoom, not a drag
    const onUp = (ev: PointerEvent) => {
      up(ev);
      window.removeEventListener('pointermove', guarded);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', guarded);
    window.addEventListener('pointerup', onUp);
  };

  const projectTop = HEADER_H + DEADLINE_ROW_H + 10; // the deadline row is always there (hover it to add one)
  const lastSec = sections[sections.length - 1];
  const contentH = lastSec.laneTop + lastSec.lanes * ROW_H + RETRO_H;
  const clampScroll = (y: number) => Math.max(0, Math.min(y, Math.max(0, contentH - height)));
  const clampRef = useRef(clampScroll);
  clampRef.current = clampScroll; // the wheel listener is bound once; it must see the current sizes
  useEffect(() => { setScrollY((y) => clampScroll(y)); }, [height, laneCount]); // eslint-disable-line react-hooks/exhaustive-deps
  const inDeadlineRow = (clientY: number) => { const y = clientY - ref.current!.getBoundingClientRect().top; return y >= HEADER_H && y < HEADER_H + DEADLINE_ROW_H; };
  const inRetroStrip = (clientY: number) => clientY - ref.current!.getBoundingClientRect().top > height - RETRO_H;

  /** Day under the cursor, plus the section/lane if the cursor is inside a section's lanes (lane -2 = nowhere). */
  const slotAt = (clientX: number, clientY: number) => {
    const rect = ref.current!.getBoundingClientRect();
    const day = Math.floor(origin + (clientX - rect.left) / ppd);
    const yc = clientY - rect.top + scrollY;
    for (const sec of sections) {
      if (yc >= sec.laneTop && yc < sec.laneTop + sec.lanes * ROW_H) return { day, lane: Math.floor((yc - sec.laneTop) / ROW_H), groupId: sec.groupId };
      if (!sec.collapsed && (groups.length > 0 || !locked) && yc >= sec.headerTop && yc < sec.laneTop) {
        // label row: a bar DROP appends to this group (lane/groupId); hover/create instead
        // extend the group ABOVE — the new bar lands on this very line (prevAppend).
        const above = sections[sections.indexOf(sec) - 1];
        const prevAppend = above && !above.collapsed ? { groupId: above.groupId, lane: above.lanes } : null;
        return { day, lane: sec.lanes, groupId: sec.groupId, header: true, prevAppend };
      }
    }
    return { day, lane: -2, groupId: undefined as string | undefined, header: false, prevAppend: null as { groupId?: string; lane: number } | null };
  };

  const isEmptyTarget = (t: EventTarget | null) => !(t as HTMLElement).closest('.week-band, .tl-project, .tl-deadline, .week-label, .tl-group');

  // The resize grip extends a little OUTSIDE each bar (grabbing right at the pill's edge used
  // to miss and create a new project instead). Returns the nearest bar edge within reach.
  const edgeHitAt = (x: number, y: number): { id: string; mode: 'start' | 'end' } | null => {
    let best: { id: string; mode: 'start' | 'end'; dist: number } | null = null;
    for (const el of ref.current?.querySelectorAll<HTMLElement>('.tl-project[data-pid]') ?? []) {
      const r = el.getBoundingClientRect();
      if (y < r.top || y > r.bottom) continue;
      if (x >= r.left - 8 && x < r.left) { const d = r.left - x; if (!best || d < best.dist) best = { id: el.dataset.pid!, mode: 'start', dist: d }; }
      if (x > r.right && x <= r.right + 8) { const d = x - r.right; if (!best || d < best.dist) best = { id: el.dataset.pid!, mode: 'end', dist: d }; }
    }
    return best && { id: best.id, mode: best.mode };
  };
  const [edgeHover, setEdgeHover] = useState(false);

  // Empty space: a still click creates a week-long project at the ghost; a drag pans.
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !isEmptyTarget(e.target)) return;
    if (!locked) {
      const hit = edgeHitAt(e.clientX, e.clientY);
      const p = hit && projects.find((x) => x.id === hit.id);
      if (hit && p) { onProjectDown(e, p, hit.mode); return; }
    }
    e.preventDefault();
    const startX = e.clientX;
    const startOrigin = origin;
    let moved = false;
    setGhost(null);
    track(
      (ev) => {
        if (Math.abs(ev.clientX - startX) > 3) moved = true;
        if (moved) { touchView(); setPanning(true); gesture(startOrigin - (ev.clientX - startX) / ppd, pendRef.current?.scrollY ?? scrollRef.current); }
      },
      (ev) => {
        setPanning(false);
        commitGesture();
        if (locked || moved || inRetroStrip(ev.clientY)) return;
        const slot = slotAt(ev.clientX, ev.clientY);
        const { day } = slot;
        if (inDeadlineRow(ev.clientY)) onCreateDeadline(fromDayIndex(day));
        else if (slot.header && slot.prevAppend) onCreateProject(fromDayIndex(day), slot.prevAppend.lane, slot.prevAppend.groupId);
        else if (slot.lane >= 0) onCreateProject(fromDayIndex(day), slot.header ? 0 : slot.lane, slot.groupId, slot.header);
      },
    );
  };

  const onHover = (e: React.PointerEvent) => {
    if (drag || dlDrag || panning || bandDrag || gDrag) return;
    const { day, lane, groupId } = slotAt(e.clientX, e.clientY);
    setHoverWeek(dayIndex(weekStart(fromDayIndex(day))));
    if (locked || !isEmptyTarget(e.target) || inRetroStrip(e.clientY)) { setGhost(null); setEdgeHover(false); return; }
    const hit = edgeHitAt(e.clientX, e.clientY);
    setEdgeHover(!!hit);
    if (hit) { setGhost(null); return; } // no create-ghost while hovering a resize grip
    if (inDeadlineRow(e.clientY)) { setGhost({ day, lane: -1 }); return; } // lane -1 = deadline row
    const slot = slotAt(e.clientX, e.clientY);
    if (slot.header && slot.prevAppend) setGhost({ day, lane: slot.prevAppend.lane, groupId: slot.prevAppend.groupId });
    else setGhost(lane >= 0 ? { day, lane: slot.header ? 0 : lane, groupId, hdr: slot.header } : null);
  };

  const onBandDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startWeek = dayIndex(week);
    setBandDrag(true);
    // Snaps to the nearest week as the cursor moves; the .dragging class gives it a quick smooth slide.
    track((ev) => {
      const shift = Math.round((ev.clientX - startX) / ppd / 7) * 7;
      const next = fromDayIndex(startWeek + shift);
      if (next !== weekRef.current) onWeekChange(next);
    }, () => setBandDrag(false));
  };

  /** Locked: a still click opens (or modifier-toggles) the item; any drag does nothing. */
  const clickOnly = (e: React.PointerEvent, open: () => void, toggle: () => void) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const multi = e.metaKey || e.shiftKey || e.ctrlKey;
    let moved = false;
    track(
      (ev) => { if (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3) moved = true; },
      () => { if (!moved && !pinchRef.current) { if (multi) toggle(); else open(); } }, // releasing a pinch is not a tap
    );
  };

  const onProjectDown = (e: React.PointerEvent, p: Project, forcedMode?: 'start' | 'end') => {
    if (e.button !== 0 || (e.target as HTMLElement).tagName === 'INPUT') return;
    if (locked) { clickOnly(e, () => onOpenProject(p), () => onToggleSelect(p.id)); return; }
    e.stopPropagation();
    e.preventDefault();
    // Dragging a bar that's part of the multi-selection moves the whole selection in time.
    const groupSel = !forcedMode && selectedIds?.has(p.id) ? projects.filter((x) => selectedIds.has(x.id)).map((x) => x.id) : [];
    const asGroup = groupSel.length > 1;
    // forcedMode = grabbed just outside the pill (the widened resize grip); no bar rect there
    const bar = forcedMode ? null : (e.currentTarget as HTMLElement).getBoundingClientRect();
    const local = bar ? e.clientX - bar.left : 0;
    const mode: Drag['mode'] = forcedMode ?? (asGroup ? 'move' : local < EDGE ? 'start' : bar!.width - local < EDGE ? 'end' : 'move');
    const s0 = dayIndex(p.start), e0 = dayIndex(p.end), lane0 = p.lane;
    const startX = e.clientX, startY = e.clientY;
    const multi = e.metaKey || e.shiftKey || e.ctrlKey;
    document.body.classList.add(mode === 'move' ? 'cursor-grabbing' : 'cursor-ew'); // steady cursor between day snaps
    const d: Drag = { id: p.id, mode, start: s0, end: e0, lane: lane0, groupId: p.groupId, moved: false, dd: 0, ids: asGroup ? groupSel : undefined };
    setDrag(d);
    let latest = d;
    const grabOffset = startY - (ref.current!.getBoundingClientRect().top + sectionOf(p.groupId).laneTop + lane0 * ROW_H - scrollY); // where in the row the bar was grabbed
    track(
      (ev) => {
        const dd = Math.round((ev.clientX - startX) / ppd);
        const moved = latest.moved || Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3;
        if (asGroup) latest = { ...d, start: s0 + dd, end: e0 + dd, moved, dd };
        else if (mode === 'move') {
          const slot = slotAt(ev.clientX, ev.clientY - grabOffset + ROW_H / 2);
          const lane = slot.lane >= 0 ? slot.lane : latest.lane;
          const groupId = slot.lane >= 0 ? slot.groupId : latest.groupId;
          latest = { ...d, start: s0 + dd, end: e0 + dd, lane, groupId, moved, dd };
        }
        else if (mode === 'start') latest = { ...d, start: Math.min(s0 + dd, e0), moved };
        else latest = { ...d, end: Math.max(e0 + dd, s0), moved };
        setDrag(latest);
      },
      () => {
        document.body.classList.remove('cursor-grabbing', 'cursor-ew');
        setDrag(null);
        if (!latest.moved && !pinchRef.current) { if (multi) onToggleSelect(p.id); else onOpenProject(p); }
        else if (asGroup) { if (latest.dd) onMoveMany(groupSel, latest.dd); }
        else onMoveProject(p.id, { start: fromDayIndex(latest.start), end: fromDayIndex(latest.end), lane: latest.lane, groupId: latest.groupId });
      },
    );
  };

  const onDeadlineDown = (e: React.PointerEvent, d: Deadline) => {
    if (e.button !== 0 || (e.target as HTMLElement).tagName === 'INPUT') return;
    if (locked) { clickOnly(e, () => onOpenDeadline(d), () => onToggleSelect(d.id)); return; }
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const d0 = dayIndex(d.date);
    const multi = e.metaKey || e.shiftKey || e.ctrlKey;
    let latest = d0, moved = false;
    document.body.classList.add('cursor-grabbing');
    setDlDrag({ id: d.id, date: d0 });
    track(
      (ev) => {
        if (Math.abs(ev.clientX - startX) > 3) moved = true;
        latest = d0 + Math.round((ev.clientX - startX) / ppd);
        setDlDrag({ id: d.id, date: latest });
      },
      () => {
        document.body.classList.remove('cursor-grabbing');
        setDlDrag(null);
        if (!moved && !pinchRef.current) { if (multi) onToggleSelect(d.id); else onOpenDeadline(d); }
        else if (latest !== d0) onMoveDeadline(d.id, fromDayIndex(latest));
      },
    );
  };

  useEffect(() => {
    if (!ctx) return;
    const close = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.ctx-menu')) setCtx(null); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtx(null); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', key); };
  }, [ctx]);

  const onProjectHover = (e: React.PointerEvent) => {
    if (locked) { setHoverCursor('pointer'); return; }
    const bar = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const local = e.clientX - bar.left;
    setHoverCursor(local < EDGE || bar.width - local < EDGE ? 'ew-resize' : 'grab');
  };

  // One full viewport of buffer each side: imperative pans stay fully drawn; a fling past
  // half a buffer commits mid-gesture (one render) to re-centre it.
  const bufDays = Math.ceil(width / ppd);
  const firstDay = Math.floor(origin) - 1 - bufDays;
  const lastDay = Math.ceil(origin + width / ppd) + 1 + bufDays;
  const months: { iso: ISODate; left: number; w: number }[] = [];
  {
    let d = firstDay;
    while (d <= lastDay) {
      const iso = fromDayIndex(d);
      const [y, m] = iso.split('-').map(Number);
      const mStart = dayIndex(`${y}-${String(m).padStart(2, '0')}-01`);
      const nextM = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
      const mEnd = dayIndex(nextM);
      months.push({ iso, left: (mStart - epoch) * ppd, w: (mEnd - mStart) * ppd }); // epoch coords — rendered inside .tl-pan
      d = mEnd;
    }
  }
  const days: number[] = [];
  if (ppd >= 20) for (let d = firstDay; d <= lastDay; d++) days.push(d);
  // Every other week is tinted; parity is anchored to the calendar so zooming never swaps them.
  const weeks: number[] = [];
  for (let m = dayIndex(weekStart(fromDayIndex(firstDay))); m <= lastDay; m += 7) weeks.push(m);

  // Deadlines share one row: each label may only use the space up to the next star.
  const dlSorted = [...deadlines].sort((a, b) => a.date.localeCompare(b.date));
  // centred on the day, like the today line
  const dlLeft = (d: Deadline) => ((dlDrag?.id === d.id ? dlDrag.date : dayIndex(d.date)) - epoch) * ppd + ppd / 2; // inside .tl-pan

  const weekNum = isoWeekNumber(week);

  return (
    <div
      ref={ref}
      className={`timeline${panning ? ' panning' : ''}${drag || dlDrag ? ' dragging-item' : ''}`}
      style={{ cursor: edgeHover ? 'ew-resize' : undefined }}
      onPointerDown={onPointerDown}
      onPointerMove={onHover}
      onPointerLeave={() => { setGhost(null); setHoverWeek(null); }}
    >
      {/* dot grid on its own composited layer: panning/scrolling translates it (GPU), nothing repaints */}
      <div ref={dotsLayer} className="tl-dots" style={{ transform: `translate3d(${(((dotX + (origin - gOrigin) * ppd) % 32) + 32) % 32}px, ${(((14 - gScroll) % 32) + 32) % 32}px, 0)` }} />
      <div className="tl-dot-fade" />
      <div ref={panLayer} className="tl-pan" style={{ transform: `translate3d(${panXg}px, 0, 0)` }}>
      {weeks.map((m) => {
        const odd = Math.floor(m / 7) % 2 === 1;
        const hovered = hoverWeek === m;
        return (
          <div key={m}>
            {odd && <div className="tl-week-tint" style={{ left: (m - epoch) * ppd, width: ppd * 7 }} />}
          </div>
        );
      })}
      {months.map((m) => (
        <div key={m.iso} className="tl-month" data-l={m.left} data-w={m.w} style={{ left: Math.min(Math.max(m.left, -panXg), m.left + m.w - 70) + 18, opacity: m.w < 40 ? 0 : 1 }} /* clamp against the viewport's left edge in epoch coords (-panX); +18 (+8px CSS padding) = 26px; applyGesture re-clamps per frame via data-l/w */>
          {monthShort(m.iso)} {m.iso.slice(0, 4)}
        </div>
      ))}
      {days.map((d) => {
        const iso = fromDayIndex(d);
        const wk = (d + 3) % 7 >= 5;
        return (
          <div key={d} className={`tl-day${wk ? ' weekend' : ''}`} style={{ left: (d - epoch) * ppd, width: ppd }}>
            {ppd >= 40 ? `${weekdayShort(iso)[0]} ${dayOfMonth(iso)}` : dayOfMonth(iso)}
          </div>
        );
      })}

      <div
        className={`week-band${bandDrag ? ' dragging' : viewMoving || panning ? ' no-anim' : ''}`}
        style={{ left: xe(week), width: ppd * 7 }}
        onPointerDown={onBandDown}
        title="Drag to choose the week shown below"
      >

      </div>

      {ghost && !drag && ghost.lane === -1 && (
        <div className="tl-deadline ghost" style={{ left: (ghost.day - epoch) * ppd + ppd / 2, top: HEADER_H }}>
          <span className="dot" /><span className="label">New deadline</span>
        </div>
      )}

      {dlSorted.map((d, i) => {
        const live = dlDrag?.id === d.id ? dlDrag.date : dayIndex(d.date);
        const left = dlLeft(d);
        const next = dlSorted[i + 1];
        const room = next ? dlLeft(next) - left - 26 : Infinity;
        return (
          <div
            key={d.id}
            className={`tl-deadline${selectedId === d.id || selectedIds?.has(d.id) ? ' selected' : ''}${dlDrag?.id === d.id ? ' live' : ''}`}
            style={{ left, top: HEADER_H, maxWidth: Number.isFinite(room) ? Math.max(22, room + 22) : undefined }}
            onPointerDown={(e) => onDeadlineDown(e, d)}
            title={`${d.name} · ${formatShort(d.date)}`}
          >
            <span className="dot" />
            {editingId === d.id
              ? <InlineName initial="" placeholder="Deadline…" onDone={(name) => onRenameDeadline(d.id, name)} />
              : room > 28 && (
                <span className="label">{d.name}{dlDrag?.id === d.id && <span className="tl-project-dates"> · {formatShort(fromDayIndex(live))}</span>}</span>
              )}
          </div>
        );
      })}

      </div>{/* .tl-pan */}

      <div className={`tl-lanes${fold ? ' glide' : ''}`} style={{ top: projectTop - 6 }}>
      <div ref={scrollLayer} className="tl-scrollv" style={{ transform: `translate3d(0, ${-gScroll}px, 0)` }}>
      <div ref={ghostPanLayer} className="tl-panh" style={{ transform: `translate3d(${panXg}px, 0, 0)` }}>
      {ghost && !drag && !gDrag && ghost.lane >= 0 && (
        <div className="tl-project ghost" style={{ left: (ghost.day - epoch) * ppd, width: ppd * 7, top: (ghost.hdr ? sectionOf(ghost.groupId).headerTop : sectionOf(ghost.groupId).laneTop + ghost.lane * ROW_H) - projectTop + 3 }}>
          New project
        </div>
      )}
      </div>{/* ghost panh */}
      {sections.map((sec) => (groups.length > 0 || !locked) && (
        <button key={sec.groupId ?? 'none'} className={`tl-group${sec.groupId ? '' : ' none'}${!sec.groupId && !locked ? ' add' : ''}${gDrag && gDrag.id === sec.groupId ? ' dragging' : gDrag && sec.groupId ? ' gshift' : ''}`}
          style={{ top: sec.headerTop - projectTop + 6, ...(gDrag && sec.groupId ? { transform: `translateY(${gShift(sec.groupId)}px)`, zIndex: gDrag.id === sec.groupId ? 40 : undefined } : null) }}
          onPointerDown={(e) => {
            e.stopPropagation();
            const g = groups.find((x) => x.id === sec.groupId);
            // A still press opens the group; pulling vertically reorders the sections.
            if (!g || locked || e.button !== 0) return;
            e.preventDefault();
            const startY = e.clientY;
            let moved = false;
            const move = (ev: PointerEvent) => {
              if (!moved && Math.abs(ev.clientY - startY) > 4) { moved = true; document.body.classList.add('cursor-grabbing'); }
              if (moved) setGDrag({ id: g.id, dy: ev.clientY - startY });
            };
            const up = (ev: PointerEvent) => {
              window.removeEventListener('pointermove', move);
              window.removeEventListener('pointerup', up);
              document.body.classList.remove('cursor-grabbing');
              setGDrag(null);
              if (!moved && !pinchRef.current) { onOpenGroup(g); return; }
              // the drop lands exactly where the preview showed
              const ordered = [...groupsRef.current].sort((a, b) => a.sort - b.sort).map((x) => x.id).filter((id) => id !== g.id);
              ordered.splice(groupDragPreview(sectionsRef.current, g.id, ev.clientY - startY).ins, 0, g.id);
              onReorderGroups(ordered);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
          }}
          data-gid={sec.groupId ?? ''}
          onClick={() => { if (!sec.groupId && !locked) onAddGroup(); else if (locked) { const g = groups.find((x) => x.id === sec.groupId); if (g) onOpenGroup(g); } }}>
          {sec.groupId || locked
            ? <>
                {sec.groupId ? (
                  <span className={`twist${sec.collapsed ? ' closed' : ''}`} style={{ ['--gc' as string]: sec.color }}
                    onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
                    onClick={(e) => { e.stopPropagation(); setCollapse(sec.groupId!, !sec.collapsed); }}>
                    <span className="dot" />
                    <svg className="chev" width="9" height="9" viewBox="0 0 10 10"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </span>
                ) : <span className="dot" style={{ background: sec.color }} />} {sec.name}
              </>
            : <>+ Add group</>}
        </button>
      ))}
      <div ref={barsPanLayer} className="tl-panh" style={{ transform: `translate3d(${panXg}px, 0, 0)` }}>
      {[...projects].sort((a, b) => a.start.localeCompare(b.start) || b.end.localeCompare(a.end)).map((p) => {
        const live = drag?.id === p.id ? drag : null;
        // Bars in the dragged multi-selection follow the grabbed one in time.
        const follow = !live && drag?.ids?.includes(p.id) ? drag.dd ?? 0 : 0;
        const s = live ? live.start : dayIndex(p.start) + follow;
        const en = live ? live.end : dayIndex(p.end) + follow;
        const lane = live ? live.lane : p.lane;
        const sec = sectionOf(live ? live.groupId : p.groupId);
        // tucked away with its group — except while collapsing, when the bars stay to fade out
        if (sec.collapsed && !(fold?.on && fold.gid === sec.groupId)) return null;
        // 2px shaved off each end: bars that meet on a date keep a slight gap
        const left = (s - epoch) * ppd + 2; // inside .tl-panh; viewport-relative = left + panX
        const w = Math.max(ppd - 4, (en - s + 1) * ppd - 4);
        const color = projectColor(p, groups);
        const editing = editingId === p.id;
        return (
          <div
            key={p.id}
            data-pid={p.id}
            data-l={left}
            data-w={w}
            className={`tl-project${selectedId === p.id || selectedIds?.has(p.id) ? ' selected' : ''}${live || follow ? ' live' : ''}${!p.groupId || !groups.some((g) => g.id === p.groupId) ? ' nogroup' : ''}${gDrag && sec.groupId && gDrag.id !== sec.groupId ? ' gshift' : ''}${fold && fold.gid === sec.groupId ? (fold.on ? ' fold-out' : ' fold-in') : ''}`}
            style={{
              left,
              width: w,
              top: sec.laneTop - projectTop + 3 + lane * ROW_H,
              transform: gDrag && sec.groupId ? `translateY(${gShift(sec.groupId)}px)` : undefined,
              zIndex: gDrag && gDrag.id === sec.groupId ? 40 : selectedId === p.id || selectedIds?.has(p.id) ? 3 : undefined,
              ['--pc' as string]: color,
              paddingLeft: Math.max(12, Math.min(w - 12, 12 - (left + panXg))),
              cursor: locked ? 'pointer' : live ? (live.mode === 'move' ? 'grabbing' : 'ew-resize') : hoverCursor || 'grab',
            }}
            onPointerDown={(e) => onProjectDown(e, p)}
            onPointerMove={onProjectHover}
            onDoubleClick={(e) => { if (!locked) { e.stopPropagation(); onStartRename(p.id); } }}
            onContextMenu={(e) => { if (locked) return; e.preventDefault(); e.stopPropagation(); setCtx({ x: e.clientX, y: e.clientY, id: p.id }); }}
            title={`${p.name} · ${formatShort(p.start)} – ${formatShort(p.end)}`}
          >
            {editing ? <InlineName initial={p.name} onDone={(name) => onRename(p.id, name)} /> : <span className="tl-project-name">{p.name}</span>}
            {!!p.assignees?.length && !editing && (
              <span className="bar-avatars">
                {p.assignees.map((id) => people.find((x) => x.id === id)).filter(Boolean).map((x) => <Avatar key={x!.id} person={x!} size={18} />)}
              </span>
            )}
            {live && (
              <span className="tl-project-dates">
                {formatShort(fromDayIndex(s))} – {formatShort(fromDayIndex(en))}
              </span>
            )}
          </div>
        );
      })}
      </div>{/* .tl-panh (bars) */}
      </div>{/* .tl-scrollv */}
      </div>

      <div ref={panTopLayer} className="tl-pan tl-pan-top" style={{ transform: `translate3d(${panXg}px, 0, 0)` }}>
        <div className="today-line" style={{ left: xe(today) + ppd / 2 }} />
        {/* week labels live up here: the pan layers are stacking contexts, so a z-index down
            inside .tl-pan could never climb above .tl-lanes the way the old global z:6 did */}
        {ppd * 7 >= 70 && (
          <div className="wlab-slot" style={{ left: xe(week), width: ppd * 7 }}>
            <button
            className="week-label current"
            title="Open this week's retro — drag to move the week"
            onPointerDown={(e) => {
              // A still press opens the retro; pulling sideways drags the week band along.
              e.stopPropagation();
              e.preventDefault();
              if (e.button !== 0) return;
              const startX = e.clientX;
              const startWeek = dayIndex(week);
              let moved = false;
              track(
                (ev) => {
                  if (Math.abs(ev.clientX - startX) > 3) { moved = true; setBandDrag(true); }
                  if (!moved) return;
                  const shift = Math.round((ev.clientX - startX) / ppd / 7) * 7;
                  const next = fromDayIndex(startWeek + shift);
                  if (next !== weekRef.current) onWeekChange(next);
                },
                () => { setBandDrag(false); if (!moved && !pinchRef.current) onOpenRetro(week); },
              );
            }}
          >
            Week {weekNum}
          </button>
          </div>
        )}
        {hoverWeek !== null && hoverWeek !== dayIndex(week) && ppd * 7 >= 70 && (
          <div className="wlab-slot" style={{ left: (hoverWeek - epoch) * ppd, width: ppd * 7 }}>
            <button
              className="week-label hover"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onOpenRetro(fromDayIndex(hoverWeek))}
              title="Open this week's retro"
            >
              Week {isoWeekNumber(fromDayIndex(hoverWeek))}
            </button>
          </div>
        )}
      </div>

      {ctx && createPortal(
        <div className="status-menu ctx-menu" style={{ position: 'fixed', left: Math.min(ctx.x, window.innerWidth - 180), top: Math.min(ctx.y, window.innerHeight - 52) }} onPointerDown={(e) => e.stopPropagation()}>
          {(() => {
            const many = !!selectedIds?.has(ctx.id) && selectedIds.size > 1 && !!onDeleteMany;
            return (
              <>
                {!many && <button onClick={() => { onDuplicateProject(ctx.id); setCtx(null); }}>Duplicate</button>}
                <button className="danger" onClick={() => { if (many) onDeleteMany!([...selectedIds!]); else onDeleteProject(ctx.id); setCtx(null); }}>
                  {many ? `Delete ${selectedIds!.size} items` : 'Delete'}
                </button>
              </>
            );
          })()}
        </div>,
        document.body,
      )}
    </div>
  );
}

/** Focused text field shown inside a freshly created bar/row; commits on Enter or blur. */
export function InlineName({ initial, onDone, placeholder = 'Name…' }: { initial: string; onDone: (name: string, viaEnter?: boolean) => void; placeholder?: string }) {
  const [v, setV] = useState(initial === 'New project' || initial === 'New task' ? '' : initial);
  const done = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  const finish = (viaEnter = false) => { if (done.current) return; done.current = true; onDone(v.trim(), viaEnter); };
  // Clicking away commits too: the drag surfaces preventDefault their pointerdowns, which
  // suppresses the browser's own focus change — blur alone never fires there.
  useEffect(() => {
    const down = (e: PointerEvent) => { if (e.target !== ref.current) ref.current?.blur(); };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, []);
  return (
    <input
      ref={ref}
      className="inline-name"
      autoFocus
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => finish(false)}
      onKeyDown={(e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') { setV(''); finish(false); } }}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}

export function Star({ size = 18 }: { size?: number }) {
  return (
    <svg className="star" width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6L2.5 9.4l6.6-.8z" />
    </svg>
  );
}
