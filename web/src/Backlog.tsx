import {
  DndContext, DragEndEvent, DragOverlay, DragStartEvent, PointerSensor, TouchSensor, pointerWithin,
  useDraggable, useDroppable, useSensor, useSensors,
} from "@dnd-kit/core";
import { ArrowRight, ChevronDown, GripVertical, Inbox, Plus, X } from "lucide-react";
import { useState } from "react";
import { PRIORITIES, Priority, Project, Task, who } from "./api";
import { DueChip, PriorityBadge } from "./Board";
import { Avatar, IconButton, stagger } from "./ui";

const byPosition = (a: Task, b: Task) => a.position - b.position || a.id - b.id;

// A row drops before the row it's dragged onto, or at the end of its group's list.
const rowDrop = (id: number) => `row-${id}`;
const endDrop = (projectId: number) => `end-${projectId}`;

function Row({ task, index, disabled, over, onOpen, onPromote, onPriority, onCancel }: {
  task: Task; index: number; disabled: boolean; over: boolean;
  onOpen: () => void; onPromote: () => void; onPriority: (p: Priority) => void; onCancel: () => void;
}) {
  const drag = useDraggable({ id: task.id });
  const drop = useDroppable({ id: rowDrop(task.id), disabled });
  return (
    <li ref={drop.setNodeRef} className={`backlog-row ${drag.isDragging ? "placeholder-row" : ""} ${over ? "drop-before" : ""}`}
      style={stagger(index)} onClick={onOpen} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) onOpen(); }}>
      <span ref={drag.setNodeRef} className="grip" title="Drag to reorder" onClick={(e) => e.stopPropagation()}
        {...drag.listeners} {...drag.attributes}>
        <GripVertical size={15} />
      </span>
      <span className="row-main">
        <span className="row-title"><PriorityBadge task={task} />{task.title}</span>
      </span>
      <span className="row-meta">
        <span className="chip mono">#{task.id}</span>
        <DueChip task={task} />
        {task.tags.map((g) => <span key={g} className="chip mono">{g}</span>)}
        <span className="row-assignee" title={task.assignee ? who(task.assignee) : "Unassigned"}>
          {task.assignee && <Avatar actor={task.assignee} size={20} />}
        </span>
      </span>
      <span className="backlog-actions" onClick={(e) => e.stopPropagation()}>
        <select className="prio-select" value={task.priority} aria-label="Priority" title="Priority"
          onChange={(e) => onPriority(e.target.value as Priority)}>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
        </select>
        <button type="button" className="btn small" onClick={onPromote} title="Move to To do">To do<ArrowRight size={14} /></button>
        <IconButton label="Cancel task" className="danger" onClick={onCancel}><X size={15} /></IconButton>
      </span>
    </li>
  );
}

function EndZone({ projectId, disabled, over }: { projectId: number; disabled: boolean; over: boolean }) {
  const { setNodeRef } = useDroppable({ id: endDrop(projectId), disabled });
  return <li ref={setNodeRef} className={`backlog-end ${over ? "drop-before" : ""}`} aria-hidden />;
}

