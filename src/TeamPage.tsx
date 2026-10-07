import { useEffect, useRef, useState } from 'react';
import { TeamMark } from './App';
import type { Data, Person } from './types';
import { DEFAULT_HEALTH_METRICS, PROJECT_COLORS, type RetroTemplate } from './types';
import { Avatar } from './WeekPlan';
import { uid } from './store';
import { isPending, pendingId } from './cloud';
import { dragRows } from './rowDrag';

interface Props {
  team: Data;
  cloud: boolean; // members are invited by Google email and join when they sign in
  canDelete: boolean;
  crmAuto: boolean; // the CRM's automatic state for this team (it has crm_people rows) — the default before anyone touches the switch
  onUpdate: (fn: (d: Data) => Data, coalesce?: string) => void;
  onDelete: () => void;
}

/** One click registers the bundled MCP server with Claude Desktop / Claude Code on this machine.
 *  The button reads the actual registration state, so it stays blue across restarts. */
function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-row">
      <span className="trash-kind" style={{ width: 68 }}>{label}</span>
      <code className="copy-code">{value}</code>
      <button className="pill small" onClick={() => { navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function ClaudeConnect() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; messages: string[] } | null>(null);
  const [targets, setTargets] = useState<string[]>([]);
  const [entry, setEntry] = useState<{ command: string; serverPath: string } | null>(null);
  const [showOther, setShowOther] = useState(false);
  const refresh = () => window.exponential?.claudeStatus?.().then((s) => { setTargets(s.targets); setEntry(s.entry); }).catch(() => {});
  useEffect(() => { refresh(); }, []);
  const connect = async () => {
    setBusy(true);
    try { setResult(await window.exponential!.connectClaude!()); }
    catch (e) { setResult({ ok: false, messages: [String((e as Error).message ?? e)] }); }
    finally { setBusy(false); refresh(); }
  };
  const connected = targets.length > 0;
  return (
    <div>
      <button
        className={`pill toggle${connected ? ' active' : ''}`}
        onClick={connect}
        disabled={busy}
        title={connected ? `Connected: ${targets.join(' · ')} — click to re-register` : 'Register Exponential with Claude on this computer'}
      >
        {connected && !busy && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" style={{ margin: '0 -2px' }}>
            <path d="M4.5 12.5l5 5L19.5 7" />
          </svg>
        )}
        {busy ? 'Connecting…' : connected ? 'Connected to Claude' : 'Connect to Claude'}
      </button>
      {entry && (
        <button className="pill ghost" style={{ marginLeft: 8 }} onClick={() => setShowOther((v) => !v)}>
          Connect another agent
        </button>
      )}
      {result?.messages.map((m, i) => <p key={i} className="hint" style={{ padding: '8px 0 0' }}>{m}</p>)}
      {showOther && entry && (
        <div className="agent-connect">
          <p className="hint" style={{ margin: '10px 0 8px' }}>
            Any MCP-capable agent can use Exponential. Register a stdio server with this command — as one line, or as the usual JSON entry:
          </p>
          <CopyRow label="Command" value={`ELECTRON_RUN_AS_NODE=1 "${entry.command}" "${entry.serverPath}"`} />
          <CopyRow label="JSON" value={JSON.stringify({ command: entry.command, args: [entry.serverPath], env: { ELECTRON_RUN_AS_NODE: '1' } })} />
        </div>
      )}
    </div>
  );
}

/** A text input that grows with its content (objectives and key results run long). */
function GrowInput({ value, placeholder, onChange, style, className = 'member-input grow-input', onKeyDown }: {
  value: string; placeholder: string; onChange: (v: string) => void; style?: React.CSSProperties;
  className?: string; onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = () => { const el = ref.current; if (el) { el.style.height = '0'; el.style.height = `${el.scrollHeight}px`; } };
  useEffect(fit, [value]);
  // re-fit when the box's width settles/changes — a measure taken mid-layout wildly over-wraps
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => { if (el.clientWidth !== w) { w = el.clientWidth; fit(); } });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return <textarea ref={ref} rows={1} className={className} style={style} value={value} placeholder={placeholder} onKeyDown={onKeyDown} onChange={(e) => onChange(e.target.value)} />;
}

/**
 * Template rows styled exactly like the retro side panel's lists: dot handle
 * (drag to reorder), borderless text, hover ×, ghost "+ Add".
 */
