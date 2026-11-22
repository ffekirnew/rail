"""FastAPI app: the JSON API under /api, and the built UI at /.

Who made a change comes from the X-Rail-Agent / X-Rail-Model headers that the
CLI sends (CLIs from before the rename send X-Ffloom-*, which still work). A request without them (the UI) is the user. Nothing is verified:
the CLI runs only on the server and Cloudflare Access gates the UI.
"""

import json
import sqlite3
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from . import PRIORITIES, STATUSES, db, env

DB_PATH = env("DB", "rail.db")
WEB_DIR = Path(env("WEB_DIR") or Path(__file__).parent / "web")

Status = Literal["backlog", "todo", "in_progress", "blocked", "done", "cancelled"]
Priority = Literal["low", "medium", "high", "urgent"]


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


# --- request models ---------------------------------------------------------


class Actor(BaseModel):
    kind: Literal["user", "agent"]
    agent: str | None = None
    model: str | None = None


class Assignee(Actor):
    pass


def check_date(v: str | None) -> str | None:
    if v is not None:
        date.fromisoformat(v)
    return v


def clean_tags(tags: list[str]) -> list[str]:
    out: list[str] = []
    for t in tags:
        t = t.strip().lstrip("#")
        if t and t.lower() not in (x.lower() for x in out):
            out.append(t)
    return out


class ProjectIn(BaseModel):
    name: str = Field(min_length=1)
    description: str = ""


class ProjectPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    description: str | None = None


class TaskIn(BaseModel):
    project_id: int
    title: str = Field(min_length=1)
    description: str = ""
    status: Status = "todo"
    priority: Priority = "medium"
    due_date: str | None = None
    assignee: Assignee | None = None
    tags: list[str] = []

    _due = field_validator("due_date")(check_date)


class TaskPatch(BaseModel):
    project_id: int | None = None
    title: str | None = Field(default=None, min_length=1)
    description: str | None = None
    status: Status | None = None
    priority: Priority | None = None
    due_date: str | None = None
    assignee: Assignee | None = None
    tags: list[str] | None = None
    add_tags: list[str] = []
    remove_tags: list[str] = []
    position: float | None = None

    _due = field_validator("due_date")(check_date)


class CommentIn(BaseModel):
    body: str = Field(min_length=1)


# --- dependencies -----------------------------------------------------------


def get_conn():
    conn = db.connect(DB_PATH)
    try:
        yield conn
    finally:
        conn.close()


def get_actor(
    x_rail_agent: Annotated[str | None, Header()] = None,
    x_rail_model: Annotated[str | None, Header()] = None,
    x_ffloom_agent: Annotated[str | None, Header()] = None,
    x_ffloom_model: Annotated[str | None, Header()] = None,
) -> Actor:
    agent, model = (x_rail_agent, x_rail_model) if x_rail_agent else (x_ffloom_agent, x_ffloom_model)
    if agent:
        return Actor(kind="agent", agent=agent, model=model or None)
    return Actor(kind="user")


Conn = Annotated[sqlite3.Connection, Depends(get_conn)]
Who = Annotated[Actor, Depends(get_actor)]


# --- helpers ----------------------------------------------------------------


def project_row(conn, project_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    if row is None:
        raise HTTPException(404, f"project {project_id} not found")
    return row


def project_dict(row: sqlite3.Row, counts: dict | None = None) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "created_at": row["created_at"],
        "counts": counts or {},
    }


def assignee_dict(kind, agent, model) -> dict | None:
    if kind is None:
        return None
    return {"kind": kind, "agent": agent, "model": model}


