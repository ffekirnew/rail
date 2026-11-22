import pytest
from fastapi.testclient import TestClient

from rail import server

AGENT = {"X-Rail-Agent": "Claude Code", "X-Rail-Model": "Opus 5.5"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DB_PATH", str(tmp_path / "rail.db"))
    with TestClient(server.app) as c:
        yield c


@pytest.fixture
def project(client):
    return client.post("/api/projects", json={"name": "self-host"}).json()


def test_project_names_are_unique_ignoring_case(client, project):
    r = client.post("/api/projects", json={"name": "Self-Host"})
    assert r.status_code == 409


def test_create_task_records_agent_and_model(client, project):
    r = client.post(
        "/api/tasks", headers=AGENT,
        json={"project_id": project["id"], "title": "Upgrade Jellyfin", "tags": ["#coding", "coding", "urgent"]},
    )
    assert r.status_code == 201
    t = r.json()
    assert t["status"] == "todo" and t["priority"] == "medium"
    assert t["tags"] == ["coding", "urgent"]
    event = client.get(f"/api/tasks/{t['id']}").json()["history"][0]
    assert event["kind"] == "created"
    assert event["actor"] == {"kind": "agent", "agent": "Claude Code", "model": "Opus 5.5"}


def test_request_without_agent_headers_is_the_user(client, project):
    t = client.post("/api/tasks", json={"project_id": project["id"], "title": "Renew passport"}).json()
    assert client.get(f"/api/tasks/{t['id']}").json()["history"][0]["actor"]["kind"] == "user"


def test_patch_records_only_real_changes(client, project):
    t = client.post("/api/tasks", json={"project_id": project["id"], "title": "x", "due_date": "2026-12-01"}).json()
    client.patch(f"/api/tasks/{t['id']}", headers=AGENT, json={"status": "todo"})  # no-op
    client.patch(f"/api/tasks/{t['id']}", headers=AGENT, json={"position": 99})  # reorder only
    r = client.patch(
        f"/api/tasks/{t['id']}", headers=AGENT,
        json={"status": "blocked", "due_date": None, "add_tags": ["waiting"],
              "assignee": {"kind": "agent", "agent": "Codex", "model": "GPT-6.1-Sol"}},
    )
    task = r.json()
    assert task["status"] == "blocked" and task["due_date"] is None and task["tags"] == ["waiting"]
    assert task["position"] == 99
    history = client.get(f"/api/tasks/{t['id']}").json()["history"]
    assert [e["kind"] for e in history] == ["created", "updated"]
    changes = history[1]["data"]["changes"]
    assert changes["status"] == ["todo", "blocked"]
    assert changes["due_date"] == ["2026-12-01", None]
    assert changes["assignee"][1]["agent"] == "Codex"


def test_bad_values_are_rejected(client, project):
    base = {"project_id": project["id"], "title": "x"}
    assert client.post("/api/tasks", json={**base, "status": "review"}).status_code == 422
    assert client.post("/api/tasks", json={**base, "due_date": "next week"}).status_code == 422
    assert client.post("/api/tasks", json={**base, "project_id": 999}).status_code == 404


def test_filters(client, project):
    other = client.post("/api/projects", json={"name": "home"}).json()
    client.post("/api/tasks", json={"project_id": project["id"], "title": "a", "tags": ["coding"]})
    client.post("/api/tasks", json={"project_id": other["id"], "title": "b", "status": "done"})
    assert [t["title"] for t in client.get("/api/tasks", params={"tag": "#coding"}).json()] == ["a"]
    assert [t["title"] for t in client.get("/api/tasks", params={"status": ["done"]}).json()] == ["b"]
    assert [t["title"] for t in client.get("/api/tasks", params={"project_id": other["id"]}).json()] == ["b"]
    assert [t["title"] for t in client.get("/api/tasks", params={"assignee_kind": "none"}).json()] == ["a", "b"]


def test_tasks_carry_their_latest_comment(client, project):
    t = client.post("/api/tasks", json={"project_id": project["id"], "title": "x"}).json()
    assert t["latest_comment"] is None
    client.post(f"/api/tasks/{t['id']}/comments", json={"body": "first"})
    client.post(f"/api/tasks/{t['id']}/comments", headers=AGENT, json={"body": "waiting on the bank"})
    [listed] = client.get("/api/tasks").json()
    assert listed["latest_comment"]["body"] == "waiting on the bank"
    assert listed["latest_comment"]["actor"]["agent"] == "Claude Code"


def test_delete_keeps_the_event_in_activity(client, project):
    t = client.post("/api/tasks", json={"project_id": project["id"], "title": "gone"}).json()
    client.post(f"/api/tasks/{t['id']}/comments", headers=AGENT, json={"body": "hi"})
    assert client.delete(f"/api/tasks/{t['id']}").status_code == 204
    assert client.get(f"/api/tasks/{t['id']}").status_code == 404
    feed = client.get("/api/activity").json()
    assert [e["kind"] for e in feed] == ["deleted", "commented", "created", "project_created"]
    assert feed[0]["task_title"] == "gone" and feed[0]["project"] == "self-host"


def test_activity_paginates(client, project):
    for i in range(5):
        client.post("/api/tasks", json={"project_id": project["id"], "title": str(i)})
    page = client.get("/api/activity", params={"limit": 2}).json()
    older = client.get("/api/activity", params={"limit": 2, "before_id": page[-1]["id"]}).json()
    assert [e["task_title"] for e in page + older] == ["4", "3", "2", "1"]


def test_reorder_keeps_updated_at(client, project):
    t = client.post("/api/tasks", json={"project_id": project["id"], "title": "x"}).json()
    r = client.patch(f"/api/tasks/{t['id']}", json={"position": 0.5}).json()
    assert r["position"] == 0.5 and r["updated_at"] == t["updated_at"]
