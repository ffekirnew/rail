import { Contrast, FolderPlus, Keyboard, Moon, Plus, Search, Sun, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Activity } from "./Activity";
import { Actor, Project, STATUSES, Status, Task, api, relTime } from "./api";
import { Board } from "./Board";
import { CHIPS, Chip, EMPTY_FILTERS, Filters, isOverdue, matches } from "./filters";
import { ProjectDialog } from "./ProjectDialog";
import { Projects } from "./Projects";
import { TaskModal, keyOf } from "./TaskModal";
import { ConfirmDialog, Dialog, IconButton, Select, StatusDot } from "./ui";

type View = "board" | "projects" | "activity";
type Theme = "system" | "light" | "dark";

const VIEWS: { id: View; label: string }[] = [
  { id: "board", label: "Board" },
  { id: "projects", label: "Projects" },
  { id: "activity", label: "Activity" },
];

const THEMES: { id: Theme; label: string; icon: typeof Sun }[] = [
  { id: "light", label: "Light", icon: Sun },
  { id: "system", label: "Match system", icon: Contrast },
  { id: "dark", label: "Dark", icon: Moon },
];

const SHORTCUTS: [string, string][] = [
  ["/", "Search"],
  ["n", "New task"],
  ["1 · 2 · 3", "Board · Projects · Activity"],
  ["?", "Show shortcuts"],
  ["Esc", "Close a dialog or clear search"],
];

// Kanban on desktop, the activity feed on narrow screens; every view is reachable from the tabs.
const defaultView = (): View => (window.matchMedia("(max-width: 700px)").matches ? "activity" : "board");

// Settings saved before the rename live under ffloom.* keys; callers pass those as the fallback.
function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

// The app icon's mark (web/public/favicon.svg) without its tile: a track running to a goal.
function TrackMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
      <g fill="none" stroke="currentColor" strokeLinecap="round">
        <path d="M11 25.5 13.7 10.5M21 25.5 18.3 10.5" strokeWidth="2.25" />
        <path d="M9 21.5h14M10.6 15.5h10.8" strokeWidth="1.8" strokeOpacity=".7" />
      </g>
      <circle cx="16" cy="6.8" r="2" fill="currentColor" />
    </svg>
  );
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const defaultCollapsed = (ts: Task[]) => new Set(STATUSES.filter((s) => s === "done" || !ts.some((t) => t.status === s)));

const applyTheme = (theme: Theme) => {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
};

const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));