def task_dict(conn, row: sqlite3.Row) -> dict:
    tags = [r[0] for r in conn.execute("SELECT tag FROM task_tags WHERE task_id = ? ORDER BY tag", (row["id"],))]
    latest = conn.execute("SELECT * FROM comments WHERE task_id = ? ORDER BY id DESC LIMIT 1", (row["id"],)).fetchone()
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "project": row["project_name"],
        "title": row["title"],
        "description": row["description"],
        "status": row["status"],
        "priority": row["priority"],
        "due_date": row["due_date"],
        "assignee": assignee_dict(row["assignee_kind"], row["assignee_agent"], row["assignee_model"]),
        "tags": tags,
        "latest_comment": latest and {
            "id": latest["id"], "body": latest["body"], "actor": actor_dict(latest), "created_at": latest["created_at"],
        },
        "position": row["position"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


TASK_SELECT = "SELECT t.*, p.name AS project_name FROM tasks t JOIN projects p ON p.id = t.project_id"


def task_row(conn, task_id: int) -> sqlite3.Row:
    row = conn.execute(f"{TASK_SELECT} WHERE t.id = ?", (task_id,)).fetchone()
    if row is None:
        raise HTTPException(404, f"task {task_id} not found")
    return row


def record(conn, actor: Actor, kind: str, *, task_id=None, project_id=None, task_title=None, data=None) -> None:
    conn.execute(
        "INSERT INTO events (task_id, project_id, task_title, kind, data, actor_kind, actor_agent, actor_model, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (task_id, project_id, task_title, kind, json.dumps(data or {}), actor.kind, actor.agent, actor.model, now()),
    )


def actor_dict(row) -> dict:
    return {"kind": row["actor_kind"], "agent": row["actor_agent"], "model": row["actor_model"]}


def event_dict(row) -> dict:
    return {
        "id": row["id"],
        "task_id": row["task_id"],
        "task_title": row["task_title"],
        "project_id": row["project_id"],
        "project": row["project_name"],
        "kind": row["kind"],
        "data": json.loads(row["data"]),
        "actor": actor_dict(row),
        "created_at": row["created_at"],
    }


EVENT_SELECT = "SELECT e.*, p.name AS project_name FROM events e LEFT JOIN projects p ON p.id = e.project_id"


def set_tags(conn, task_id: int, tags: list[str]) -> None:
    conn.execute("DELETE FROM task_tags WHERE task_id = ?", (task_id,))
    conn.executemany("INSERT INTO task_tags (task_id, tag) VALUES (?, ?)", [(task_id, t) for t in tags])


def unique_name(conn, name: str, exclude_id: int | None = None) -> None:
    row = conn.execute("SELECT id FROM projects WHERE name = ?", (name,)).fetchone()
    if row and row["id"] != exclude_id:
        raise HTTPException(409, f"a project named {name!r} already exists")


# --- app --------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.migrate(DB_PATH)
    yield


app = FastAPI(title="rail", lifespan=lifespan)


@app.get("/api/health")
def health(conn: Conn):
    conn.execute("SELECT 1")
    return {"ok": True}


@app.get("/api/meta")
def meta():
    return {"statuses": STATUSES, "priorities": PRIORITIES}


@app.get("/api/projects")
def list_projects(conn: Conn):
    counts: dict[int, dict] = {}
    for r in conn.execute("SELECT project_id, status, COUNT(*) n FROM tasks GROUP BY project_id, status"):
        counts.setdefault(r["project_id"], {})[r["status"]] = r["n"]
    rows = conn.execute("SELECT * FROM projects ORDER BY name").fetchall()
    return [project_dict(r, counts.get(r["id"])) for r in rows]


@app.post("/api/projects", status_code=201)
def create_project(body: ProjectIn, conn: Conn, actor: Who):
    name = body.name.strip()
    unique_name(conn, name)
    with conn:
        cur = conn.execute(
            "INSERT INTO projects (name, description, created_at) VALUES (?, ?, ?)", (name, body.description, now())
        )
        record(conn, actor, "project_created", project_id=cur.lastrowid, data={"name": name})
    return project_dict(project_row(conn, cur.lastrowid))


@app.patch("/api/projects/{project_id}")
def update_project(project_id: int, body: ProjectPatch, conn: Conn, actor: Who):
    old = project_row(conn, project_id)
    changes = {}
    if body.name is not None and body.name.strip() != old["name"]:
        unique_name(conn, body.name.strip(), project_id)
        changes["name"] = [old["name"], body.name.strip()]
    if body.description is not None and body.description != old["description"]:
        changes["description"] = [old["description"], body.description]
    if changes:
        with conn:
            for field, (_, new) in changes.items():
                conn.execute(f"UPDATE projects SET {field} = ? WHERE id = ?", (new, project_id))
            record(conn, actor, "project_updated", project_id=project_id, data={"changes": changes})
    return project_dict(project_row(conn, project_id))


@app.delete("/api/projects/{project_id}", status_code=204)
def delete_project(project_id: int, conn: Conn, actor: Who):
    old = project_row(conn, project_id)
    with conn:
        n = conn.execute("SELECT COUNT(*) FROM tasks WHERE project_id = ?", (project_id,)).fetchone()[0]
        conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        record(conn, actor, "project_deleted", data={"name": old["name"], "tasks": n})


@app.get("/api/tasks")
def list_tasks(
    conn: Conn,
    project_id: int | None = None,
    status: Annotated[list[Status] | None, Query()] = None,
    tag: str | None = None,
    assignee_kind: Literal["user", "agent", "none"] | None = None,
    assignee_agent: str | None = None,
    q: str | None = None,
):
    where, args = [], []
    if project_id is not None:
        where.append("t.project_id = ?")
        args.append(project_id)
    if status:
        where.append(f"t.status IN ({','.join('?' * len(status))})")
        args += status
    if tag:
        where.append("EXISTS (SELECT 1 FROM task_tags g WHERE g.task_id = t.id AND g.tag = ?)")
        args.append(tag.lstrip("#"))
    if assignee_kind == "none":
        where.append("t.assignee_kind IS NULL")
    elif assignee_kind:
        where.append("t.assignee_kind = ?")
        args.append(assignee_kind)
    if assignee_agent:
        where.append("t.assignee_agent = ? COLLATE NOCASE")
        args.append(assignee_agent)
    if q:
        where.append("(t.title LIKE ? OR t.description LIKE ?)")
        args += [f"%{q}%", f"%{q}%"]
    sql = TASK_SELECT + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY t.position, t.id"
    return [task_dict(conn, r) for r in conn.execute(sql, args).fetchall()]


@app.post("/api/tasks", status_code=201)
def create_task(body: TaskIn, conn: Conn, actor: Who):
    project_row(conn, body.project_id)
    a = body.assignee
    ts = now()
    with conn:
        pos = conn.execute("SELECT COALESCE(MAX(position), 0) + 1 FROM tasks").fetchone()[0]
        cur = conn.execute(
            "INSERT INTO tasks (project_id, title, description, status, priority, due_date,"
            " assignee_kind, assignee_agent, assignee_model, position, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                body.project_id, body.title.strip(), body.description, body.status, body.priority, body.due_date,
                a.kind if a else None, a.agent if a else None, a.model if a else None, pos, ts, ts,
            ),
        )
        set_tags(conn, cur.lastrowid, clean_tags(body.tags))
        record(
            conn, actor, "created", task_id=cur.lastrowid, project_id=body.project_id, task_title=body.title.strip(),
            data={"status": body.status},
        )
    return task_dict(conn, task_row(conn, cur.lastrowid))


