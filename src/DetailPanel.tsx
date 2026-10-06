import { Fragment, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { confettiBurst } from './confetti';
import type { Deadline, Group, HealthMark, ISODate, Notification, Person, Project, Retro, RetroAnswers, RetroField, RetroTemplate, Status, Task } from './types';
import { DEFAULT_HEALTH_METRICS } from './types';
import { ConfidenceStepper } from './ConfidenceStepper';
import { htmlToMarkdown } from './store';
import { NO_GROUP_COLOR, STATUS_LABEL, crispColor, shortName } from './types';
import { Avatar, StatusDot, StatusMenu } from './WeekPlan';
import { BlockEditor } from './BlockEditor';
import { isoWeekNumber, todayISO, weekStart } from './dates';
import { dragRows } from './rowDrag';

export type Selection =
  | { kind: 'project'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'deadline'; id: string }
  | { kind: 'retro'; id: ISODate };

interface Props {
  selection: Selection;
  width: number;
  project?: Project;
  task?: Task;
  deadline?: Deadline;
  retro?: Retro;
  notifications: Notification[];
  people: Person[];
  me: string;
  onClose: () => void;
  onUpdateProject: (id: string, patch: Partial<Project>, coalesce?: string) => void;
  groups: Group[];
  onNewGroup: () => void;
  onToggleAssignee: (projectId: string, personId: string) => void;
  onUpdateTask: (id: string, patch: Partial<Task>, coalesce?: string) => void;
  onUpdateDeadline: (id: string, patch: Partial<Deadline>, coalesce?: string) => void;
  onUpdateRetro: (week: ISODate, patch: Partial<Retro>, coalesce?: string) => void;
  retroFields: RetroField[];
  retroTemplate?: RetroTemplate;
  prevRetro?: Retro;
  carriedConfidence?: Record<string, number>; // last set OKR scores from earlier weeks
  onOpen: (sel: Selection) => void;
  onMarkRead: (ids: string[]) => void;
  onDelete: () => void;
  tasks: Task[]; // all tasks of the team
  onCreateLinked: (link: { projectId?: string; parentId?: string }, title: string, coalesce?: string) => string;
  onDeleteTask: (id: string, coalesce?: string) => void;
  onClaimTask: (id: string, personId?: string) => void;
  onUnclaimTask: (id: string) => void;
}

export function DetailPanel(p: Props) {
  const { selection, project, task, deadline, retro, people, me, onClose, onDelete } = p;

  const style = { width: p.width };
  if (selection.kind === 'retro') return <RetroDoc week={selection.id} retro={retro} prevRetro={p.prevRetro} carriedConfidence={p.carriedConfidence} liveTemplate={p.retroTemplate} legacyFields={p.retroFields} people={people} me={me} onUpdate={p.onUpdateRetro} onClose={onClose} width={p.width} />;

  const item = project ?? task ?? deadline;
  if (!item) return null;

  const title = project ? project.name : task ? task.title : deadline!.name;
  const setTitle = (v: string) => {
    if (project) p.onUpdateProject(project.id, { name: v });
    else if (task) p.onUpdateTask(task.id, { title: v });
    else if (deadline) p.onUpdateDeadline(deadline.id, { name: v });
  };
  const setNotes = (html: string) => {
    const key = `notes:${item.id}`;
    if (project) p.onUpdateProject(project.id, { notes: html }, key);
    else if (task) p.onUpdateTask(task.id, { notes: html }, key);
    else if (deadline) p.onUpdateDeadline(deadline.id, { notes: html }, key);
  };

  const others = people.filter((x) => x.id !== me);
  const kind = project ? 'Project' : task ? 'Task' : 'Deadline';

  const agentDoc = () => {
    const who = (id?: string) => (id ? shortName(people.find((x) => x.id === id)?.name ?? '') : '');
    const lines = [`# ${title}`, '', `- Type: ${kind}`, `- Id: ${item.id} (the Exponential MCP get_item/update tools take this id)`];
    if (project) {
      lines.push(`- Starts: ${project.start}`, `- Ends: ${project.end}`);
      if (project.assignees?.length) lines.push(`- People: ${project.assignees.map(who).join(', ')}`);
    }
    if (task) {
      lines.push(`- Status: ${STATUS_LABEL[task.status]}`, `- Owner: ${who(task.personId)}`, `- Date: ${task.date ? `${task.date}${task.end ? ` → ${task.end}` : ''}` : 'backlog (no date yet)'}`);
      if (task.reviewerId) lines.push(`- Reviewer: ${who(task.reviewerId)}`);
    }
    if (deadline) lines.push(`- Date: ${deadline.date}`);
    if (item.notes?.trim()) {
      const live = item.notes.replace(/^- \[( |x)\] ?(.*?)\s*<!--task:([0-9a-f-]{36})-->\s*$/gim, (_m, _c, _t, id) => {
        const t = p.tasks.find((x) => x.id === id);
        return t ? `- [${t.status === 'done' ? 'x' : ' '}] ${t.title}${t.personId ? ` (${who(t.personId)}, ${STATUS_LABEL[t.status]})` : ' (unassigned)'}` : '';
      });
      lines.push('', '## Notes', '', live.trim());
    }
    return lines.join('\n');
  };

  return (
    <aside className="detail" style={style}>
      <div className="detail-top">
        <span className="detail-kind">{kind}</span>
        <span className="panel-spacer" />
        <button className="icon-btn" title="Close" onClick={onClose}><CloseIcon /></button>
      </div>
      <GBlur pos="top" />

      <div className="detail-scroll">
        <TitleInput key={item.id} value={title} onChange={setTitle} />

        <div className="props">
          {project && (
            <>
              <Prop label="Dates">
                <DateRange start={project.start} end={project.end}
                  onChange={(start, end) => p.onUpdateProject(project.id, { start, end })} />
              </Prop>
              <Prop label="People">
                <AssigneePicker people={people} me={me} assignees={project.assignees ?? []} onToggle={(id) => p.onToggleAssignee(project.id, id)} />
              </Prop>
              <Prop label="Group">
                <GroupPicker groups={p.groups} value={project.groupId} onChange={(gid) => p.onUpdateProject(project.id, { groupId: gid })} onNew={p.onNewGroup} />
              </Prop>
            </>
          )}
          {task && (
            <>
              <Prop label="Status">
                <StatusSelect
                  value={task.status}
                  reviewerId={task.reviewerId}
                  people={people.filter((x) => x.id !== task.personId)}
                  onPick={(status, reviewerId) => p.onUpdateTask(task.id, reviewerId !== undefined ? { status, reviewerId } : { status })}
                />
              </Prop>
              {task.status === 'review' && (
                <Prop label="Review by">
                  <PersonSelect people={others} value={task.reviewerId} placeholder="Choose a reviewer"
                    onChange={(id) => p.onUpdateTask(task.id, { reviewerId: id })} />
                </Prop>
              )}
              <Prop label="Owner">
                <PersonSelect people={people} value={task.personId} me={me}
                  onChange={(id) => id && p.onUpdateTask(task.id, { personId: id })} />
              </Prop>
              <Prop label="Dates">
                {task.date ? (
                  <>
                    <DateRange start={task.date} end={task.end ?? task.date}
                      onChange={(start, end) => p.onUpdateTask(task.id, { date: start, end: end === start ? undefined : end })}
                      clearTitle="Move to backlog"
                      onClear={() => p.onUpdateTask(task.id, { date: undefined, end: undefined })} />
                  </>
                ) : (
                  <label className="date-pill empty" title="Pick a date">
                    Backlog · set date
                    <input type="date" style={{ width: 0, opacity: 0 }} onChange={(e) => e.target.value && p.onUpdateTask(task.id, { date: e.target.value })} />
                  </label>
                )}
              </Prop>
              {task.createdBy && task.createdBy !== task.personId && (
                <Prop label="Added by"><span className="prop-text">{shortName(people.find((x) => x.id === task.createdBy)?.name ?? '')}</span></Prop>
              )}
            </>
          )}
          {deadline && (
            <Prop label="Date">
              <span className="date-pill">
                <input type="date" value={deadline.date} onChange={(e) => e.target.value && p.onUpdateDeadline(deadline.id, { date: e.target.value })} />
              </span>
            </Prop>
          )}
        </div>

        {deadline ? (
          <MarkdownEditor key={`ed-${item.id}`} value={item.notes ?? ''} onChange={setNotes} />
        ) : (
          <BlockEditor
            key={`blocks-${item.id}`}
            value={item.notes ?? ''}
            onChange={setNotes}
            tasks={p.tasks.filter((t) => (project ? t.projectId === project.id : t.parentId === task!.id))}
            people={people}
            me={me}
            claimable={!!project}
            createTask={(title, coalesce) => p.onCreateLinked(project ? { projectId: project.id } : { parentId: task!.id }, title, coalesce)}
            onUpdateTask={(id, patch, coalesce) => p.onUpdateTask(id, patch, coalesce)}
            onDeleteTask={p.onDeleteTask}
            undoKey={`notes:${item.id}`}
            onClaim={p.onClaimTask}
            onUnclaim={p.onUnclaimTask}
            onOpenTask={(id) => p.onOpen({ kind: 'task', id })}
          />
        )}
      </div>
      <div className="detail-delete-row">
        <button className="detail-delete" onClick={onDelete}>Delete {kind.toLowerCase()}</button>
      </div>
      <SendToAgent doc={agentDoc} />
    </aside>
  );
}

/** Progressive gradient blur toward the panel edge — 3 surfaces (::before, one div, ::after). */
function GBlur({ pos }: { pos: 'top' | 'bottom' }) {
  return (
    <div className={`gblur ${pos}`} aria-hidden>
      <div />
    </div>
  );
}

/* ─── Retro ─────────────────────────────────────────── */

function RetroDoc({ week, retro, prevRetro, carriedConfidence, liveTemplate, legacyFields, people, me, onUpdate, onClose, width }: {
  week: ISODate; retro?: Retro; prevRetro?: Retro; carriedConfidence?: Record<string, number>; liveTemplate?: RetroTemplate; legacyFields: RetroField[];
  people: Person[]; me: string; onUpdate: Props['onUpdateRetro']; onClose: () => void; width: number;
}) {
  // Past weeks read from their frozen template; the current week follows Team settings
  // (and re-freezes its snapshot with every edit). Locking freezes people too and
  // renders the whole page read-only from its snapshots.
  const a: RetroAnswers = retro?.answers ?? {};
  const locked = !!a.locked;
  const isPast = week < weekStart(todayISO());
  const current: RetroTemplate = { objective: '', keyResults: [], healthMetrics: DEFAULT_HEALTH_METRICS, ...liveTemplate };
  const tpl: RetroTemplate = (locked || isPast) && retro?.answers.template ? retro.answers.template : current;
  const ppl = locked && Array.isArray(a.people) && a.people.length ? (a.people as Person[]) : people;
  const save = (patch: RetroAnswers, key: string) => onUpdate(week, { answers: { ...patch, template: tpl } }, `retro:${week}:${key}`);

  const health = (a.health ?? {}) as NonNullable<RetroAnswers['health']>;
  const mine = health[me] ?? {};
  const cycleMark = (metric: string) => {
    const order: (HealthMark | undefined)[] = [undefined, 'g', 'y', 'r'];
    const next = order[(order.indexOf(mine[metric]) + 1) % order.length];
    save({ health: { ...health, [me]: { ...mine, [metric]: next as HealthMark } } }, 'health');
  };
  // this week's own scores win; untouched KRs start where earlier weeks left them
  const confidence = { ...(locked ? {} : carriedConfidence), ...(a.confidence ?? {}) } as Record<string, number>;
  const markColor: Record<HealthMark, string> = { g: '#34c759', y: '#ffcc00', r: '#ff3b30' };
  const markLabel: Record<HealthMark, string> = { g: 'Good', y: 'So-so', r: 'Rough' };
  const ordered = [...ppl.filter((p) => p.id === me), ...ppl.filter((p) => p.id !== me)];
  const lockedDate = a.lockedAt ? new Date(a.lockedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';

  const carried = (prevRetro?.answers.improvements as string | undefined)?.trim();
  const legacy = legacyFields.filter((f) => typeof a[f.key] === 'string' && (a[f.key] as string).trim());

  return (
    <aside className="detail" style={{ width }}>
      <div className="detail-top">
        <span className="detail-kind">Retro</span>
        <span className="panel-spacer" />
        <button className="icon-btn" title="Close" onClick={onClose}><CloseIcon /></button>
      </div>
      <GBlur pos="top" />
      <div className="detail-scroll">
        <h1 className="detail-title static">Week {isoWeekNumber(week)}</h1>

        {carried && (
          <div className="retro-carried">
            <div className="retro-sec-title">Last week we said we&rsquo;d improve</div>
            <div className="retro-carried-text">{carried}</div>
          </div>
        )}

        <div className="retro-sec">
          <div className="retro-sec-title">Priorities this week</div>
          <RetroList value={(a.priorities as string) ?? ''} withPriority placeholder="New priority" readOnly={locked} people={people}
            onChange={(v) => save({ priorities: v }, 'priorities')} />
        </div>

        <div className="retro-sec">
          <div className="retro-sec-title">OKR confidence</div>
          {tpl.objective ? <div className="retro-objective">{tpl.objective}</div>
            : <p className="hint" style={{ margin: '2px 0 6px' }}>Set the objective and key results in Team settings.</p>}
          {tpl.keyResults.map((kr) => (
            <div key={kr.key} className="kr-row">
              <div className="kr-name">{kr.name}</div>
              <ConfidenceStepper value={confidence[kr.key]} readOnly={locked}
                onChange={(v) => save({ confidence: { ...confidence, [kr.key]: v } }, 'confidence')} />
            </div>
          ))}
        </div>

        <div className="retro-sec">
          <div className="retro-sec-title">Health</div>
          <div className="health-table" style={{ gridTemplateColumns: `minmax(96px, 1.5fr) repeat(${ppl.length}, minmax(22px, 1fr))` }}>
            <span />
            {ordered.map((p) => (
              <span key={p.id} className={`health-head${p.id === me ? ' mine' : ''}`} title={p.name}>
                <Avatar person={p} size={20} />
              </span>
            ))}
            {tpl.healthMetrics.map((m) => (
              <Fragment key={m.key}>
                <span className="health-label">{m.label}</span>
                {ordered.map((p) => {
                  const mark = health[p.id]?.[m.key];
                  const mineCol = p.id === me && !locked;
                  return (
                    <button key={p.id} className={`health-cell${mineCol ? ' mine' : ''}`}
                      title={`${p.name} — ${mark ? markLabel[mark] : 'not answered'}${mineCol ? ' · click to change' : ''}`}
                      disabled={!mineCol}
                      onClick={() => mineCol && cycleMark(m.key)}>
                      <span className={`health-dot${mark ? ' on' : ''}`} style={mark ? { ['--hc' as string]: markColor[mark] } : undefined} />
                    </button>
                  );
                })}
              </Fragment>
            ))}
          </div>
        </div>

        <div className="retro-sec">
          <div className="retro-sec-title">Improvements for next week</div>
          <RetroList value={(a.improvements as string) ?? ''} placeholder="New improvement" readOnly={locked}
            onChange={(v) => save({ improvements: v }, 'improvements')} />
        </div>

        {legacy.length > 0 && (
          <div className="retro-sec">
            <div className="retro-sec-title">Earlier format</div>
            {legacy.map((f) => (
              <div key={f.key} style={{ marginBottom: 10 }}>
                <div className="retro-label">{f.label}</div>
                <p style={{ margin: '2px 0 0', whiteSpace: 'pre-wrap' }}>{a[f.key] as string}</p>
              </div>
            ))}
          </div>
        )}

        <button className={`retro-lock${locked ? ' on' : ''}`}
          title={locked ? 'Unlock to edit this retro again' : 'Freeze this page exactly as it is — later changes to OKRs or the team won’t touch it'}
          onClick={() => locked
            ? save({ locked: false }, 'lock')
            : save({ locked: true, lockedAt: new Date().toISOString(), people, confidence }, 'lock')}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="11" width="16" height="10" rx="2.5" />
            {locked
              ? <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              : <path d="M8 11V7a4 4 0 0 1 7.6-1.7" />}
          </svg>
          {locked ? `Locked${lockedDate ? ` ${lockedDate}` : ''} — click to unlock` : 'Lock this retro'}
        </button>
      </div>
    </aside>
  );
}

/*
 * List-style retro field. Stored as plain lines of text (so past retros,
 * carried improvements, and the MCP server keep working); priorities lines
 * carry a leading "P1 " / "P2 " / "P3 " tag rendered as a clickable chip.
 */
type ListItem = { text: string; p: 1 | 2 | 3; r?: 'y' | 'n'; who: string[] }; // p: priority level; r: reached / not reached; who: assignees
const P_COLORS: Record<1 | 2 | 3, string> = { 1: '#ff3b30', 2: '#ff9500', 3: '#8e8e93' };

/** Lines like "P2✓ Ship the thing @[uuid|uuid]" — level, outcome mark, text, assignees. */
const parseList = (v: string, withP: boolean): ListItem[] =>
  v.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    let who: string[] = [];
    l = l.replace(/ ?@\[([^\]]*)\]\s*$/, (_, ids: string) => { who = ids.split('|').filter(Boolean); return ''; });
    if (withP) {
      const m = /^P(\d+)([✓✗]?)[\s.:—-]*(.*)$/i.exec(l);
      if (m) return { text: m[3], p: Math.min(3, Math.max(1, Number(m[1]))) as 1 | 2 | 3, r: m[2] === '✓' ? 'y' as const : m[2] === '✗' ? 'n' as const : undefined, who };
    }
    return { text: l.replace(/^[-•]\s*/, ''), p: 1 as const, who };
  });