export function App() {
  const [view, setView] = useState<View>(defaultView);
  const [projects, setProjects] = useState<Project[]>([]);
  // Every task is loaded once and filtered here: one person's board is small.
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [filters, setFilters] = useState<Filters>(() => ({ ...EMPTY_FILTERS, projectId: load("rail.project", load("ffloom.project", undefined)) ?? undefined }));
  // a task id, or what a new task starts with
  const [open, setOpen] = useState<number | { status: Status; projectId?: number } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => load("rail.theme", load("ffloom.theme", "system")));
  // Columns start collapsed when they're Done or empty, worked out again whenever the project changes.
  const [collapsed, setCollapsed] = useState<Set<Status> | null>(null);
  // { project } edits one, {} creates one
  const [projectDialog, setProjectDialog] = useState<{ project?: Project } | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const tabsRef = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);

  const onError = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const refresh = () => setRefreshKey((k) => k + 1);
  const setFilter = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    Promise.all([api.projects(), api.tasks()]).then(([ps, ts]) => {
      setProjects(ps);
      setTasks(ts);
      if (filters.projectId && !ps.some((p) => p.id === filters.projectId)) setFilter("projectId", undefined);
    }).catch(onError);
  }, [refreshKey]);

  useEffect(() => setCollapsed(null), [filters.projectId]);
  useEffect(() => {
    if (tasks && collapsed === null) {
      setCollapsed(defaultCollapsed(tasks.filter((t) => !filters.projectId || t.project_id === filters.projectId)));
    }
  }, [tasks, collapsed]);

  useEffect(() => {
    applyTheme(theme);
    save("rail.theme", theme);
  }, [theme]);

  // The tab pill slides to the active tab; it's measured again when the header reflows.
  useLayoutEffect(() => {
    const nav = tabsRef.current;
    if (!nav) return;
    const place = () => {
      const b = nav.querySelector<HTMLElement>("button.active");
      if (b) setPill({ x: b.offsetLeft, w: b.offsetWidth });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [view]);

  // Crossfade the whole page between themes where the browser supports view transitions.
  const changeTheme = (t: Theme) => {
    if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) return setTheme(t);
    document.startViewTransition(() => {
      applyTheme(t);
      flushSync(() => setTheme(t));
    });
  };

  useEffect(() => save("rail.project", filters.projectId ?? null), [filters.projectId]);

  // No live updates yet: pick up agents' changes when the tab comes back into focus.
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const dialogOpen = open !== null || projectDialog !== null || deleting !== null || showShortcuts;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape" && e.target === searchRef.current) { setFilter("search", ""); searchRef.current?.blur(); return; }
      if (dialogOpen || typing(e.target)) return;
      if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === "n" && projects.length) { e.preventDefault(); setOpen({ status: "todo" }); }
      else if (e.key === "?") setShowShortcuts(true);
      else if (["1", "2", "3"].includes(e.key)) setView(VIEWS[Number(e.key) - 1].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialogOpen, projects.length]);

  const all = tasks ?? [];
  const inProject = useMemo(() => all.filter((t) => !filters.projectId || t.project_id === filters.projectId), [all, filters.projectId]);
  const shown = useMemo(() => all.filter((t) => matches(t, filters)), [all, filters]);
  const lastChange = useMemo(() => all.reduce<string | null>((m, t) => (!m || t.updated_at > m ? t.updated_at : m), null), [all]);

  const knownAgents = useMemo(() => {
    const seen = new Map<string, Actor>();
    for (const t of all) if (t.assignee?.kind === "agent") seen.set(keyOf(t.assignee), t.assignee);
    return [...seen.values()];
  }, [all]);

  const toggleColumn = (s: Status) => {
    const next = new Set(collapsed);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setCollapsed(next);
  };

  // A drag changes the card's column, its place in it, or both.
  const move = (task: Task, status: Status, positions: Record<number, number>) => {
    const moved = status !== task.status;
    const stamp = new Date().toISOString();
    setTasks(all.map((t) => ({
      ...t,
      ...(t.id === task.id && moved ? { status, updated_at: stamp } : {}),
      ...(t.id in positions ? { position: positions[t.id] } : {}),
    })));
    const patches = new Map<number, Record<string, unknown>>(Object.entries(positions).map(([id, position]) => [Number(id), { position }]));
    if (moved) patches.set(task.id, { ...patches.get(task.id), status });
    Promise.all([...patches].map(([id, patch]) => api.updateTask(id, patch)))
      .then(refresh).catch((e) => { onError(e); refresh(); });
  };

  const newProject = () => setProjectDialog({});
  const deleteProject = (p: Project) =>
    api.deleteProject(p.id).then(() => {
      if (filters.projectId === p.id) setFilter("projectId", undefined);
      refresh();
    }).catch(onError);
  const deletingCount = deleting ? all.filter((t) => t.project_id === deleting.id).length : 0;

  const chipsApply = view !== "activity";
  const anyFilter = !!filters.search || !!filters.projectId || (chipsApply && !!filters.chip);
  const count = (s: Status) => inProject.filter((t) => t.status === s).length;
  const overdue = inProject.filter(isOverdue).length;

  return (
    <div className={`app view-${view}`}>
      <div className="frame">
        <header className="top">
          <div className="brand">
            <span className="logo"><TrackMark /></span>
            <h1>rail</h1>
          </div>
          <nav className="tabs" role="tablist" aria-label="Views" ref={tabsRef}>
            {pill && <span className="tab-pill" style={{ width: pill.w, transform: `translateX(${pill.x}px)` }} aria-hidden />}
            {VIEWS.map(({ id, label }) => (
              <button key={id} role="tab" aria-selected={view === id} className={view === id ? "active" : ""} onClick={() => setView(id)}>
                {label}
              </button>
            ))}
          </nav>
          <div className="spacer" />
          <button className="btn primary" onClick={() => setOpen({ status: "todo" })} disabled={projects.length === 0}
            title={projects.length === 0 ? "Create a project first" : "New task (n)"}>
            <Plus size={15} strokeWidth={2.5} /><span>New task</span>
          </button>
          <div className="theme-switch" role="radiogroup" aria-label="Theme">
            {THEMES.map(({ id, label, icon: Icon }) => (
              <button key={id} role="radio" aria-checked={theme === id} title={label} aria-label={label}
                className={theme === id ? "active" : ""} onClick={() => changeTheme(id)}>
                <Icon size={14} strokeWidth={2.25} />
              </button>
            ))}
          </div>
        </header>

        {projects.length > 0 && (
          <div className="filters">
            <label className="search">
              <Search size={15} aria-hidden />
              <input ref={searchRef} type="search" placeholder={view === "activity" ? "Search activity" : "Search cards"}
                value={filters.search} aria-label="Search" onChange={(e) => setFilter("search", e.target.value)} />
              <kbd>/</kbd>
            </label>
            <Select value={filters.projectId ?? ""} aria-label="Project" className={filters.projectId ? "set" : ""}
              onChange={(e) => setFilter("projectId", e.target.value ? Number(e.target.value) : undefined)}>
              <option value="">All projects</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
            {chipsApply && CHIPS.map(({ id, label, icon: Icon, test }) => {
              const on = filters.chip === id;
              return (
                <button key={id} type="button" className={`quick ${on ? "on" : ""}`} aria-pressed={on}
                  onClick={() => setFilter("chip", on ? undefined : (id as Chip))}>
                  <Icon size={14} strokeWidth={2.25} />{label}<span className="n">{inProject.filter(test).length}</span>
                </button>
              );
            })}
            {anyFilter && <button className="btn ghost" onClick={() => setFilters(EMPTY_FILTERS)}><X size={14} />Clear</button>}
          </div>
        )}

        <main key={view}>
          {tasks === null ? null : projects.length === 0 ? (
            <div className="empty">
              <FolderPlus size={32} strokeWidth={1.5} />
              <p>No projects yet.</p>
              <button className="btn primary" onClick={newProject}><Plus size={16} strokeWidth={2.5} />New project</button>
            </div>
          ) : view === "board" ? (
            <Board
              tasks={shown} showProject={!filters.projectId} collapsed={collapsed ?? new Set()}
              onToggle={toggleColumn} onOpen={setOpen} onMove={move} onAdd={(status) => setOpen({ status })}
            />
          ) : view === "projects" ? (
            <Projects
              projects={projects} tasks={shown} filtered={!!filters.search || !!filters.chip} projectId={filters.projectId}
              onOpenTask={setOpen} onAdd={(p) => setOpen({ status: "todo", projectId: p.id })}
              onNew={newProject} onEdit={(p) => setProjectDialog({ project: p })} onDelete={setDeleting}
            />
          ) : (
            <Activity projectId={filters.projectId} search={filters.search} refreshKey={refreshKey} onOpen={setOpen} onError={onError} />
          )}
        </main>

        <footer className="bottom">
          <span className="footer-stats">
            <span><StatusDot status="todo" /><strong>{count("todo")}</strong> to do</span>
            <span><StatusDot status="in_progress" /><strong>{count("in_progress")}</strong> in progress</span>
            <span><StatusDot status="blocked" /><strong>{count("blocked")}</strong> blocked</span>
            {overdue > 0 && <span className="bad"><strong>{overdue}</strong> overdue</span>}
          </span>
          <span className="spacer" />
          {lastChange && <span className="last-change"><span className="live" />Last change {relTime(lastChange)}</span>}
          <button type="button" className="btn ghost small" onClick={() => setShowShortcuts(true)}>
            <Keyboard size={14} /><span>Shortcuts</span><kbd>?</kbd>
          </button>
        </footer>
      </div>

      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <IconButton label="Dismiss" onClick={() => setError(null)}><X size={16} /></IconButton>
        </div>
      )}

      {showShortcuts && (
        <Dialog title="Keyboard shortcuts" onClose={() => setShowShortcuts(false)} onSubmit={() => setShowShortcuts(false)}
          actions={<button type="submit" className="btn">Close</button>}>
          <dl className="shortcuts">
            {SHORTCUTS.map(([k, what]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{what}</dd></div>)}
          </dl>
        </Dialog>
      )}
      {projectDialog && (
        <ProjectDialog
          project={projectDialog.project}
          onClose={() => setProjectDialog(null)}
          onSaved={(p) => { if (!projectDialog.project) setFilter("projectId", p.id); refresh(); }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          message={deletingCount
            ? <>This deletes the project and its <strong>{deletingCount} {deletingCount === 1 ? "task" : "tasks"}</strong>, with their comments. It can't be undone.</>
            : "This can't be undone."}
          confirmLabel="Delete project"
          onConfirm={() => deleteProject(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
      {open !== null && (
        <TaskModal
          key={typeof open === "number" ? open : `new-${open.status}-${open.projectId ?? ""}`}
          taskId={typeof open === "number" ? open : null}
          defaultStatus={typeof open === "number" ? undefined : open.status}
          projects={projects}
          defaultProjectId={(typeof open === "number" ? undefined : open.projectId) ?? filters.projectId}
          knownAgents={knownAgents}
          onClose={() => setOpen(null)}
          onChanged={refresh}
          onError={onError}
        />
      )}
    </div>
  );
}