@app.get("/api/tasks/{task_id}")
def get_task(task_id: int, conn: Conn):
    out = task_dict(conn, task_row(conn, task_id))
    out["comments"] = [
        {"id": r["id"], "body": r["body"], "actor": actor_dict(r), "created_at": r["created_at"]}
        for r in conn.execute("SELECT * FROM comments WHERE task_id = ? ORDER BY id", (task_id,))
    ]
    out["history"] = [
        event_dict(r) for r in conn.execute(f"{EVENT_SELECT} WHERE e.task_id = ? ORDER BY e.id", (task_id,))
    ]
    return out


@app.patch("/api/tasks/{task_id}")
def update_task(task_id: int, body: TaskPatch, conn: Conn, actor: Who):
    old = task_row(conn, task_id)
    old_task = task_dict(conn, old)
    sent = body.model_fields_set
    changes: dict[str, list] = {}
    updates: dict[str, object] = {}

    for field in ("title", "description", "status", "priority", "due_date", "project_id"):
        if field in sent:
            new = getattr(body, field)
            if new is None and field != "due_date":
                continue
            if isinstance(new, str) and field == "title":
                new = new.strip()
            if new != old[field]:
                updates[field] = new
                changes[field] = [old[field], new]
    if "project_id" in updates:
        new_project = project_row(conn, updates["project_id"])
        changes["project"] = [old["project_name"], new_project["name"]]
        del changes["project_id"]

    if "assignee" in sent:
        a = body.assignee
        new_a = assignee_dict(a.kind, a.agent, a.model) if a else None
        if new_a != old_task["assignee"]:
            updates.update(
                assignee_kind=a.kind if a else None,
                assignee_agent=a.agent if a else None,
                assignee_model=a.model if a else None,
            )
            changes["assignee"] = [old_task["assignee"], new_a]

    tags = old_task["tags"]
    if body.tags is not None:
        tags = clean_tags(body.tags)
    tags = clean_tags(tags + body.add_tags)
    removed = {t.lstrip("#").lower() for t in body.remove_tags}
    tags = [t for t in tags if t.lower() not in removed]
    if sorted(t.lower() for t in tags) != sorted(t.lower() for t in old_task["tags"]):
        changes["tags"] = [old_task["tags"], tags]

    if body.position is not None and body.position != old["position"]:
        updates["position"] = body.position

    if updates or "tags" in changes:
        with conn:
            # Reordering isn't an update either: Done is sorted by when tasks were finished.
            if changes:
                updates["updated_at"] = now()
            cols = ", ".join(f"{k} = ?" for k in updates)
            conn.execute(f"UPDATE tasks SET {cols} WHERE id = ?", (*updates.values(), task_id))
            if "tags" in changes:
                set_tags(conn, task_id, tags)
            # A drag that only reorders cards isn't worth an entry in the feed.
            if changes:
                record(
                    conn, actor, "updated", task_id=task_id,
                    project_id=updates.get("project_id", old["project_id"]),
                    task_title=updates.get("title", old["title"]), data={"changes": changes},
                )
    return task_dict(conn, task_row(conn, task_id))