function TemplateList<T extends { key: string }>({ items, text, setText, make, onChange, addLabel, placeholder, minRows = 0 }: {
  items: T[]; text: (x: T) => string; setText: (x: T, v: string) => T; make: () => T;
  onChange: (next: T[]) => void; addLabel: string; placeholder: string; minRows?: number;
}) {
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const [dragging, setDragging] = useState<number | null>(null);
  const focusKey = useRef<string | null>(null);
  useEffect(() => {
    if (focusKey.current != null) {
      const i = items.findIndex((x) => x.key === focusKey.current);
      focusKey.current = null;
      rows.current[i]?.querySelector('textarea')?.focus();
    }
  }, [items]);
  const insertAt = (i: number) => {
    const it = make();
    const next = [...items];
    next.splice(i, 0, it);
    onChange(next);
    focusKey.current = it.key;
  };
  return (
    <div className="rl">
      {items.map((x, i) => (
        <div key={x.key} ref={(el) => { rows.current[i] = el; }} className={`rl-row${dragging === i ? ' dragging' : ''}`}>
          <button className="rl-dot" title="Drag to reorder" onPointerDown={(e) => {
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
                onChange(next);
              },
              onState: setDragging,
            });
          }} />
          <GrowInput className="rl-text grow-input" value={text(x)} placeholder={placeholder}
            onChange={(v) => onChange(items.map((y, j) => (j === i ? setText(y, v) : y)))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); insertAt(i + 1); }
              else if (e.key === 'Backspace' && text(x) === '' && items.length > minRows) { e.preventDefault(); onChange(items.filter((_, j) => j !== i)); }
            }} />
          <button className="rl-x" title="Delete" disabled={items.length <= minRows}
            onClick={() => onChange(items.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button className="rl-add" onClick={() => insertAt(items.length)}>{addLabel}</button>
    </div>
  );
}