export function Backlog({ projects, tasks, filtered, projectId, onOpenTask, onAdd, onUpdate, onReorder }: {
  projects: Project[];
  tasks: Task[]; // already filtered
  filtered: boolean;
  projectId?: number;
  onOpenTask: (id: number) => void;
  onAdd: (p: Project) => void;
  onUpdate: (task: Task, patch: Partial<Pick<Task, "status" | "priority" | "position">>) => void;
  onReorder: (positions: Record<number, number>) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );
  const [folded, setFolded] = useState<Set<number>>(new Set());
  const [activeId, setActiveId] = useState<number | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const backlog = tasks.filter((t) => t.status === "backlog");
  const shown = projectId ? projects.filter((p) => p.id === projectId) : projects;
  // Projects with an empty backlog are left out, except a picked one, so it can still be added to.
  const groups = shown
    .map((p) => ({ project: p, tasks: backlog.filter((t) => t.project_id === p.id).sort(byPosition) }))
    .filter((g) => g.tasks.length > 0 || (!filtered && g.project.id === projectId));
  const active = backlog.find((t) => t.id === activeId);

  // A position between the new neighbours; if they tie, renumber the group instead.
  const placeAt = (task: Task, list: Task[], before: number | null) => {
    const rest = list.filter((t) => t.id !== task.id);
    const i = before === null ? rest.length : rest.findIndex((t) => t.id === before);
    if (i < 0) return {};
    const prev = rest[i - 1], next = rest[i];
    if (!prev && !next) return {};
    const p = prev && next ? (prev.position + next.position) / 2 : prev ? prev.position + 1 : next.position - 1;
    if ((!prev || p > prev.position) && (!next || p < next.position)) return { [task.id]: p };
    const order = [...rest.slice(0, i), task, ...rest.slice(i)];
    return Object.fromEntries(order.map((t, k) => [t.id, k + 1]));
  };

  const onDragStart = (e: DragStartEvent) => setActiveId(Number(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    setOverId(null);
    const task = backlog.find((t) => t.id === e.active.id);
    const over = e.over?.id as string | undefined;
    if (!task || !over) return;
    const list = groups.find((g) => g.project.id === task.project_id)?.tasks ?? [];
    const before = over.startsWith("row-") ? Number(over.slice(4)) : null;
    if (before === task.id) return;
    // Dropping a row back into its own slot is no move at all.
    const i = list.findIndex((t) => t.id === task.id);
    if (before === (list[i + 1]?.id ?? null)) return;
    const positions = placeAt(task, list, before);
    if (Object.keys(positions).length) onReorder(positions);
  };

  // New work lands at the bottom of To do, below what's already planned.
  const promote = (task: Task) => {
    const todo = tasks.filter((t) => t.project_id === task.project_id && t.status === "todo");
    const end = todo.reduce((m, t) => Math.max(m, t.position), 0) + 1;
    onUpdate(task, { status: "todo", position: end });
  };

  if (groups.length === 0) {
    return (
      <div className="list-view">
        <div className="empty">
          <Inbox size={32} strokeWidth={1.5} />
          <p>{filtered ? "No backlog tasks match these filters." : "The backlog is empty."}</p>
        </div>
      </div>
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={onDragStart} onDragEnd={onDragEnd}
      onDragOver={(e) => setOverId((e.over?.id as string | undefined) ?? null)}
      onDragCancel={() => { setActiveId(null); setOverId(null); }}>
      <div className="list-view backlog-view">
        {groups.map(({ project, tasks: list }) => {
          const shut = folded.has(project.id);
          const toggle = () => setFolded((f) => {
            const next = new Set(f);
            if (next.has(project.id)) next.delete(project.id);
            else next.add(project.id);
            return next;
          });
          // Rows only move within their own project.
          const disabled = !!active && active.project_id !== project.id;
          return (
            <section key={project.id} className={`group ${shut ? "folded" : ""}`}>
              <header className="group-head">
                <IconButton label={shut ? `Expand ${project.name}` : `Fold ${project.name}`} onClick={toggle}>
                  <ChevronDown size={16} className="fold-icon" />
                </IconButton>
                <div className="group-title"><h2>{project.name}</h2></div>
                <span className="group-stats">{list.length} in backlog</span>
              </header>
              {!shut && (
                <ul className="rows">
                  {list.map((t, i) => (
                    <Row key={t.id} task={t} index={i} disabled={disabled} over={!!active && overId === rowDrop(t.id) && active.id !== t.id}
                      onOpen={() => onOpenTask(t.id)} onPromote={() => promote(t)}
                      onPriority={(priority) => onUpdate(t, { priority })} onCancel={() => onUpdate(t, { status: "cancelled" })} />
                  ))}
                  {active && !disabled && <EndZone projectId={project.id} disabled={disabled} over={overId === endDrop(project.id)} />}
                  <li><button type="button" className="add-row" onClick={() => onAdd(project)}><Plus size={15} strokeWidth={2.5} />Add to backlog</button></li>
                </ul>
              )}
            </section>
          );
        })}
      </div>
      <DragOverlay dropAnimation={null}>
        {active && (
          <div className="backlog-row lifted">
            <span className="grip"><GripVertical size={15} /></span>
            <span className="row-main"><span className="row-title"><PriorityBadge task={active} />{active.title}</span></span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