@app.delete("/api/tasks/{task_id}", status_code=204)
def delete_task(task_id: int, conn: Conn, actor: Who):
    old = task_row(conn, task_id)
    with conn:
        conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        record(conn, actor, "deleted", task_id=task_id, project_id=old["project_id"], task_title=old["title"])


@app.post("/api/tasks/{task_id}/comments", status_code=201)
def add_comment(task_id: int, body: CommentIn, conn: Conn, actor: Who):
    old = task_row(conn, task_id)
    ts = now()
    with conn:
        cur = conn.execute(
            "INSERT INTO comments (task_id, body, actor_kind, actor_agent, actor_model, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (task_id, body.body, actor.kind, actor.agent, actor.model, ts),
        )
        record(
            conn, actor, "commented", task_id=task_id, project_id=old["project_id"], task_title=old["title"],
            data={"comment_id": cur.lastrowid, "body": body.body},
        )
    return {"id": cur.lastrowid, "body": body.body, "actor": actor.model_dump(), "created_at": ts}


@app.get("/api/activity")
def activity(
    conn: Conn,
    limit: Annotated[int, Query(ge=1, le=500)] = 50,
    before_id: int | None = None,
    project_id: int | None = None,
):
    where, args = [], []
    if before_id is not None:
        where.append("e.id < ?")
        args.append(before_id)
    if project_id is not None:
        where.append("e.project_id = ?")
        args.append(project_id)
    sql = EVENT_SELECT + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY e.id DESC LIMIT ?"
    return [event_dict(r) for r in conn.execute(sql, (*args, limit))]


if WEB_DIR.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
