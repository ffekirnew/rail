import {
  CollisionDetection, DndContext, DragEndEvent, DragMoveEvent, DragOverlay, DragStartEvent, MeasuringStrategy, PointerSensor, TouchSensor,
  pointerWithin, rectIntersection, useDraggable, useDroppable, useSensor, useSensors,
} from "@dnd-kit/core";
import { Archive, Calendar, ChevronDown, ChevronsLeftRight, ChevronsRightLeft, Flag, Plus } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Project, STATUS_LABELS, Status, Task, today, who } from "./api";
import { inDays, isOverdue } from "./filters";
import { Avatar, IconButton, StatusDot, StatusIcon, stagger } from "./ui";

// Drop on the column under the pointer, so a narrow collapsed column isn't outvoted by a
// wide neighbour the card overlaps more; fall back to overlap when the pointer is between columns.
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length ? hits : rectIntersection(args);
};

// Done only shows what was finished recently; everything stays in the Projects list.
const DONE_DAYS = 14;

// Done is ordered by when each task was finished, so a drop there only changes status.
const ordered = (s: Status) => s !== "done";

// Where a dragged card would land: the column, and the card it goes before (null for the
// end). No `before` means the drop changes status only and keeps the card's position.
type Target = { status: Status; before?: number | null };

const byPosition = (a: Task, b: Task) => a.position - b.position || a.id - b.id;

// Columns open and close mid-drag, so drop zones are measured again as the layout changes.
const measuring = { droppable: { strategy: MeasuringStrategy.Always } };

// Where a card sits in its list, ignoring any slide in progress (.cards is its offsetParent).
const layoutMid = (el: HTMLElement) => el.offsetTop + el.offsetHeight / 2;

// While a drag is on, cards that shift (a gap opening or closing) slide to their new
// place instead of jumping: each render, a card that moved is animated from where it was.
function useSlide(list: React.RefObject<HTMLDivElement | null>, on: boolean) {
  const tops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const el of list.current?.querySelectorAll<HTMLElement>("[data-task-id]") ?? []) {
      if (!el.offsetParent) continue; // hidden: it's the card being dragged elsewhere
      const id = el.dataset.taskId!;
      const was = tops.current.get(id);
      next.set(id, el.offsetTop);
      if (on && !reduce && was !== undefined && was !== el.offsetTop) {
        el.animate(
          [{ transform: `translateY(${was - el.offsetTop}px)` }, { transform: "none" }],
          { duration: 200, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
        );
      }
    }
    tops.current = next;
  });
}

const daysBetween = (a: string, b: string) =>
  Math.round((new Date(b + "T00:00:00").getTime() - new Date(a + "T00:00:00").getTime()) / 86400000);

