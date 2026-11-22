import {
  CollisionDetection, DndContext, DragEndEvent, DragMoveEvent, DragOverlay, DragStartEvent, PointerSensor, TouchSensor,
  pointerWithin, rectIntersection, useDraggable, useDroppable, useSensor, useSensors,
} from "@dnd-kit/core";
import { Calendar, ChevronsLeftRight, ChevronsRightLeft, Flag, Plus } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { STATUSES, STATUS_LABELS, Status, Task, today, who } from "./api";
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

function Column({ status, tasks, showProject, collapsed, entering, dragging, dropBefore, slotHeight, away, onToggle, onOpen, onAdd }: {
  status: Status; tasks: Task[]; showProject: boolean; collapsed: boolean; entering: boolean;
  dragging: boolean; dropBefore?: number | null; slotHeight: number; away: boolean;
  onToggle: () => void; onOpen: (id: number) => void; onAdd: () => void;
}) {
  // A collapsed column still takes drops, so a card can be sent to Done without opening it.
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const listRef = useRef<HTMLDivElement>(null);
  useSlide(listRef, dragging);
  const label = STATUS_LABELS[status];
  if (collapsed) {
    return (
      <section ref={setNodeRef} className={`column collapsed s-${status} ${isOver ? "over" : ""}`}>
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
    <section ref={setNodeRef} data-column={status} className={`column s-${status} ${isOver ? "over" : ""}`}>
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

export function Board({ tasks, showProject, collapsed, onToggle, onOpen, onMove, onAdd }: {
  tasks: Task[];
  showProject: boolean;
  collapsed: Set<Status>;
  onToggle: (s: Status) => void;
  onOpen: (id: number) => void;
  // positions holds the new position of every task that moves: usually just the dragged one.
  onMove: (task: Task, status: Status, positions: Record<number, number>) => void;
  onAdd: (s: Status) => void;
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
  const active = tasks.find((t) => t.id === activeId);
  const cutoff = inDays(-DONE_DAYS);
  const inColumn = (s: Status) => {
    const ts = tasks.filter((t) => t.status === s);
    if (s !== "done") return [...ts].sort(byPosition);
    return ts.filter((t) => t.updated_at.slice(0, 10) >= cutoff).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  };

  // The drop slot is the first card (other than the dragged one) whose middle is below
  // the middle of the card under the pointer.
  const targetFor = (e: DragMoveEvent | DragEndEvent): Target | null => {
    const status = e.over?.id as Status | undefined;
    const rect = e.active.rect.current.translated;
    if (!status) return null;
    if (!ordered(status) || collapsed.has(status) || !rect) return { status };
    const y = rect.top + rect.height / 2;
    const list = document.querySelector<HTMLElement>(`[data-column="${status}"] .cards`);
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
    const ts = inColumn(status);
    const i = ts.findIndex((t) => t.id === e.active.id);
    if (i >= 0 && before === (ts[i + 1]?.id ?? null)) return { status };
    return { status, before };
  };

  // A position between the new neighbours; if they tie, renumber the column instead.
  const placeAt = (task: Task, status: Status, before: number | null): Record<number, number> => {
    const list = inColumn(status).filter((t) => t.id !== task.id);
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
  const onDragMove = (e: DragMoveEvent) => {
    const t = targetFor(e);
    setTarget((old) => (old?.status === t?.status && old?.before === t?.before ? old : t));
  };
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    setTarget(null);
    const task = tasks.find((t) => t.id === e.active.id);
    const t = targetFor(e);
    if (!task || !t) return;
    const positions = t.before === undefined ? {} : placeAt(task, t.status, t.before);
    if (t.status !== task.status || Object.keys(positions).length) onMove(task, t.status, positions);
  };
  const onDragCancel = () => {
    setActiveId(null);
    setTarget(null);
  };
  return (
    <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
      <div className={`board ${active ? "dragging" : ""}`}>
        {STATUSES.map((s) => (
          <Column
            key={s} status={s} tasks={inColumn(s)} showProject={showProject}
            collapsed={collapsed.has(s)} entering={entering} dragging={!!active} dropBefore={target?.status === s ? target.before : undefined}
            slotHeight={slotHeight} away={target?.before !== undefined} onToggle={() => onToggle(s)} onOpen={onOpen} onAdd={() => onAdd(s)}
          />
        ))}
      </div>
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