const serializeList = (items: ListItem[], withP: boolean) =>
  items.filter((i) => i.text.trim()).map((i) => {
    const who = i.who.length ? ` @[${i.who.join('|')}]` : '';
    return withP ? `P${i.p}${i.r === 'y' ? '✓' : i.r === 'n' ? '✗' : ''} ${i.text.trim()}${who}` : `${i.text.trim()}${who}`;
  }).join('\n');

function RetroList({ value, onChange, withPriority, placeholder, readOnly, people }: {
  value: string; onChange: (v: string) => void; withPriority?: boolean; placeholder: string; readOnly?: boolean; people?: Person[];
}) {
  const ro = !!readOnly;
  const withP = !!withPriority;
  const [items, setItems] = useState<ListItem[]>(() => parseList(value, withP));
  const lastSent = useRef(value);
  useEffect(() => {
    // external change (another member editing, or week switch) — resync
    if (value !== lastSent.current) { lastSent.current = value; setItems(parseList(value, withP)); }
  }, [value, withP]);

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const [dragging, setDragging] = useState<number | null>(null);
  const focusAt = useRef<number | null>(null);
  useEffect(() => {
    if (focusAt.current != null) {
      const el = inputs.current[focusAt.current];
      focusAt.current = null;
      el?.focus();
    }
  });

  const commit = (next: ListItem[]) => {
    setItems(next);
    itemsRef.current = next;
    const s = serializeList(next, withP);
    if (s !== lastSent.current) { lastSent.current = s; onChange(s); }
  };
  const insertAt = (i: number) => {
    const next = [...items];
    next.splice(i, 0, { text: '', p: items[i - 1]?.p ?? 1, who: [] });
    commit(next);
    focusAt.current = i;
  };
  const [whoMenu, setWhoMenu] = useState<{ i: number; rect: DOMRect } | null>(null);
  useEffect(() => {
    if (!whoMenu) return;
    const close = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.who-menu')) setWhoMenu(null); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [whoMenu]);
  const toggleWho = (i: number, id: string) =>
    commit(itemsRef.current.map((x, j) => (j === i ? { ...x, who: x.who.includes(id) ? x.who.filter((w) => w !== id) : [...x.who, id] } : x)));
  const removeAt = (i: number, refocus: boolean) => {
    commit(items.filter((_, j) => j !== i));
    if (refocus && i > 0) focusAt.current = i - 1;
  };
  // handle press: a tap taps (cycle the chip), a pull reorders
  const startDrag = (i: number, e: React.PointerEvent, tap?: () => void) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragRows(e, {
      index: i,
      rowAt: (j) => rows.current[j],
      count: () => itemsRef.current.length,
      onMove: (from, to) => {
        const next = [...itemsRef.current];
        const [it] = next.splice(from, 1);
        next.splice(to, 0, it);
        itemsRef.current = next;
        setItems(next);
      },
      onState: setDragging,
      onTap: tap,
      onDone: () => commit(itemsRef.current),
    });
  };

  return (
    <div className="rl">
      {items.map((it, i) => (
        <div key={i} ref={(el) => { rows.current[i] = el; }}
          className={`rl-row${dragging === i ? ' dragging' : ''}${withP && it.r === 'y' ? ' done' : ''}${withP && it.r === 'n' ? ' missed' : ''}`}>
          {withP ? (
            <>
              <span className="rl-num">{i + 1}</span>
              <button
                className={`rl-p${ro ? ' ro' : ''}`}
                style={{ ['--pc' as string]: P_COLORS[it.p] }}
                title={ro ? `P${it.p}` : `P${it.p} — click to change, drag to reorder`}
                onPointerDown={ro ? undefined : (e) => startDrag(i, e, () => commit(itemsRef.current.map((x, j) => (j === i ? { ...x, p: (x.p % 3) + 1 as 1 | 2 | 3 } : x))))}
              >P{it.p}</button>
            </>
          ) : (
            <button className={`rl-dot${ro ? ' ro' : ''}`} title={ro ? undefined : 'Drag to reorder'} onPointerDown={ro ? undefined : (e) => startDrag(i, e)} />
          )}
          <input
            ref={(el) => { inputs.current[i] = el; }}
            className="rl-text"
            value={it.text}
            placeholder={placeholder}
            readOnly={ro}
            onChange={(e) => !ro && commit(items.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
            onKeyDown={ro ? undefined : (e) => {
              if (e.key === 'Enter') { e.preventDefault(); insertAt(i + 1); }
              else if (e.key === 'Backspace' && it.text === '') { e.preventDefault(); removeAt(i, true); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); inputs.current[i - 1]?.focus(); }
              else if (e.key === 'ArrowDown') { e.preventDefault(); inputs.current[i + 1]?.focus(); }
            }}
            onBlur={ro ? undefined : (e) => {
              if (it.text.trim() === '' && !(e.relatedTarget instanceof Node && e.currentTarget.parentElement?.contains(e.relatedTarget))) removeAt(i, false);
            }}
          />
          <span className="rl-marks">
            {withP && ro && it.r && (
              <span className={`rl-mark ${it.r === 'y' ? 'yes' : 'no'} on`}>{it.r === 'y' ? '✓' : '✗'}</span>
            )}
            {withP && !ro && (
              <>
                <button className={`rl-mark yes${it.r === 'y' ? ' on' : ''}`} title="Reached"
                  onClick={(e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); // before setState — the event is recycled
                    const turningOn = it.r !== 'y';
                    commit(itemsRef.current.map((x, j) => (j === i ? { ...x, r: x.r === 'y' ? undefined : 'y' as const } : x)));
                    if (turningOn) confettiBurst(r.left + r.width / 2, r.top + r.height / 2);
                  }}>✓</button>
                <button className={`rl-mark no${it.r === 'n' ? ' on' : ''}`} title="Not reached"
                  onClick={() => commit(itemsRef.current.map((x, j) => (j === i ? { ...x, r: x.r === 'n' ? undefined : 'n' as const } : x)))}>✗</button>
              </>
            )}
          </span>
          {withP && (it.who.length > 0 || !ro) && (
            <span className="rl-who" onPointerDown={(e) => e.stopPropagation()}>
              {!ro && (
                <button className="rl-who-add" title="Assign people"
                  onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setWhoMenu((m) => (m?.i === i ? null : { i, rect: r })); }}>+</button>
              )}
              {it.who.map((id) => { const per = people?.find((x) => x.id === id); return per ? <Avatar key={id} person={per} size={16} /> : null; })}
            </span>
          )}
        </div>
      ))}
      {!ro && <button className="rl-add" onClick={() => insertAt(items.length)}>+ Add</button>}
      {whoMenu && createPortal(
        <div className="status-menu who-menu" style={{ position: 'fixed', left: Math.min(whoMenu.rect.left, window.innerWidth - 200), top: whoMenu.rect.bottom + 6 }} onPointerDown={(e) => e.stopPropagation()}>
          {(people ?? []).map((p) => (
            <button key={p.id} className={items[whoMenu.i]?.who.includes(p.id) ? 'current' : ''} onClick={() => toggleWho(whoMenu.i, p.id)}>
              <Avatar person={p} size={18} /> {shortName(p.name)}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

/* ─── Inbox ─────────────────────────────────────────── */

/** Notification rows only — lives at the bottom of the chat panel now. */
export function InboxList({ notifications, people, me, onOpen, onMarkRead }: {
  notifications: Notification[]; people: Person[]; me: string;
  onOpen: (sel: Selection | { kind: 'chat'; id: string }) => void; onMarkRead: (ids: string[]) => void;
}) {
  const mine = notifications.filter((n) => n.to === me).sort((a, b) => b.at.localeCompare(a.at));
  const unreadKey = mine.filter((n) => !n.read).map((n) => n.id).join(',');
  useEffect(() => {
    if (!unreadKey) return;
    const t = setTimeout(() => onMarkRead(unreadKey.split(',')), 1500);
    return () => clearTimeout(t);
  }, [unreadKey, onMarkRead]);
  return (
    <div className="notif-list">
      {mine.length === 0 && <p className="muted">Nothing yet. You’ll hear here when a task is added for you, a review is requested, or a project you’re on changes.</p>}
      {mine.map((n) => {
        const from = people.find((x) => x.id === n.from);
        return (
          <button key={n.id} className={`notif${n.read ? '' : ' unread'}`} onClick={() => onOpen({ kind: n.ref.kind, id: n.ref.id } as Selection | { kind: 'chat'; id: string })}>
            {from && <Avatar person={from} size={28} />}
            <span className="notif-body">
              <span className="notif-text">{n.text}</span>
              <span className="notif-time">{relTime(n.at)}</span>
            </span>
            {!n.read && <span className="notif-dot" />}
          </button>
        );
      })}
    </div>
  );
}

function relTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/* ─── Shared bits ───────────────────────────────────── */

/** One pill holding both ends of a range; moving the start past the end (or vice versa) drags the other along. */
function DateRange({ start, end, onChange, onClear, clearTitle }: {
  start: string; end: string; onChange: (start: string, end: string) => void; onClear?: () => void; clearTitle?: string;
}) {
  return (
    <span className="date-pill">
      <input type="date" value={start} onChange={(e) => { const v = e.target.value; if (v) onChange(v, v > end ? v : end); }} />
      <span className="dash">–</span>
      <input type="date" value={end} onChange={(e) => { const v = e.target.value; if (v) onChange(v < start ? v : start, v); }} />
      {onClear && <button className="chip-x" title={clearTitle} onClick={onClear}>×</button>}
    </span>
  );
}

function Prop({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="prop">
      <span className="prop-label">{label}</span>
      {children}
    </div>
  );
}

function TitleInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className="detail-title"
      value={v}
      placeholder="Untitled"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { const t = v.trim(); if (t && t !== value) onChange(t); else setV(value); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}

function useClickAway(open: boolean, cls: string, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest(cls)) close(); };
    window.addEventListener('pointerdown', h);
    return () => window.removeEventListener('pointerdown', h);
  }, [open, cls, close]);
}

function StatusSelect({ value, reviewerId, people, onPick }: {
  value: Status; reviewerId?: string; people: Person[]; onPick: (s: Status, reviewerId?: string) => void;
}) {
  const [open, setOpen] = useState<DOMRect | null>(null);
  useClickAway(!!open, '.status-select', () => setOpen(null));
  return (
    <div className="status-select">
      <button className="pill small" onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setOpen((o) => (o ? null : r)); }}><StatusDot status={value} /> {STATUS_LABEL[value]}</button>
      {open && <StatusMenu value={value} reviewerId={reviewerId} people={people} onPick={(s, r) => { onPick(s, r); setOpen(null); }} anchor={open} />}
    </div>
  );
}

