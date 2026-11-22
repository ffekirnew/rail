# rail

A task board for one person and their AI agents. The user works in the web UI; agents use the `rail` CLI. Every change records who made it (an agent + model, or the user). `README.md` covers install, run and the ffloom upgrade path; this file holds the rules and facts for working on it.

## Layout

- `src/rail/server.py`: FastAPI app. JSON API under `/api` (`/api/health`, `/api/meta`, projects, tasks, comments, activity) and the built UI at `/` from `RAIL_WEB_DIR`.
- `src/rail/db.py`: SQLite. One connection per request, WAL, `foreign_keys` on. Schema upgrades are the append-only `MIGRATIONS` list, applied by `PRAGMA user_version` on startup. Add a new entry; never edit an old one.
- `src/rail/cli.py`: the `rail` CLI. **Standard library only** (`dependencies = []` in `pyproject.toml`), so a bare `uv tool install` works on an agent-only machine. Don't add imports from the `server`/`dev` extras.
- `src/rail/__init__.py`: `STATUSES` (`backlog todo in_progress blocked done cancelled`), `PRIORITIES` (`low medium high urgent`), and `env()`, which reads `RAIL_<name>` then `FFLOOM_<name>`.
- `web/`: React 19 + Vite + TypeScript UI (kanban board with one lane per project and per-lane collapsible columns, Backlog tab, task modal, projects view, activity feed; the board hides the Backlog column unless "Show backlog" is on). `@dnd-kit` for drag and drop, `marked` for Markdown, `lucide-react` icons. Dependencies are pinned to exact versions.
- `skill/rail/`, `skill/rail-plan/`: Claude Code skills, symlinked into `~/.claude/skills/`, so edits here go live for every agent at once.
- `tests/`: pytest (`test_api.py`, `test_cli.py`, `test_rename.py`).

## Rules

- **No deletes from agents.** The CLI has no delete command on purpose, and agents must not call `DELETE` on the API either. Only the user deletes, in the UI. Don't add a delete command to the CLI or skills.
- **No auth.** The server trusts every request: it doesn't verify the agent name. A request with `X-Rail-Agent` / `X-Rail-Model` is that agent; without them (the UI) it's the user. Access control lives in front of it (Cloudflare Access, localhost binding). Don't expose the port anywhere else.
- **Events have no foreign keys** so the activity feed keeps a deleted task's history.
- **Keep the ffloom fallbacks.** rail was called ffloom until 2026-11-20. These stay on purpose: `FFLOOM_*` env vars, `X-Ffloom-*` headers, renaming `ffloom.db` (and its `-wal`/`-shm`) to the configured DB on startup, and the UI's `ffloom.*` localStorage keys. `tests/test_rename.py` covers them.
- **Naming:** use "rail" everywhere new. The PyPI package is `railboard` (`rail` is taken); the command is `rail`.
- **Brand:** crimson accent (light `#b3123f`, dark `#f2577f`, on-accent `#ffffff` / `#2b0510`). Blocked/danger use a warmer scarlet so the two reds stay distinct. The icon is two rails converging on a dot; `web/public/favicon.svg` is the source, and the header logo in `App.tsx` is the same mark.

## Develop

```bash
uv venv && uv pip install -e '.[dev]'
.venv/bin/pytest
RAIL_DB=dev.db .venv/bin/uvicorn rail.server:app --port 8021 --reload
cd web && npm install && RAIL_API=http://127.0.0.1:8021 npx vite --port 5180   # RAIL_API defaults to :8020
cd web && npm run build                   # tsc --noEmit && vite build
```

Don't point a dev server at the production DB (`~/home-server/rail/rail.db`), and don't run the dev server on 8020: the production container holds that port. `dev.db` is gitignored; seed it through the API if it's empty.

### Workflow

1. Branch off `main` for each feature.
2. Run the API on 8021 and the UI on `http://localhost:5180` (commands above) and leave them running while the user tries changes; Vite reloads on save.
3. Iterate on the user's feedback; `npm run build` must pass (also run pytest after server or CLI changes).
4. When the user says it's done, commit, merge into `main` (no pull requests; the user doesn't use them) and delete the branch. Push and deploy only when asked (see Release and Deployment).

## Release

- `.github/workflows/image.yml`: every push and PR runs pytest and the web build. A push to `main` also publishes `ghcr.io/ffekirnew/rail:latest`; a `v*` tag publishes that version.
- `Dockerfile`: Node 24 builds `web/` → Python 3.13-slim installs `.[server]`, copies the UI to `/app/web`, runs `uvicorn rail.server:app --host 0.0.0.0 --port 8000 --proxy-headers` as uid 1000, with a healthcheck on `/api/health`. `RAIL_DB=/data/rail.db`.
- Repo: `github.com/ffekirnew/rail` (moved from `ffekirnew/ffloom`, which redirects). `ghcr.io/ffekirnew/ffloom` is stale.

## Deployment (`~/code/self-host`)

rail runs on the home server as the `rail` service in the self-host stack. Follow `~/code/self-host/CLAUDE.md` when changing anything there (it needs an RFC for structural changes; rail's are RFC-0010 and RFC-0011).

- `apps/rail/Dockerfile` is just `FROM ghcr.io/ffekirnew/rail:latest`. `apps/rail/bootstrap.sh` creates `~/home-server/rail`.
- `apps/compose.yaml`: container `rail`, uid `1000:1000`, on the external `proxy` network, port `127.0.0.1:8020:8000`, volume `~/home-server/rail:/data` (holds `rail.db`), `restart: unless-stopped`.
- Ways in:
  - Public: `https://rail.ffserver.cc` via the `cloudflared` tunnel, behind a Cloudflare Access app that lets in only the user (both set up by hand in Cloudflare).
  - Tailnet: `https://admin.tailfec431.ts.net:8020`, proxied by `admin-ts` (`admin-ts/serve.json` → `http://rail:8000`). It's the one admin-ts app without a login, by the user's choice.
  - Agents on the server: the `rail` CLI against `http://127.0.0.1:8020` (the CLI's default `RAIL_URL`).
- Glance (`monitoring/glance/config/glance.yml`) monitors `http://rail:8000/api/health`.
- Backups: `~/home-server/rail` is in the nightly restic backup to R2 (`backup/`). Restoring that folder is the only way to get deleted tasks back. Older copies sit next to the DB: `ffloom.pre-rail-2026-11-20.db`, `rail.pre-image-move-2026-11-21.db`.
- User-facing how-to: `docs/how-to/use-rail.md`; service table: `docs/reference/services.md`.

To ship a change: merge to `main`, wait for the image workflow, then in `~/code/self-host` run `docker compose build --pull rail && docker compose up -d rail` (or `make build && make up` for the whole stack). Migrations run when the container starts, so copy `rail.db` aside first if the change adds one. Server changes go out before CLI changes: an old server reads a newer CLI's headers as the user.

After a CLI or skill change, reinstall on the server with `uv tool install --reinstall ~/code/rail`. The skills are symlinks and need nothing.