export function dueLabel(iso: string): string {
  const diff = daysBetween(today(), iso);
  if (diff === 0) return "Due today";
  if (diff === 1) return "Due tomorrow";
  if (diff < 0) return `Overdue ${-diff}d`;
  if (diff < 7) return `Due ${new Date(iso + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" })}`;
  return `Due ${new Date(iso + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

export function DueChip({ task }: { task: Task }) {
  if (!task.due_date) return null;
  const overdue = isOverdue(task);
  const Icon = overdue ? Flag : Calendar;
  const soon = !overdue && task.due_date === today();
  return (
    <span className={`chip due ${overdue ? "overdue" : soon ? "today" : ""}`}>
      <Icon size={12} strokeWidth={2.25} />{dueLabel(task.due_date)}
    </span>
  );
}

export function PriorityBadge({ task }: { task: Task }) {
  // Medium is the default, so only the others get a badge.
  if (task.priority === "medium") return null;
  return <span className={`prio ${task.priority}`}>{task.priority[0].toUpperCase() + task.priority.slice(1)}</span>;
}

function CardBody({ task, showProject }: { task: Task; showProject: boolean }) {
  return (
    <>
      <div className="card-top">
        <StatusIcon status={task.status} />
        <PriorityBadge task={task} />
        <span className="card-title">{task.title}</span>
      </div>
      {task.status === "blocked" && task.latest_comment && (
        <div className="blocked-reason" title={`${who(task.latest_comment.actor)}: ${task.latest_comment.body}`}>
          {task.latest_comment.body}
        </div>
      )}
      <div className="meta">
        <span className="chip mono">#{task.id}</span>
        {showProject && <span className="chip">{task.project}</span>}
        <DueChip task={task} />
        {task.tags.map((g) => <span key={g} className="chip mono">{g}</span>)}
        <span className="spacer" />
        {task.assignee && <span title={who(task.assignee)}><Avatar actor={task.assignee} size={20} /></span>}
      </div>
    </>
  );
}

const closedClass = (t: Task) => (t.status === "done" || t.status === "cancelled" ? "closed" : "");

// The card stays in its column as a faded placeholder while a copy follows the
// pointer in <DragOverlay>: the column's card list scrolls, which would clip it.
// Once there's somewhere else to drop it, the placeholder hides and a gap opens there.
function Card({ task, index, showProject, away, onOpen }: {
  task: Task; index?: number; showProject: boolean; away: boolean; onOpen: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });
  return (
    <div
      ref={setNodeRef}
      data-task-id={task.id}
      className={`card ${isDragging ? "placeholder-card" : ""} ${isDragging && away ? "away" : ""} ${closedClass(task)}`}
      style={index === undefined ? undefined : stagger(index)}
      onClick={onOpen}
      {...listeners}
      {...attributes}
    >
      <CardBody task={task} showProject={showProject} />
    </div>
  );
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const diff = daysBetween(d.toLocaleDateString("sv"), today());
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// A lane is one project's row of columns; with a single project picked, the board is one lane.
type Lane = { key: string; project?: Project; tasks: Task[] };

// Droppable ids are "<lane>|<status>", so a card can only land in its own lane.
const dropId = (lane: string, s: Status) => `${lane}|${s}`;
const parseDrop = (id: string) => {
  const [lane, status] = id.split("|");
  return { lane, status: status as Status };
};
// Shown while a card is dragged and the Backlog column is hidden.
const BACKLOG_DROP = "backlog-drop";

const OPEN_WIDTH = 260;
const COLLAPSED_WIDTH = 44;
const GAP = 12;

function Column({ id, status, tasks, showProject, collapsed, disabled, entering, dragging, dropBefore, slotHeight, away, onToggle, onOpen, onAdd }: {
  id: string; status: Status; tasks: Task[]; showProject: boolean; collapsed: boolean; disabled: boolean;
  entering: boolean; dragging: boolean; dropBefore?: number | null; slotHeight: number; away: boolean;
  onToggle: () => void; onOpen: (id: number) => void; onAdd: () => void;
}) {
  // A collapsed column still takes drops, so a card can be sent to Done without opening it.
  const { setNodeRef, isOver } = useDroppable({ id, disabled });
  const listRef = useRef<HTMLDivElement>(null);
  useSlide(listRef, dragging);
  const label = STATUS_LABELS[status];
  const cls = `column s-${status} ${isOver ? "over" : ""} ${disabled && dragging ? "off" : ""}`;
  if (collapsed) {
    return (
      <section ref={setNodeRef} className={`${cls} collapsed`}>
        <IconButton label={`Expand ${label}`} onClick={onToggle}><ChevronsLeftRight size={15} /></IconButton>
        <StatusDot status={status} />
        <span className="collapsed-label">{label}</span>
        <span className="count">{tasks.length}</span>
      </section>
    );
  }
  // Done is grouped by the day each task was finished (its last update).
  let lastDay = "";
  const slot = <div className="drop-slot" style={{ height: slotHeight }} />;
  return (
    <section ref={setNodeRef} data-column={id} className={cls}>
      <header className="column-head">
          <StatusDot status={status} />
          <h2>{label}</h2>
          {status === "done" && <span className="column-note">last {DONE_DAYS} days</span>}
          <span className="spacer" />
          <span className="count">{tasks.length}</span>
          <IconButton label={`Collapse ${label}`} onClick={onToggle}><ChevronsRightLeft size={15} /></IconButton>
      </header>
      <div className="cards" ref={listRef}>
        {tasks.map((t, i) => {
          let divider = null;
          if (status === "done") {
            const day = dayLabel(t.updated_at);
            if (day !== lastDay) {
              const n = tasks.filter((x) => dayLabel(x.updated_at) === day).length;
              divider = <div className="day-divider"><span>{day}</span><hr /><span>{n}</span></div>;
              lastDay = day;
            }
          }
          return (
            <Fragment key={t.id}>
              {divider}
              {dropBefore === t.id && slot}
              <Card task={t} index={entering ? i : undefined} showProject={showProject} away={away} onOpen={() => onOpen(t.id)} />
            </Fragment>
          );
        })}
        {dropBefore === null && slot}
      </div>
      {status !== "done" && status !== "cancelled" && (
        <button type="button" className="add-card" onClick={onAdd}><Plus size={15} strokeWidth={2.25} />Add task</button>
      )}
    </section>
  );
}

function BacklogDrop() {
  const { setNodeRef, isOver } = useDroppable({ id: BACKLOG_DROP });
  return (
    <div ref={setNodeRef} className={`backlog-drop s-backlog ${isOver ? "over" : ""}`}>
      <Archive size={15} />Send to backlog
    </div>
  );
}

export function Board({ tasks, projects, projectId, statuses, showProject, collapsed, folded, backlogDrop, onToggle, onFold, onFocus, onOpen, onMove, onAdd }: {
  tasks: Task[];
  projects: Project[];
  // The picked project, shown as a single board; without one, every project gets a lane.
  projectId?: number;
  // The columns to show, in order: Backlog is left out unless it's switched on.
  statuses: Status[];
  showProject: boolean;
  // Collapsed columns, per lane (keyed "p<project id>").
  collapsed: Map<string, Set<Status>>;
  folded: Set<number>;
  // A drop zone for sending cards to the backlog while its column is hidden.
  backlogDrop: boolean;
  onToggle: (lane: string, s: Status) => void;
  onFold: (projectId: number) => void;
  onFocus: (projectId: number) => void;
  onOpen: (id: number) => void;
  // positions holds the new position of every task that moves: usually just the dragged one.
  onMove: (task: Task, status: Status, positions: Record<number, number>) => void;
  onAdd: (s: Status, projectId?: number) => void;
}) {
  // A small distance threshold keeps a click on a card from starting a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );
  const [activeId, setActiveId] = useState<number | null>(null);
  // Cards cascade in when the board opens; after that, a card that appears (moved or
  // filtered in) settles in on its own, without waiting for the ones above it.
  const [entering, setEntering] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setEntering(false), 700);
    return () => clearTimeout(t);
  }, []);
  const [target, setTarget] = useState<Target | null>(null);
  const [slotHeight, setSlotHeight] = useState(0);
  // Collapsed columns a card has been dragged over open for the rest of the drag,
  // and close again unless the card lands there.
  // Each lane collapses its own columns; peeked holds drop ids ("<lane>|<status>").
  const [peeked, setPeeked] = useState<Set<string>>(new Set());
  const isCollapsed = (lane: string, s: Status) => !!collapsed.get(lane)?.has(s) && !peeked.has(dropId(lane, s));
  const active = tasks.find((t) => t.id === activeId);
  const cutoff = inDays(-DONE_DAYS);
  const onBoard = (t: Task) => statuses.includes(t.status) && (t.status !== "done" || t.updated_at.slice(0, 10) >= cutoff);
  const inColumn = (s: Status, ts: Task[]) => {
    const col = ts.filter((t) => t.status === s && onBoard(t));
    if (s !== "done") return col.sort(byPosition);
    return col.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  };

  // Lanes with nothing on the board are left out; projects keep their own order.
  const byProject = !projectId;
  const lanes: Lane[] = (byProject ? projects : projects.filter((p) => p.id === projectId))
    .map((p) => ({ key: `p${p.id}`, project: p, tasks: tasks.filter((t) => t.project_id === p.id) }))
    .filter((l) => !byProject || l.tasks.some(onBoard));
  const laneOf = (t: Task) => `p${t.project_id}`;
  const laneTasks = (key: string) => lanes.find((l) => l.key === key)?.tasks ?? [];

  // The drop slot is the first card (other than the dragged one) whose middle is below
  // the middle of the card under the pointer.
  const targetFor = (e: DragMoveEvent | DragEndEvent): Target | null => {
    const over = e.over?.id as string | undefined;
    if (!over) return null;
    if (over === BACKLOG_DROP) return { status: "backlog" };
    const { lane, status } = parseDrop(over);
    const rect = e.active.rect.current.translated;
    if (!ordered(status) || isCollapsed(lane, status) || !rect) return { status };
    const y = rect.top + rect.height / 2;
    const list = document.querySelector<HTMLElement>(`[data-column="${over}"] .cards`);
    if (!list) return { status };
    const origin = list.getBoundingClientRect().top - list.scrollTop;
    const cards = [...list.querySelectorAll<HTMLElement>("[data-task-id]")]
      .filter((el) => Number(el.dataset.taskId) !== e.active.id);
    const hit = cards.find((el) => {
      // Layout positions, not on-screen ones, so a card mid-slide can't flip the slot back.
      return el.offsetParent && y < origin + layoutMid(el);
    });
    const before = hit ? Number(hit.dataset.taskId) : null;
    // Dropping a card back into its own slot is no move at all.
    const ts = inColumn(status, laneTasks(lane));
    const i = ts.findIndex((t) => t.id === e.active.id);
    if (i >= 0 && before === (ts[i + 1]?.id ?? null)) return { status };
    return { status, before };
  };

  // A position between the new neighbours in the card's lane; if they tie, renumber that part of the column instead.
  const placeAt = (task: Task, status: Status, before: number | null): Record<number, number> => {
    const list = inColumn(status, laneTasks(laneOf(task))).filter((t) => t.id !== task.id);
    const i = before === null ? list.length : list.findIndex((t) => t.id === before);
    if (i < 0) return {};
    const prev = list[i - 1], next = list[i];
    if (!prev && !next) return {};
    const p = prev && next ? (prev.position + next.position) / 2 : prev ? prev.position + 1 : next.position - 1;
    if ((!prev || p > prev.position) && (!next || p < next.position)) return { [task.id]: p };
    const order = [...list.slice(0, i), task, ...list.slice(i)];
    return Object.fromEntries(order.map((t, k) => [t.id, k + 1]));
  };

  const onDragStart = (e: DragStartEvent) => {
    setActiveId(Number(e.active.id));
    // Measured from the card itself: dnd-kit hasn't measured it yet when the drag starts.
    const el = document.querySelector<HTMLElement>(`[data-task-id="${e.active.id}"]`);
    setSlotHeight(el?.offsetHeight ?? 0);
  };
  const endPeek = () => setPeeked(new Set());
  const onDragMove = (e: DragMoveEvent) => {
    const over = e.over?.id as string | undefined;
    if (over && over !== BACKLOG_DROP) {
      const { lane, status } = parseDrop(over);
      if (isCollapsed(lane, status)) setPeeked((p) => new Set(p).add(over));
    }
    const t = targetFor(e);
    setTarget((old) => (old?.status === t?.status && old?.before === t?.before ? old : t));
  };
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    setTarget(null);
    endPeek();
    const task = tasks.find((t) => t.id === e.active.id);
    const t = targetFor(e);
    if (!task || !t) return;
    // A column opened for this drop stays open.
    if (peeked.has(dropId(laneOf(task), t.status))) onToggle(laneOf(task), t.status);
    const positions = t.before === undefined ? {} : placeAt(task, t.status, t.before);
    if (t.status !== task.status || Object.keys(positions).length) onMove(task, t.status, positions);
  };
  const onDragCancel = () => {
    setActiveId(null);
    setTarget(null);
    endPeek();
  };

  const columns = (lane: Lane) => statuses.map((s) => (
    <Column
      key={s} id={dropId(lane.key, s)} status={s} tasks={inColumn(s, lane.tasks)} showProject={showProject}
      collapsed={isCollapsed(lane.key, s)} disabled={!!active && laneOf(active) !== lane.key}
      entering={entering} dragging={!!active}
      dropBefore={target?.status === s && active && laneOf(active) === lane.key ? target.before : undefined}
      slotHeight={slotHeight} away={target?.before !== undefined} onToggle={() => onToggle(lane.key, s)} onOpen={onOpen}
      onAdd={() => onAdd(s, lane.project?.id)}
    />
  ));

  // The lanes scroll sideways together, as wide as the widest one.
  const laneWidth = (lane: string) =>
    statuses.reduce((w, s) => w + (isCollapsed(lane, s) ? COLLAPSED_WIDTH : OPEN_WIDTH), 0) + GAP * (statuses.length - 1);
  const minWidth = Math.max(0, ...lanes.map((l) => laneWidth(l.key)));

  return (
    <DndContext sensors={sensors} collisionDetection={collision} measuring={measuring} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
      {byProject ? (
        <div className={`board lanes ${active ? "dragging" : ""}`}>
          {lanes.length === 0 ? <div className="empty"><p>Nothing on the board.</p></div> : (
            <div className="lanes-inner" style={{ minWidth }}>
              {lanes.map((lane) => {
                const p = lane.project!;
                const shut = folded.has(p.id);
                const open = lane.tasks.filter((t) => statuses.includes(t.status) && t.status !== "done" && t.status !== "cancelled").length;
                const blocked = lane.tasks.filter((t) => t.status === "blocked").length;
                return (
                  <section key={lane.key} className={`lane ${shut ? "folded" : ""}`}>
                    <header className="lane-head">
                      <IconButton label={shut ? `Expand ${p.name}` : `Fold ${p.name}`} onClick={() => onFold(p.id)}>
                        <ChevronDown size={16} className="fold-icon" />
                      </IconButton>
                      <button type="button" className="lane-name" title={`Show only ${p.name}`} onClick={() => onFocus(p.id)}>{p.name}</button>
                      <span className="lane-stats">
                        {open} open{blocked > 0 && <> · <span className="bad">{blocked} blocked</span></>}
                      </span>
                    </header>
                    {!shut && <div className="lane-row">{columns(lane)}</div>}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div className={`board ${active ? "dragging" : ""}`}>{lanes[0] && columns(lanes[0])}</div>
      )}
      {backlogDrop && active && active.status !== "backlog" && <BacklogDrop />}
      <DragOverlay dropAnimation={null}>
        {active && (
          <div className={`card lifted ${closedClass(active)}`}>
            <CardBody task={active} showProject={showProject} />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