/** Members of the current team. Moderators can add, remove, and promote/demote. */
export function TeamPage({ team, cloud, canDelete, crmAuto, onUpdate, onDelete }: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isMod = team.moderators.includes(team.me);

  // Feature switches: what this team uses. Stored on the team (patch-012), so one
  // moderator's flip hides/shows the sidebar item for everyone, live over realtime.
  const features = [
    { key: 'chat' as const, name: 'Messages', hint: 'Channels, DMs and the notifications inbox.', on: team.features?.chat !== false },
    { key: 'meetings' as const, name: 'Meetings', hint: 'Recording, transcription and shared meetings.', on: team.features?.meetings !== false },
    { key: 'crm' as const, name: 'CRM', hint: 'The customer sheet and agent (needs the CRM tables).', on: team.features?.crm ?? crmAuto },
  ];
  const flipFeature = (key: 'chat' | 'meetings' | 'crm', on: boolean) =>
    onUpdate((d) => ({ ...d, features: { ...d.features, [key]: on } }));

  // Soft-deleted projects and tasks, newest first; anyone may bring one back.
  const trash = [
    ...team.projects.filter((p) => p.deletedAt).map((p) => ({ id: p.id, kind: 'Project', name: p.name, at: p.deletedAt! })),
    ...team.tasks.filter((t) => t.deletedAt).map((t) => ({ id: t.id, kind: 'Task', name: t.title || '(untitled)', at: t.deletedAt! })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const daysLeft = (at: string) => Math.max(1, Math.ceil(7 - (Date.now() - new Date(at).getTime()) / 86_400_000));
  const when = (at: string) => {
    const d = new Date(at);
    return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  };
  const recover = (id: string) => onUpdate((d) => ({
    ...d,
    projects: d.projects.map((p) => (p.id === id ? { ...p, deletedAt: undefined } : p)),
    tasks: d.tasks.map((t) => (t.id === id ? { ...t, deletedAt: undefined } : t)),
  }));
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');

  const add = () => {
    const n = name.trim(), em = email.trim().toLowerCase();
    if (cloud ? !em.includes('@') : !n) return;
    if (cloud && team.people.some((p) => p.email?.toLowerCase() === em)) { setAdding(false); return; }
    const color = PROJECT_COLORS[team.people.length % PROJECT_COLORS.length];
    const person: Person = cloud
      ? { id: pendingId(em), name: n || em, email: em, color }
      : { id: uid(), name: n, email: em || undefined, color };
    onUpdate((d) => ({ ...d, people: [...d.people, person] }));
    setName(''); setEmail(''); setAdding(false);
  };

  const remove = (id: string) =>
    onUpdate((d) => ({
      ...d,
      people: d.people.filter((p) => p.id !== id),
      moderators: d.moderators.filter((m) => m !== id),
      tasks: d.tasks.filter((t) => t.personId !== id),
      projects: d.projects.map((p) => (p.assignees?.includes(id) ? { ...p, assignees: p.assignees.filter((a) => a !== id) } : p)),
    }));

  const toggleMod = (id: string) =>
    onUpdate((d) => ({ ...d, moderators: d.moderators.includes(id) ? d.moderators.filter((m) => m !== id) : [...d.moderators, id] }));

  const tpl: RetroTemplate = { objective: '', keyResults: [], healthMetrics: DEFAULT_HEALTH_METRICS, ...team.retroTemplate };
  const setTpl = (next: RetroTemplate) => onUpdate((d) => ({ ...d, retroTemplate: next }), 'retro-template'); // typing in template rows coalesces into burst-sized undo steps
  const fileRef = useRef<HTMLInputElement>(null);
  const pickIcon = (file: File) => {
    // downscale to 256px so the data URL stays small in the saved file
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const ctx = c.getContext('2d')!;
      const sc = Math.max(256 / img.width, 256 / img.height);
      ctx.drawImage(img, (256 - img.width * sc) / 2, (256 - img.height * sc) / 2, img.width * sc, img.height * sc);
      const url = c.toDataURL('image/png');
      onUpdate((d) => ({ ...d, icon: url }));
    };
    img.src = URL.createObjectURL(file);
  };

  return (
    <section className="team-page">
      {/* ── Team: identity + Claude ── */}
      <div className="panel team-card">
        <div className="team-card-head">
          <TeamMark team={team} size={64} />
          <div className="team-card-name">
            {isMod ? (
              <input
                className="panel-title team-title-input"
                defaultValue={team.name}
                key={team.id}
                title="Rename team"
                onBlur={(e) => { const n = e.target.value.trim(); if (n && n !== team.name) onUpdate((d) => ({ ...d, name: n })); else e.target.value = team.name; }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
            ) : <div className="panel-title">{team.name}</div>}
            <div className="panel-sub-count">{team.people.length} {team.people.length === 1 ? 'member' : 'members'}</div>
          </div>
          {isMod && (
            <div className="icon-row">
              <button className="pill" onClick={() => fileRef.current?.click()}>{team.icon ? 'Change image' : 'Upload image'}</button>
              {team.icon && <button className="pill" onClick={() => onUpdate((d) => ({ ...d, icon: undefined }))}>Use the letter</button>}
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) pickIcon(f); e.target.value = ''; }} />
            </div>
          )}
        </div>
        {!!window.exponential?.connectClaude && (
          <div className="team-card-sub">
            <div className="settings-title">Claude</div>
            <p className="hint" style={{ margin: '0 0 10px' }}>
              Let Claude read your plan and manage tasks. Editing the master plan needs Unlock.
            </p>
            <ClaudeConnect />
          </div>
        )}
      </div>

      {/* ── Members ── */}
      <div className="panel team-card">
        <div className="team-card-titlerow">
          <div className="settings-title">Members</div>
          {isMod && !adding && <button className="pill" onClick={() => setAdding(true)}>+ Add member</button>}
        </div>
        {adding && (
          <form className="member-row add" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <span className="avatar initials" style={{ width: 36, height: 36, background: 'var(--soft-2)', color: 'var(--text-3)', fontSize: 18 }}>+</span>
            {cloud ? (
              <input autoFocus className="member-input" placeholder="Google email — they join when they sign in" value={email} onChange={(e) => setEmail(e.target.value)} />
            ) : (
              <>
                <input autoFocus className="member-input" placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} />
                <input className="member-input" placeholder="Email (for Google Calendar)" value={email} onChange={(e) => setEmail(e.target.value)} />
              </>
            )}
            <button type="submit" className="btn primary" disabled={cloud ? !email.includes('@') : !name.trim()}>{cloud ? 'Invite' : 'Add'}</button>
            <button type="button" className="btn" onClick={() => { setAdding(false); setName(''); setEmail(''); }}>Cancel</button>
          </form>
        )}
        {team.people.map((p) => {
          const mod = team.moderators.includes(p.id);
          const self = p.id === team.me;
          const lastMod = mod && team.moderators.length === 1;
          return (
            <div key={p.id} className="member-row">
              <Avatar person={p} size={36} />
              <div className="member-info">
                <div className="member-name">{p.name}{self && <span className="you-tag">you</span>}</div>
                <div className="member-email">{isPending(p.id) ? `Invited · ${p.email} — waiting for them to sign in` : (p.email ?? 'No email yet')}</div>
              </div>
              <span className={`role${mod ? ' mod' : ''}`}>{mod ? 'Moderator' : 'Member'}</span>
              {isMod && (
                <div className="member-actions">
                  <button className="pill small" onClick={() => toggleMod(p.id)} disabled={lastMod} title={lastMod ? 'A team needs at least one moderator' : ''}>
                    {mod ? 'Make member' : 'Make moderator'}
                  </button>
                  {!self && <button className="pill small danger" onClick={() => remove(p.id)}>Remove</button>}
                </div>
              )}
            </div>
          );
        })}
        {!isMod && <p className="hint" style={{ padding: '10px 12px 2px' }}>Ask a moderator to add or remove people.</p>}
      </div>

      {/* ── Features: which optional surfaces this team uses ── */}
      {isMod && (
        <div className="panel team-card">
          <div className="settings-title">Features</div>
          <p className="hint" style={{ margin: '0 0 6px' }}>What this team uses. Switching one off hides it from the sidebar for everyone.</p>
          {features.map((f) => (
            <div key={f.key} className="feature-row">
              <div className="feature-info">
                <div className="feature-name">{f.name}</div>
                <div className="hint">{f.hint}</div>
              </div>
              <button className={`pill toggle${f.on ? ' active' : ''}`} onClick={() => flipFeature(f.key, !f.on)}>
                {f.on ? 'On' : 'Off'}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Retro template: objective + key results + health checks ── */}
      {isMod && (
        <div className="panel team-card">
          <div className="settings-title">Retro</div>
          <p className="hint" style={{ margin: '0 0 14px' }}>
            The weekly retro's structure is fixed — Priorities, OKR confidence, Health, Improvements. What's reviewed lives here.
            Past weeks keep whatever was set at the time.
          </p>
          <div className="retro-sec-title">Objective</div>
          <GrowInput className="rl-text grow-input" style={{ width: '100%', maxWidth: 720 }} value={tpl.objective}
            placeholder="The objective the team is driving at, e.g. First customer flight by December"
            onChange={(v) => setTpl({ ...tpl, objective: v })} />
          <div className="retro-sec-title" style={{ margin: '18px 0 4px' }}>Key results</div>
          <TemplateList items={tpl.keyResults} text={(x) => x.name} setText={(x, v) => ({ ...x, name: v })}
            make={() => ({ key: uid(), name: '' })} addLabel="+ Add key result" placeholder="Key result"
            onChange={(keyResults) => setTpl({ ...tpl, keyResults })} />
          <div className="retro-sec-title" style={{ margin: '18px 0 2px' }}>Health checks</div>
          <p className="hint" style={{ margin: '0 0 4px' }}>Everyone marks each of these green, yellow or red in the retro.</p>
          <TemplateList items={tpl.healthMetrics} text={(x) => x.label} setText={(x, v) => ({ ...x, label: v })}
            make={() => ({ key: uid(), label: '' })} addLabel="+ Add health check" placeholder="e.g. Stress level" minRows={1}
            onChange={(healthMetrics) => setTpl({ ...tpl, healthMetrics })} />
        </div>
      )}

      {/* ── Recently deleted ── */}
      <div className="panel team-card">
        <div className="settings-title">Recently deleted</div>
        {trash.length === 0 && <p className="hint" style={{ margin: 0 }}>Deleted projects and tasks stay here for 7 days.</p>}
        <div className="trash-list">
          {trash.map((x) => (
            <div key={x.id} className="trash-row">
              <span className="trash-kind">{x.kind}</span>
              <span className="trash-name">{x.name}</span>
              <span className="trash-when">{when(x.at)} · gone in {daysLeft(x.at)} day{daysLeft(x.at) === 1 ? '' : 's'}</span>
              <button className="pill small" onClick={() => recover(x.id)}>Recover</button>
            </div>
          ))}
        </div>
      </div>

      {/* ── Delete team: plainly on the background, outside every box ── */}
      {isMod && canDelete && (
        <div className="team-danger">
          {confirmDelete ? (
            <div className="confirm-row">
              <span>Delete <b>{team.name}</b> with all its projects, tasks and retros for everyone? This can't be undone.</span>
              <button className="btn danger-btn" onClick={onDelete}>Delete team</button>
              <button className="btn" onClick={() => setConfirmDelete(false)}>Keep it</button>
            </div>
          ) : (
            <button className="pill danger" onClick={() => setConfirmDelete(true)}>Delete team…</button>
          )}
        </div>
      )}
    </section>
  );
}
