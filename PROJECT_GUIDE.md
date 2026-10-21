# CodeTogether — From Local Prototype to Auto-Deploying Cloud App

This document explains **everything** we did to take your project from a basic
real-time editor to a fully deployed, auto-deploying cloud application — every
command, every decision, and *why*. Read it top to bottom to understand the
whole journey, or jump to a section.

---

## Table of contents

1. [What you started with](#1-what-you-started-with)
2. [The plan and the four gaps](#2-the-plan-and-the-four-gaps)
3. [Core idea: environment variables everywhere](#3-core-idea-environment-variables-everywhere)
4. [Phase 1 — Rooms by code](#4-phase-1--rooms-by-code)
5. [Phase 2 — MongoDB persistence](#5-phase-2--mongodb-persistence)
6. [Phase 4 — File uploads to S3](#6-phase-4--file-uploads-to-s3)
7. [Phase 5 — docker-compose (the local stack)](#7-phase-5--docker-compose-the-local-stack)
8. [Git hygiene & pushing to GitHub](#8-git-hygiene--pushing-to-github)
9. [Phase 6 — Deploying to AWS](#9-phase-6--deploying-to-aws)
10. [Phase 7 — GitHub Actions CI/CD](#10-phase-7--github-actions-cicd)
11. [Every gotcha we hit (and the fix)](#11-every-gotcha-we-hit-and-the-fix)
12. [Command reference](#12-command-reference)
13. [Architecture at a glance](#13-architecture-at-a-glance)
14. [Outstanding security hardening](#14-outstanding-security-hardening)
15. [How to operate it from now on](#15-how-to-operate-it-from-now-on)

---

## 1. What you started with

A **real-time collaborative code editor** — like a stripped-down Google Docs
for code:

- **Frontend** (`Docker-AWS/frontend`): React + Vite + the **Monaco** editor
  (the editor VS Code uses). It used **Yjs** (a CRDT library that lets many
  people edit the same document at once without conflicts) and **y-socket.io**
  to sync edits over websockets. You typed a name, hit Join, and saw a shared
  editor plus a live list of connected users.
- **Backend** (`Docker-AWS/backend/server.js`): a tiny Express + Socket.IO
  server. `YSocketIO` relayed Yjs edits between everyone, served the built
  frontend, and had a `/health` endpoint. Port 3000.
- **Docker** (`Docker-AWS/dockerfile`): a multi-stage build — build the
  frontend, copy its `dist/` into the backend's `public/`, run `node server.js`.

**The important limitations** (these became our to-do list):

1. **No rooms.** Everyone joined the *same* hardcoded document named `"monaco"`.
2. **Nothing was saved.** The Yjs doc lived only in server memory — a restart
   wiped all text.
3. **No authentication.** Any name, you're in.
4. **No file uploads.**

---

## 2. The plan and the four gaps

Your goals mapped cleanly onto those gaps, so we phased the work:

| Phase | What we built |
|------|----------------|
| 1 | Rooms by code (the "enter a code" feature) |
| 2 | MongoDB + persistence ("existing text is still there") |
| 3 | *(Auth — you chose "name + code only", so the code **is** the auth; no separate phase)* |
| 4 | File uploads (image/PDF/doc), scoped to a room |
| 5 | docker-compose (run everything locally with one command) |
| 6 | Deploy on AWS (ECS Fargate) |
| 7 | GitHub → auto build & deploy |

**Key decisions you made up front** (and why they mattered):

- **Auth = name + code only.** Simplest; the room code is the gate. This meant
  MongoDB's jobs became: store rooms, persist text, and hold file metadata — not
  passwords.
- **File storage = AWS S3.** The standard for AWS apps; keeps big files out of
  the database.
- **Compute = ECS Fargate.** AWS runs your container; no server to manage.
- **Database host = MongoDB Atlas.** Managed MongoDB in the cloud.

**Build order:** we built and verified everything **locally first** (phases 1,
2, 4, 5), then did the cloud parts (6, 7). You never want your first test of a
feature to be in production.

---

## 3. Core idea: environment variables everywhere

The single most important habit in this project: **nothing environment-specific
is hardcoded.** Database URLs, S3 endpoints, bucket names, credentials — all come
from **environment variables**. That's why the *same Docker image* runs on your
laptop (local MongoDB + MinIO) and on AWS (Atlas + real S3) with zero code
changes — you just hand it different values.

You saw this pay off at deploy time: we didn't rebuild the app to point it at
Atlas; we just set `MONGO_URI` in the AWS task definition.

Locally those values live in `Docker-AWS/backend/.env` (which is **git-ignored**
so secrets never get committed). `.env.example` documents them for anyone cloning
the repo.

---

## 4. Phase 1 — Rooms by code

### What we changed
- **Frontend** (`App.jsx`): the doc name was hardcoded as `"monaco"`. The whole
  trick to rooms is: **use the room code as the Yjs document name.** Same code =
  same shared editor; different code = a separate, isolated world.
  - New lobby: enter a name, then **Create a new room** or **Join** with a code.
  - Name + room are stored in the **URL** (`?username=…&room=…`) so a refresh or a
    shared link drops you straight back in.
- **Backend** (`server.js`): two small REST endpoints:
  - `POST /api/rooms` → generates a unique code and returns it.
  - `GET /api/rooms/:code` → validates a code (200 if it exists, 404 if not).
  - The code generator deliberately drops lookalike characters (`0/O/1/I`) so
    codes are easy to read aloud and type.
- **Vite dev proxy** (`vite.config.js`): in development the frontend runs on
  `:5173` and the backend on `:3000`. The proxy forwards `/api` and the
  Socket.IO websocket to `:3000`, so dev behaves like production (one origin).

### Why
A CRDT system syncs everyone connected to the *same document name*. By making
that name the room code, isolation and sharing come for free — no extra access
logic needed. The code itself is the gate (matching your "name + code" choice).

### How we verified it
We ran the backend and frontend, then drove two browser tabs:
- Ana created room `2XWWL5`; Bob joined with the same code → both saw each other.
- Ana typed `HELLO_FROM_ANA` → it appeared live in Bob's editor.
- A third user in a *different* room saw an empty editor and none of the others
  → **isolation confirmed.**

---

## 5. Phase 2 — MongoDB persistence

### The concept (MongoDB in one table)

| SQL term | MongoDB term | In your app |
|---|---|---|
| Database | **Database** | `codetogether` |
| Table | **Collection** | `rooms`, `yjs-docs`, `files` |
| Row | **Document** (JSON-like) | `{ code: "ZYPMLU", createdAt: … }` |
| Column | **Field** | `code`, `createdAt` |

Documents are just JSON (BSON internally), and there's no fixed schema.

### What we changed (`server.js`)
- Added the official `mongodb` driver and `y-mongodb-provider`.
- Opened **one** `MongoClient` and shared it for both the `rooms` collection
  **and** the Yjs persistence (`new MongodbPersistence({ client, db }, …)`) —
  one connection, two uses.
- Replaced the in-memory room set with a `rooms` collection, and added a
  **unique index** on `code` so the *database itself* guarantees no duplicates.
- Persisted editor text using two YSocketIO events:
  - `document-loaded` (a room opens) → load saved state from Mongo and apply it.
  - the doc's `update` event (every edit) → save the update to Mongo.
  - The hydration apply is tagged with origin `"mongodb-load"`, and the save
    listener ignores that origin — otherwise it would immediately re-save what it
    just loaded (an infinite echo). This is the one genuinely subtle line.

### Why those specific choices
- **One shared client**: fewer connections, simpler lifecycle.
- **Unique index**: correctness enforced by the database, not just app code.
- **Storing CRDT updates** (not "the final text"): Yjs stores a stream of tiny
  operations; `y-mongodb-provider` writes each as a document and periodically
  merges them. This is what makes concurrent editing + persistence work together.

### How we found the exact API (a good habit)
Rather than guess the event names, we **read the installed package's type
definitions** (`node_modules/y-socket.io/dist/server/index.d.ts`) to confirm the
real events (`document-loaded`, `document-update`) and that each doc is a `Y.Doc`
with a `.name`. Reading the source beats guessing.

### Running it in dev
- `Docker-AWS/backend/.env` holds `MONGO_URI` and `DB_NAME`.
- The `dev` script became `node --env-file=.env --watch server.js` — Node 22+ can
  load a `.env` file and auto-restart on changes natively (we dropped `nodemon`).

### The MongoDB discovery (and a Compass gotcha)
We started a MongoDB **container**, but your machine *already had MongoDB running
as a Windows service* on port 27017. Because of an IPv4/IPv6 split, your Node
app (via `127.0.0.1`) talked to the **host** MongoDB while the container sat on
the IPv6 side. So:
- We removed the redundant container and used your existing local MongoDB for
  dev.
- When you couldn't see `codetogether` in **Compass**, the cause was Compass
  caching the database list — a **refresh** showed it. Also: connect Compass to
  `127.0.0.1:27017`, not `localhost` (which resolves to IPv6 first on your box).

### How we verified persistence
Typed `PERSIST_TEST_ZYPMLU_42` into a room, **fully restarted the backend**
(cold, nothing in memory), reloaded the room — the text came back. That proves it
was loaded from MongoDB, not memory.

---

## 6. Phase 4 — File uploads to S3

### The concept (object storage)
S3 stores **objects** (files) in **buckets**, each identified by a **key**
(just a string like `rooms/ABC123/uuid-photo.png`). There are no real folders —
the slashes are convention.

**Why files go to S3, not the DB or the server disk:**
- **Not the server disk** — containers are ephemeral; a restart/redeploy wipes
  local files (same reason the Yjs text used to vanish).
- **Not MongoDB** — databases aren't built for big blobs; it bloats and slows
  them.
- **S3** — cheap, durable, effectively infinite, separate from compute.

So the pattern is: **file bytes → S3, metadata → MongoDB** (`files` collection:
room code, S3 key, filename, type, size, uploader, timestamp).

### What we changed (`server.js`)
- Added `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, and `multer`.
- `multer` with **memory storage** (file held in RAM, streamed straight to S3,
  never written to the server's disk), a **10 MB limit**, and a **file filter**
  that only allows images, PDF, and `.doc`/`.docx` (your requirement).
- `POST /api/rooms/:code/files` → `PutObject` to S3 + `insertOne` metadata to
  Mongo.
- `GET /api/rooms/:code/files` → list a room's files (newest first; backed by an
  index).
- `GET /api/rooms/:code/files/:id/url` → a **pre-signed URL** valid for 5 minutes.

### Pre-signed URLs — the clever bit
Your bucket is **private**. A pre-signed URL is a temporary, cryptographically
signed link that grants read access to *one object* for a short time. The browser
downloads **directly from S3**, and your server never exposes its credentials.
This is how real apps serve private files. Crucially, this works even with
"Block all public access" **on**, because a signed request is *authenticated*,
not public.

### Local S3 = MinIO (and why the image was a pain)
For dev we ran **MinIO** (S3-compatible) in Docker. MinIO's own images now block
anonymous pulls (Docker Hub denied, quay.io returned 401), so we used the
maintained **`alpine/minio`** mirror, which still pulls anonymously and uses the
same run command.

### How we verified it
Uploaded an allowed PNG (201), confirmed a disallowed `.txt` was rejected (400),
listed it, generated a signed URL, downloaded it, and compared **md5 checksums** —
they matched, proving the bytes round-tripped through S3 intact. We also proved a
**second user** in the same room could see and download the file (files belong to
the room, not the uploader), and that a different room saw nothing (isolation).

---

## 7. Phase 5 — docker-compose (the local stack)

### What it is
`docker compose up --build` brings up **three containers** on one private
network from a single file (`docker-compose.yml`):
- `mongo` — the database
- `minio` — local S3
- `app` — your project, built from the Dockerfile, served on `localhost:3000`

### The key ideas it taught
- **Service-name networking**: containers reach each other by service name —
  `mongodb://mongo:27017`, `http://minio:9000`. No IPs. Inside the network you
  use service names; from your browser you use `localhost`.
- **`ports:` only publishes to your host.** We published `app` (3000) and `minio`
  (9000/9001) but **not** `mongo` — only the app needs it, and *not* publishing
  it also avoided colliding with your host's MongoDB on 27017.
- **`depends_on` ≠ "wait until ready."** It only controls start *order*. MinIO
  took a few seconds to initialize, so the app's first S3 call failed — which is
  why we added a **retry loop** (`withRetry`) at startup. Apps must tolerate
  dependencies not being ready yet. You literally watched it retry then succeed.
- **Named volumes** (`mongo-data`, `minio-data`) keep data across
  `docker compose down`; `down -v` wipes it.

### Dockerfile hardening (why we rewrote it)
The original copied the backend *including* local `node_modules` and never ran
`npm install` for it. The new one:
- Copies `package*.json` **first**, installs, *then* copies code — so Docker
  caches the slow install layer and only redoes it when dependencies change.
- Runs `npm install --omit=dev` (smaller, production-only image).
- Pairs with `.dockerignore`, which keeps `node_modules`, `frontend/dist`, and
  — critically — **`backend/.env` (secrets)** out of the image.

### The internal/public S3 endpoint split
A pre-signed URL bakes in whichever endpoint signed it. Inside Compose the app
reaches MinIO at `http://minio:9000`, but the **browser** can't resolve `minio`.
So the app signs download URLs with a separate **public** endpoint
(`S3_PUBLIC_ENDPOINT=http://localhost:9000`) while doing its own uploads over the
internal one. On real AWS, neither is set and URLs point to real S3
automatically.

### A real gotcha: MinIO + volume permissions
MinIO crash-looped with "file access denied" because the fresh named volume is
root-owned and the image runs as a non-root user. Fix: `user: root` on the minio
service.

### Verified
`docker compose up --build` → created a room, uploaded a file, got a signed URL
whose host was `localhost:9000`, downloaded it — all on the single `:3000`
origin, exactly like production.

---

## 8. Git hygiene & pushing to GitHub

### Untracking node_modules
Your repo had **2652 of 2673 tracked files inside `node_modules`** (committed
before a `.gitignore` existed). We untracked it:
```bash
git rm -r --cached Docker-AWS/backend/node_modules
```
`--cached` removes it from Git's index but **keeps the files on disk**. After
committing, the repo went from **2673 → 24** tracked files. This matters because
the image installs dependencies fresh, and a bloated repo is bad for CI.

### Committing & pushing
We committed the work, confirmed **`.env` was not staged** (secrets stay out of
git), and pushed the `feature-login` branch:
```bash
git push -u origin feature-login
```
You then merged **PR #1** into `main` on GitHub.

---

## 9. Phase 6 — Deploying to AWS

This is where the most happened, so here's the full story.

### The building blocks
- **ECR** (Elastic Container Registry) — stores your Docker image.
- **ECS Fargate** — runs your container (a *task*) without you managing servers.
- **Task definition** — the blueprint for a task: which image, which env vars,
  CPU/memory, which IAM role, ports.
- **Service** — keeps the desired number of tasks running and ties them to the
  load balancer.
- **ALB** (Application Load Balancer) — the public entry point; health-checks
  tasks and routes traffic to healthy ones.
- **IAM role** — permissions your task is allowed to use.

Your existing setup (discovered with the AWS CLI):
- Cluster `silent-eagle-jnru0r`, service `docker-aws-service-yssqbpm3`,
  task family `docker-aws`, container `Main-server` (port 3000),
  role `dockerawsrole`, ALB `dockerbalancer-…elb.amazonaws.com`.

### Pushing the new image to ECR
The ECR console gives generic commands; we adapted two things: run the build
**inside `Docker-AWS/`** and point at our file **`-f dockerfile`** (it's a
non-default lowercase name).
```bash
docker build -t docker-aws/server -f dockerfile .
aws ecr get-login-password --region ap-southeast-2 \
  | docker login --username AWS --password-stdin 105322542274.dkr.ecr.ap-southeast-2.amazonaws.com
docker tag docker-aws/server:latest 105322542274.dkr.ecr.ap-southeast-2.amazonaws.com/docker-aws/server:latest
docker push 105322542274.dkr.ecr.ap-southeast-2.amazonaws.com/docker-aws/server:latest
```
- `get-login-password | docker login` hands Docker a temporary ECR token.
- `tag` gives the image its full ECR address.
- `push` uploads the changed layers.

### Three blockers we found before it could go live
1. **The task definition pinned the image by digest** (`@sha256:…`, the *old*
   image), not by tag. So "force new deployment" alone would redeploy the *same
   old image*. We had to register a **new task-definition revision** pointing at
   the new image.
2. **Env vars were empty.** The new code *requires* `MONGO_URI` (it won't boot
   without a database). We had to add `MONGO_URI`, `DB_NAME`, and later the S3
   vars.
3. **The task role lacked S3 permissions**, and the running image would *crash*
   if it couldn't reach S3 at startup.

### Making S3 non-fatal (a resilience improvement)
Rather than block the whole app on S3 being perfectly configured, we changed
startup so that if S3 is unreachable, the app **logs a warning and keeps running
with uploads disabled** (the file routes return `503`). This let us go live with
just Atlas first, then enable uploads afterward. Core app up; files added later.

### Registering revisions (without leaking the password)
We pulled the current task definition, used a small Node script to swap the image
and inject env vars, and registered a new revision — deliberately never printing
the password:
```bash
aws ecs register-task-definition --cli-input-json file://reg.json --region ap-southeast-2
aws ecs update-service --cluster silent-eagle-jnru0r --service docker-aws-service-yssqbpm3 \
  --task-definition docker-aws:2 --force-new-deployment --region ap-southeast-2
```
- **Revision 2**: new image + `MONGO_URI` + `DB_NAME` → app live on Atlas.
- **Revision 3**: added `S3_REGION` + `S3_BUCKET` → uploads (once IAM was fixed).

### How we proved it was live
We couldn't read CloudWatch logs (the CLI user is scoped out), so we used the
**strongest possible proof** — hitting the live ALB URL:
- `GET /health` → 200
- `POST /api/rooms` → 201 with a code. **That write only succeeds if Atlas is
  connected.** It was.

### The connection-string gotcha
Your Atlas password ended with `@`, which is reserved in a URL. It **must** be
URL-encoded as `%40`, or the connection string breaks:
`mongodb+srv://user:pass%40@cluster0.ezndokd.mongodb.net/`.

### The S3 bucket + the IAM mistake
- You created a **private** bucket `codetogether-uploads-105322542274` (Block all
  public access ON — correct, because pre-signed URLs are authenticated).
- First attempt failed: uploads returned `503`. The cause was a **wrong IAM
  policy** — `AmazonS3`**`Files`**`FullAccess` (a newer policy for the S3 *file
  system* feature) instead of `AmazonS3FullAccess` (the bucket/object API). The
  names are confusingly similar.
- Fix: attach **`AmazonS3FullAccess`**, then **force a new deployment** — because
  the app only checks S3 **at startup**, the task had to restart to re-run the
  check with the corrected permissions.
- Verified: upload → 201 (stored in real S3), signed URL host
  `…s3.ap-southeast-2.amazonaws.com`, download md5 matched. Uploads live.

---

## 10. Phase 7 — GitHub Actions CI/CD

### The goal
Stop deploying by hand. Every push to `main` should automatically build the
image, push it to ECR, and roll it out to ECS.

### The decision: access keys vs OIDC
- **OIDC** (recommended long-term): GitHub gets a short-lived token and assumes
  an IAM role — no stored keys. More secure, but needs an OIDC provider + a role
  with a trust policy.
- **Access keys** (what you chose): create an access key for the existing
  `dockeraws` user and store it as two GitHub secrets. Faster — it reuses the
  exact permissions we already proved work.

### The workflow (`.github/workflows/deploy.yml`, at the repo root)
It runs on push to `main` and:
1. Checks out the code and configures AWS creds from the two GitHub secrets.
2. Logs in to ECR.
3. Builds from `Docker-AWS/` and pushes, tagged with the **commit SHA** (immutable,
   great for rollbacks) and `latest`.
4. Downloads the **current** task definition (so it keeps the env vars), swaps in
   the new image, registers a new revision, and updates the service — waiting for
   stability.

> The `.github` folder must live at the **repo root**, not inside `Docker-AWS/`,
> or GitHub won't find the workflow.

### The GitHub secrets gotcha
GitHub repository secrets are **individual name/value pairs**, not a `.env` blob.
You create **two separate secrets** — `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` — each with its own Name and value, not both names in one
value box.

### The push/merge gotcha
While we worked, you'd merged PR #1 into `main` on GitHub, so `origin/main` had
moved ahead of our local `main`. We **rebased** our one workflow commit on top of
the PR merge and pushed cleanly:
```bash
git rebase origin/main
git push origin main
```

### Verified (the whole point)
That push triggered the workflow. We watched the AWS side: the task-definition
revision went **3 → 4** on its own, the service rolled to `docker-aws:4`
(`IN_PROGRESS` → `COMPLETED`), and the live app stayed healthy — **a full deploy
from a single `git push`, no manual steps.**

---

## 11. Every gotcha we hit (and the fix)

| Gotcha | Why it happened | Fix |
|---|---|---|
| Couldn't see `codetogether` in Compass | Compass caches the DB list; `localhost` resolves to IPv6 first | Refresh Compass; connect to `127.0.0.1:27017` |
| Two MongoDBs on 27017 | You already ran MongoDB as a Windows service; the container took the IPv6 side | Removed the container; used the host MongoDB for dev |
| MinIO image wouldn't pull | MinIO blocked anonymous pulls (Docker Hub + quay 401) | Used the `alpine/minio` mirror |
| MinIO crash-looped ("file access denied") | Root-owned named volume, non-root process | `user: root` on the minio service |
| App's first S3 call failed under compose | `depends_on` doesn't wait for readiness | Startup **retry loop** |
| Repo was 2600+ files | `node_modules` committed before `.gitignore` | `git rm -r --cached node_modules` |
| "Force deploy" wouldn't update the image | Task def pinned the image by **digest** | New task-def revision pointing at the new tag |
| New container would crash on AWS | New code requires MongoDB; env was empty | Added `MONGO_URI`/`DB_NAME`; made S3 non-fatal |
| Mongo connection string broke | Password contained `@` | URL-encode it as `%40` |
| Uploads returned 503 on AWS | Wrong IAM policy (`AmazonS3FilesFullAccess`) | Attach `AmazonS3FullAccess`, then restart the task |
| IAM/S3 change didn't take effect | App checks S3 only at **startup** | Force a new deployment (restart) |
| `git push` to main rejected | You'd merged PR #1; `origin/main` moved | `git rebase origin/main` then push |
| GitHub secrets not working | Both names typed into one value box | Two **separate** secrets |

---

## 12. Command reference

**Local dev (direct):**
```bash
# backend (from Docker-AWS/backend) — loads .env, auto-restarts
npm run dev
# frontend (from Docker-AWS/frontend) — dev server on :5173 with proxy to :3000
npm run dev
```

**Local dev (full stack in Docker):**
```bash
docker compose up --build        # build + start app + mongo + minio
docker compose ps                # what's running
docker compose logs app -f       # follow the app's logs
docker compose down              # stop (keeps data volumes)
docker compose down -v           # stop AND wipe data
```

**Inspect MongoDB:**
```bash
mongosh "mongodb://127.0.0.1:27017" --eval "use codetogether" --eval "db.rooms.find()"
```

**Build & push the image to ECR (manual — now automated by CI):**
```bash
docker build -t docker-aws/server -f dockerfile .
aws ecr get-login-password --region ap-southeast-2 | docker login --username AWS --password-stdin 105322542274.dkr.ecr.ap-southeast-2.amazonaws.com
docker tag docker-aws/server:latest 105322542274.dkr.ecr.ap-southeast-2.amazonaws.com/docker-aws/server:latest
docker push 105322542274.dkr.ecr.ap-southeast-2.amazonaws.com/docker-aws/server:latest
```

**Deploy to ECS (manual — now automated by CI):**
```bash
aws ecs update-service --cluster silent-eagle-jnru0r --service docker-aws-service-yssqbpm3 \
  --task-definition docker-aws:<rev> --force-new-deployment --region ap-southeast-2
```

**Deploy now (the easy way):**
```bash
git push        # to main → GitHub Actions does the rest
```

---

## 13. Architecture at a glance

```
                        Browser (you + collaborators)
                                   │  HTTPS / WebSocket
                                   ▼
                     ALB  dockerbalancer-…elb.amazonaws.com
                                   │
                                   ▼
                    ECS Fargate task  (image from ECR)
                    ┌───────────────────────────────┐
                    │  Express + Socket.IO + Yjs     │
                    │  serves built React frontend   │
                    └──────┬───────────────┬─────────┘
                           │               │
                 MONGO_URI │               │ S3 SDK (task IAM role)
                           ▼               ▼
                  MongoDB Atlas        S3 bucket
                  (rooms, text,        codetogether-uploads-…
                   file metadata)      (file bytes, private,
                                        served via pre-signed URLs)

   CI/CD:  git push main ──► GitHub Actions ──► build ──► ECR ──► ECS deploy
```

Local dev mirrors this with the `mongo` and `minio` containers standing in for
Atlas and S3.

---

## 14. Outstanding security hardening

Nothing is broken, but these are worth doing (we deferred them):

1. **Rotate the Atlas password** and move it to **AWS Secrets Manager** (the role
   already has the permission). Right now it's stored in plaintext in the task
   definition and was shared in chat.
2. **Move GitHub auth to OIDC** so there are no long-lived AWS keys stored in
   GitHub.
3. **Scope the IAM policies**: replace `AmazonS3FullAccess` and
   `SecretsManagerReadWrite` with the narrow, bucket-/secret-specific inline
   policies, and detach the unused `AmazonS3FilesFullAccess`.

---

## 15. How to operate it from now on

- **Make a change** → commit → `git push` to `main`. GitHub Actions builds and
  deploys it automatically. Watch it at
  `https://github.com/kritarthkeshari/FDE/actions`.
- **Your live app:** `http://dockerbalancer-357383684.ap-southeast-2.elb.amazonaws.com`
- **Develop locally:** `docker compose up --build` in `Docker-AWS/`, or run the
  backend and frontend dev servers directly.
- **Roll back:** images are tagged by commit SHA in ECR, so you can point a task
  definition at an older SHA if a deploy goes wrong.

---

*Built step by step, verified at every stage, and deployed with a one-command
pipeline. Nice work.*