/** Assigned people as chips, plus a "+" that opens a list of everyone not yet assigned. */
function AssigneePicker({ people, me, assignees, onToggle }: { people: Person[]; me: string; assignees: string[]; onToggle: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  useClickAway(open, '.assignee-picker', () => setOpen(false));
  const assigned = assignees.map((id) => people.find((x) => x.id === id)).filter(Boolean) as Person[];
  const rest = people.filter((x) => !assignees.includes(x.id));
  return (
    <div className="assignee-picker status-select">
      <div className="chips">
        {assigned.map((x) => (
          <span key={x.id} className="chip" title={x.name}>
            <Avatar person={x} size={18} />
            {x.id === me ? 'Me' : shortName(x.name)}
            <button className="chip-x" title="Remove" onClick={() => onToggle(x.id)}>×</button>
          </span>
        ))}
        <button className="chip add" title="Add person" onClick={() => setOpen((o) => !o)} disabled={rest.length === 0}>+</button>
      </div>
      {open && (
        <div className="status-menu" style={{ top: 34, left: 0 }}>
          {rest.map((x) => (
            <button key={x.id} onClick={() => { onToggle(x.id); if (rest.length <= 1) setOpen(false); }}>
              <Avatar person={x} size={18} /> {x.id === me ? 'Me' : shortName(x.name)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function GroupPicker({ groups, value, onChange, onNew }: { groups: Group[]; value?: string; onChange: (id: string | undefined) => void; onNew: () => void }) {
  const [open, setOpen] = useState(false);
  useClickAway(open, '.group-picker', () => setOpen(false));
  const cur = groups.find((g) => g.id === value);
  return (
    <div className="group-picker status-select">
      <button className="pill small" onClick={() => setOpen((o) => !o)}>
        <span className="dot" style={{ background: crispColor(cur?.color ?? NO_GROUP_COLOR) }} /> {cur?.name ?? 'No group'}
      </button>
      {open && (
        <div className="status-menu" style={{ top: 34, left: 0 }}>
          <button className={!cur ? 'current' : ''} onClick={() => { onChange(undefined); setOpen(false); }}><span className="dot" style={{ background: NO_GROUP_COLOR, width: 10, height: 10, borderRadius: 5 }} /> No group</button>
          {groups.map((g) => (
            <button key={g.id} className={g.id === value ? 'current' : ''} onClick={() => { onChange(g.id); setOpen(false); }}>
              <span className="dot" style={{ background: crispColor(g.color), width: 10, height: 10, borderRadius: 5 }} /> {g.name}
            </button>
          ))}
          <div className="sep" />
          <button onClick={() => { setOpen(false); onNew(); }}><span style={{ width: 10, textAlign: 'center' }}>+</span> New group…</button>
        </div>
      )}
    </div>
  );
}

function PersonSelect({ people, value, me, placeholder, onChange }: {
  people: Person[]; value?: string; me?: string; placeholder?: string; onChange: (id: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  useClickAway(open, '.person-select', () => setOpen(false));
  const cur = people.find((x) => x.id === value);
  return (
    <div className="person-select status-select">
      <button className={`pill small${cur ? '' : ' empty'}`} onClick={() => setOpen((o) => !o)}>
        {cur ? <><Avatar person={cur} size={16} /> {cur.id === me ? 'Me' : shortName(cur.name)}</> : placeholder ?? 'Choose…'}
      </button>
      {open && (
        <div className="status-menu" style={{ top: 34, left: 0 }}>
          {people.map((x) => (
            <button key={x.id} className={x.id === value ? 'current' : ''} onClick={() => { onChange(x.id); setOpen(false); }}>
              <Avatar person={x} size={18} /> {x.id === me ? 'Me' : shortName(x.name)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Notes are stored as Markdown. By default they're edited as rich text (a contenteditable that
 * renders the Markdown and converts edits back); a "Markdown" toggle shows the raw source.
 */
function MarkdownEditor({ value, onChange }: { value: string; onChange: (md: string) => void }) {
  const [source] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const lastEmitted = useRef(value);
  const pending = useRef<string | null>(null);
  const flush = () => {
    window.clearTimeout(timer.current);
    if (pending.current !== null) { onChange(pending.current); pending.current = null; }
  };
  const emit = (md: string) => {
    lastEmitted.current = md;
    pending.current = md;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 250);
  };
  useEffect(() => flush, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="editor">
      {source
        ? <SourceEditor value={pending.current ?? value} onEmit={emit} onToggle={() => {}} />
        : <RichEditor value={value} lastEmitted={lastEmitted} onEmit={emit} />}
    </div>
  );
}

function ToolbarButton({ label, title, onClick, active }: { label: string; title: string; onClick: () => void; active?: boolean }) {
  return <button className={active ? 'on' : ''} title={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{label}</button>;
}

function RichEditor({ value, lastEmitted, onEmit }: { value: string; lastEmitted: React.MutableRefObject<string>; onEmit: (md: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);

  // Only re-render the DOM when the value changed from outside (undo, another item), never for our own edits.
  useEffect(() => {
    if (ref.current && value !== lastEmitted.current) { ref.current.innerHTML = renderMarkdown(value, true); lastEmitted.current = value; }
  }, [value, lastEmitted]);
  useEffect(() => { if (ref.current) ref.current.innerHTML = renderMarkdown(value, true); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const sync = () => {
    const el = ref.current;
    if (!el) return;
    // checkbox state lives on the DOM property; mirror it to the attribute so it survives serialisation
    el.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((c) => (c.checked ? c.setAttribute('checked', '') : c.removeAttribute('checked')));
    onEmit(htmlToMarkdown(el.innerHTML));
  };
  const cmd = (name: string, arg?: string) => { ref.current?.focus(); document.execCommand(name, false, arg); sync(); };
  const insertImage = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => cmd('insertHTML', `<img src="${reader.result}"><p><br></p>`);
    reader.readAsDataURL(file);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'b') { e.preventDefault(); cmd('bold'); }
    if (k === 'i') { e.preventDefault(); cmd('italic'); }
  };

  return (
    <>
      <div className="toolbar">
        <ToolbarButton label="H1" title="Heading 1" onClick={() => cmd('formatBlock', 'h1')} />
        <ToolbarButton label="H2" title="Heading 2" onClick={() => cmd('formatBlock', 'h2')} />
        <ToolbarButton label="Text" title="Plain paragraph" onClick={() => cmd('formatBlock', 'p')} />
        <ToolbarButton label="Todo" title="To-do — teammates can add it to their week" onClick={() => cmd('insertHTML', '<ul><li><input type="checkbox"> </li></ul>')} />
      </div>
      <div
        ref={ref}
        className="rich-body"
        contentEditable
        suppressContentEditableWarning
        data-placeholder="Write something…"
        onInput={sync}
        onClick={(e) => { if ((e.target as HTMLElement).tagName === 'INPUT') setTimeout(sync, 0); }}
        onKeyDown={onKeyDown}
        onPaste={(e) => { const f = Array.from(e.clipboardData.files)[0]; if (f?.type.startsWith('image/')) { e.preventDefault(); insertImage(f); } }}
        onDrop={(e) => { const f = e.dataTransfer.files[0]; if (f?.type.startsWith('image/')) { e.preventDefault(); insertImage(f); } }}
      />
    </>
  );
}

function SourceEditor({ value, onEmit, onToggle }: { value: string; onEmit: (md: string) => void; onToggle: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0';
    el.style.height = `${Math.max(200, el.scrollHeight)}px`;
  }, [local]);
  const commit = (v: string) => { setLocal(v); onEmit(v); };
  return (
    <>
      <div className="toolbar">
        <span className="hint">Markdown source</span>
        <span className="panel-spacer" />
        <ToolbarButton label="Rich text" title="Back to rich text" onClick={onToggle} active />
      </div>
      <textarea ref={ref} className="md-source" value={local} placeholder="Write something…" onChange={(e) => commit(e.target.value)} spellCheck />
    </>
  );
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s: string) =>
  esc(s)
    .replace(/!\[([^\]]*)\]\((data:image\/[^)]+|https?:[^)]+)\)/g, '<img alt="$1" src="$2">')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

/** Small Markdown subset: headings, paragraphs, bullet/numbered lists, checkboxes, bold/italic/code, images. */
export function renderMarkdown(md: string, editable = false): string {
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const h = line.match(/^(#{1,3})\s+(.*)/);
    const li = line.match(/^\s*(?:([-*])|(\d+)\.)\s+(?:\[([ x])\]\s+)?(.*)/);
    if (h) { close(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); }
    else if (li) {
      const kind = li[2] ? 'ol' : 'ul';
      if (list !== kind) { close(); list = kind; out.push(`<${kind}>`); }
      const box = li[3] !== undefined ? `<input type="checkbox"${editable ? '' : ' disabled'}${li[3] === 'x' ? ' checked' : ''}> ` : '';
      out.push(`<li>${box}${inline(li[4])}</li>`);
    }
    else if (!line.trim()) close();
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return out.join('') || (editable ? '<p><br></p>' : '');
}

export function SendToAgent({ doc }: { doc: () => string }) {
  const [state, setState] = useState<'idle' | 'app' | 'app-paste' | 'web' | 'copied'>('idle');
  const send = async () => {
    const md = doc();
    // Desktop: open Claude with the prompt pre-filled (falls back to app+clipboard, then claude.ai).
    if (window.exponential?.sendToClaude) {
      const how = await window.exponential.sendToClaude(md);
      setState(how);
    } else {
      try { await navigator.clipboard.writeText(md); } catch { /* clipboard may be unavailable in the preview */ }
      setState('copied');
    }
    setTimeout(() => setState('idle'), 2600);
  };
  const label = {
    idle: 'Send to Claude',
    app: 'Opened in Claude',
    'app-paste': 'Opened Claude — ⌘V to paste',
    web: 'Opened claude.ai',
    copied: 'Copied as Markdown',
  }[state];
  return (
    <>
      <GBlur pos="bottom" />
      <div className="detail-foot">
        <button className="btn" onClick={send}>
          <SparkIcon /> {label}
        </button>
      </div>
    </>
  );
}

function SparkIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 5.7L19.5 9.5l-5.7 1.8L12 17l-1.8-5.7L4.5 9.5l5.7-1.8zM5 16l.9 2.6L8.5 19.5l-2.6.9L5 23l-.9-2.6L1.5 19.5l2.6-.9z" /></svg>;
}

function CloseIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>;
}
function TrashIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>;
}
