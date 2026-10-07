export type ISODate = string; // YYYY-MM-DD

export type Status = 'todo' | 'progress' | 'review' | 'done' | 'cancelled';

export interface Person {
  id: string;
  name: string;
  email?: string;
  photo?: string;
  color: string;
}

export interface Group {
  id: string;
  name: string;
  color: string;
  sort: number;
}

export interface Project {
  id: string;
  name: string;
  start: ISODate;
  end: ISODate;
  lane: number; // within its group's section
  groupId?: string;
  color?: string; // legacy; colour now comes from the group
  notes?: string; // Markdown
  assignees?: string[];
  deletedAt?: string; // soft-deleted: sits in Team settings → Recently deleted for 7 days
}

export interface Deadline {
  id: string;
  name: string;
  date: ISODate;
  notes?: string;
}

export interface Task {
  id: string;
  personId?: string; // absent = unassigned, sitting in a project's (or parent task's) list
  title: string;
  date?: ISODate; // absent = backlog: shown in every week until scheduled
  end?: ISODate; // inclusive; same as date when absent
  status: Status;
  order?: number; // position among tasks on the same day
  notes?: string;
  createdBy?: string; // person id when someone else added it
  reviewerId?: string;
  reviewDone?: boolean; // the reviewer finished this review (task itself went back to In progress)
  projectId?: string; // taken from a project's to-do list
  parentId?: string; // subtask of another task
  deletedAt?: string; // soft-deleted: sits in Team settings → Recently deleted for 7 days
}

export type NotificationKind = 'task-added' | 'task-changed' | 'review-requested' | 'review-denied' | 'review-completed' | 'owner-changed' | 'project-changed' | 'chat-mention';

export interface Notification {
  id: string;
  to: string;
  from: string;
  kind: NotificationKind;
  text: string;
  ref: { kind: 'task' | 'project' | 'chat'; id: string };
  at: string; // ISO timestamp
  read: boolean;
}

export interface RetroField {
  key: string;
  label: string;
  hint: string;
}

export const DEFAULT_RETRO_FIELDS: RetroField[] = [
  { key: 'wentWell', label: 'What went well', hint: 'Wins, things to keep doing…' },
  { key: 'improve', label: 'What could be better', hint: 'Friction, misses, surprises…' },
  { key: 'learnings', label: 'Learnings', hint: 'What we know now that we didn’t before…' },
  { key: 'nextFocus', label: 'Focus for next week', hint: 'The one or two things that matter most…' },
];

/* ── Retro (weekly team review) ──
   The structure is fixed: Demos, OKR confidence, Focus, Health, Improvements. What varies —
   the objective, its key results, and the health checks — lives in the team's RetroTemplate.
   Each retro stores a frozen copy of the template so past weeks read as they were. */
export interface KeyResult { key: string; name: string }
export interface HealthMetric { key: string; label: string }
export interface RetroTemplate {
  objective: string;
  keyResults: KeyResult[];
  healthMetrics: HealthMetric[];
}
export const DEFAULT_HEALTH_METRICS: HealthMetric[] = [
  { key: 'stress', label: 'Stress level' },
  { key: 'sleep', label: 'Sleep quality' },
  { key: 'office', label: 'Happy to be in the office' },
];
export type HealthMark = 'g' | 'y' | 'r';

export interface RetroAnswers {
  demos?: string;
  focus?: string;
  improvements?: string;
  confidence?: Record<string, number>; // KeyResult.key -> 0..10
  health?: Record<string, Record<string, HealthMark>>; // person id -> HealthMetric.key -> mark
  template?: RetroTemplate; // snapshot: past weeks keep the template as it was
  locked?: boolean; // frozen by the Lock button: page renders read-only from its snapshots
  lockedAt?: string; // ISO timestamp of the lock
  people?: Person[]; // snapshot of the team at lock time (health matrix stays as it was)
  [legacy: string]: unknown; // pre-redesign free-text answers by RetroField.key
}

export interface Retro {
  week: ISODate; // Monday
  answers: RetroAnswers;
  notes?: string;
}

/** Which optional surfaces this team uses (Team settings → Features). Absent key = the
    default: chat and meetings ON, crm AUTO (shown once the team has CRM rows). */
export interface TeamFeatures { chat?: boolean; meetings?: boolean; crm?: boolean }

export interface Data {
  id: string;
  name: string;
  icon?: string; // image data URL; falls back to the first letter of the name
  retroFields?: RetroField[]; // legacy question list (pre-redesign retros)
  retroTemplate?: RetroTemplate;
  features?: TeamFeatures;
  moderators: string[]; // person ids allowed to manage members
  people: Person[];
  groups?: Group[];
  projects: Project[];
  deadlines: Deadline[];
  tasks: Task[];
  me: string;
  showCalendar?: boolean;
  notifications?: Notification[];
  retros?: Record<ISODate, Retro>;
}

export interface Workspace {
  teams: Data[];
  current: string; // team id
}

export interface CalendarEvent {
  id: string;
  title: string;
  date: ISODate;
  start?: string; // HH:MM, absent for all-day
  end?: string;
  allDay: boolean;
  link?: string; // htmlLink into Google Calendar
}

export interface GoogleUser {
  id: string;
  email: string;
  name: string;
  givenName?: string;
  familyName?: string;
  picture?: string;
}

export const STATUS_LABEL: Record<Status, string> = {
  todo: 'To do',
  progress: 'In progress',
  review: 'Needs review',
  done: 'Completed',
  cancelled: 'Cancelled',
};

export const STATUS_ORDER: Status[] = ['todo', 'progress', 'review', 'done', 'cancelled'];

export const STATUS_COLOR: Record<Status, string> = {
  todo: '#d1d1d6',
  progress: '#0a84ff',
  review: '#ff9f0a',
  done: '#30d158',
  cancelled: '#aeaeb2',
};

export const PROJECT_COLORS = ['#3478f6', '#ff9f0a', '#34c759', '#af52de', '#ff375f', '#ffd60a', '#64d2ff'];
/** Groups saved under the old muted palette render in the crisp equivalent. */
const CRISP: Record<string, string> = {
  '#5b8def': '#3478f6', '#f0a04b': '#ff9f0a', '#3fb98a': '#34c759', '#9b7fe8': '#af52de',
  '#e8739b': '#ff375f', '#e2b93b': '#ffd60a', '#3fb4d6': '#64d2ff',
};
export const crispColor = (c: string) => CRISP[c] ?? c;
export const NO_GROUP_COLOR = '#b8b8c0';

/** "Rasmus Hauschild" → "Rasmus H." */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return parts[0] ?? '';
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}
