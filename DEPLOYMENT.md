# Market Portal — Deployment Guide
### Two-Server VPS · Coolify + GitHub · HTTP (internal network)

---

## Architecture

```
Your local network (router DNS)
        │
        ▼  http://portal.local
┌─────────────────────────────────┐
│  Server A  (Coolify + Traefik)  │
│  Traefik port 80 (public)       │
└──────────────┬──────────────────┘
               │ proxies to Server B
               ▼ (private network between servers)
┌─────────────────────────────────┐
│  Server B  (your services)      │
│                                 │
│  ┌──────────────────────────┐   │
│  │  market-portal :3000     │   │
│  └────────┬─────────┬───────┘   │
│           │         │           │
│  [postgres-net] [n8n-net]       │
│           │         │           │
│  ┌────────▼─┐  ┌────▼─────┐    │
│  │ PostgreSQL│  │   n8n    │    │
│  └──────────┘  └──────────┘    │
└─────────────────────────────────┘
```

---

## Step 1 — Find your network names on Server B

SSH into Server B and run:

```bash
docker network ls
```

Look for networks associated with your Postgres and n8n resources. They
will have UUID-prefixed names, e.g:

```
NETWORK ID     NAME                          DRIVER
a1b2c3d4e5f6   coolify                       bridge
7g8h9i0j1k2l   abc123-postgresql-network     bridge
3m4n5o6p7q8r   def456-n8n-network            bridge
```

Note down the exact names — you'll need them in Step 4.

---

## Step 2 — Find your internal hostnames on Server B

### Postgres hostname
In Coolify → your PostgreSQL resource → **Connection Details**.
You'll see a connection string like:
```
postgresql://user:password@abc123-postgresql:5432/postgres
```
The hostname is the part between `@` and `:5432` — e.g. `abc123-postgresql`.

### n8n internal hostname
```bash
docker ps | grep n8n
```
Note the container name — e.g. `def456-n8n`. That's the hostname.

In n8n, open your market report workflow and add a **Webhook** node:
- HTTP Method: `POST`
- Path: `market-report-trigger`
- Activate the workflow (must be in Production mode, not test)

Your internal webhook URL will be:
```
http://<n8n-container-name>:5678/webhook/market-report-trigger
```

---

## Step 3 — Set up the Postgres database on Server B

```bash
docker exec -it <postgres-container-name> psql -U postgres
```

```sql
CREATE USER portal_user WITH PASSWORD 'choose_a_strong_password';
CREATE DATABASE market_portal OWNER portal_user;
GRANT ALL PRIVILEGES ON DATABASE market_portal TO portal_user;
\c market_portal
GRANT ALL ON SCHEMA public TO portal_user;
\q
```

---

## Step 4 — Update docker-compose.yml with your network names

Open `docker-compose.yml` from the project and update the three network
names at the bottom to match what you found in Step 1:

```yaml
networks:
  coolify:
    external: true
  <your-exact-postgres-network-name>:
    external: true
  <your-exact-n8n-network-name>:
    external: true
```

Also update the `networks:` list under the `portal` service to match.

Commit and push all files to your GitHub repo.

---

## Step 5 — Create a new GitHub repo and push the project

On your local machine (where you downloaded market-portal.zip):

```bash
unzip market-portal.zip
cd market-portal

git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

---

## Step 6 — Deploy via Coolify UI

### 6a — Add Server B to Coolify
If Server B isn't already in Coolify:
1. Coolify → **Servers** → **+ Add Server**
2. Enter Server B's private IP address
3. Coolify will connect via SSH — make sure Server A's SSH key is
   authorised on Server B (`~/.ssh/authorized_keys`)

### 6b — Create a new Resource on Server B
1. Coolify → select **Server B** → **+ New Resource**
2. Choose **Docker Compose**
3. Choose **GitHub** as the source
4. Select your newly created repo and the `main` branch
5. Coolify will read the `docker-compose.yml` automatically

### 6c — Set Environment Variables
In Coolify's **Environment Variables** tab for this resource:

| Variable | Value |
|---|---|
| `POSTGRES_HOST` | Internal hostname from Step 2 (e.g. `abc123-postgresql`) |
| `POSTGRES_PORT` | `5432` |
| `POSTGRES_DB` | `market_portal` |
| `POSTGRES_USER` | `portal_user` |
| `POSTGRES_PASSWORD` | Password you set in Step 3 |
| `N8N_WEBHOOK_URL` | Internal webhook URL from Step 2 |
| `SESSION_SECRET` | Output of `openssl rand -hex 32` |
| `ADMIN_USERNAME` | `admin` (or preferred username) |
| `ADMIN_PASSWORD` | Choose a strong password |
| `PORTAL_DOMAIN` | Local DNS name from your router (e.g. `portal.local`) |

### 6d — Deploy
Click **Deploy**. Coolify will pull from GitHub, build the image, and
start the container on Server B.

Check the **Logs** tab — on first boot you should see:
```
Seeded default admin user.
Database ready.
Market Portal running on :3000
```

---

## Step 7 — Configure Traefik on Server A to proxy to Server B

Since Traefik runs on Server A but the portal is on Server B, Traefik
needs to know how to reach it. In Coolify, when you set the domain for
the resource, Coolify handles this automatically as long as both servers
are managed by the same Coolify instance.

In the resource settings in Coolify:
- Set the **Domain** to `http://portal.local`
- Coolify will configure Traefik on Server A to proxy requests for
  `portal.local` through to Server B's internal IP on port 3000

---

## Step 8 — Add DNS entry to your router

In your router's local DNS / Static DNS settings:

```
portal.local  →  <SERVER A IP>
```

Traffic hits Server A (Traefik) which proxies it through to Server B
(the portal container). Users only ever need to know `portal.local`.

---

## Step 9 — First login

Open `http://portal.local` in a browser on your local network.

Log in with `ADMIN_USERNAME` / `ADMIN_PASSWORD` from Step 6c.

**Add additional users** by exec-ing into the portal container on Server B:

```bash
docker ps | grep portal

docker exec -it <container_name> node -e "
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.POSTGRES_HOST,
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
});
const hash = bcrypt.hashSync('NEW_PASSWORD', 12);
pool.query(
  'INSERT INTO users (username, password_hash) VALUES (\$1, \$2)',
  ['NEW_USERNAME', hash]
).then(() => { console.log('Done.'); pool.end(); });
"
```

---

## Daily Workflow

```
1.  Open http://portal.local
2.  Log in
3.  Latest draft report loads automatically
4.  Write commentary → Save Draft
5.  Approve Report  →  locks commentary, status → "approved"
6.  Review the preview
7.  Click ⚡ Dispatch via n8n
      └─ Portal POSTs to n8n webhook (internal Docker network)
      └─ n8n builds the report and sends via Mailgun
      └─ Status → "sent", timestamp recorded
8.  Audit Log tab shows the full trail
```

---

## Creating New Reports

For each new distribution cycle, insert a row into Postgres on Server B:

```bash
docker exec -it <postgres-container-name> psql -U portal_user -d market_portal -c \
  "INSERT INTO reports (title, report_date, status) \
   VALUES ('Market Report – Apr 2026', '2026-04-01', 'draft');"
```

---

## Future Deployments

Now that GitHub is connected, deploying updates is simple:

```bash
# Make your changes locally, then:
git add .
git commit -m "describe your change"
git push
```

Then in Coolify → your portal resource → **Redeploy**. Or enable
**Auto Deploy** in Coolify to have it deploy automatically on every push.

---

## Troubleshooting

**Portal can't connect to Postgres**
- Verify the postgres network name in `docker-compose.yml` is exact
- Check the portal is on the network:
  `docker inspect <portal-container> | grep -A 20 Networks`
- Ping test: `docker exec <portal-container> ping <postgres-hostname>`

**n8n webhook call fails**
- Confirm the n8n workflow is **activated** (not test/draft mode)
- Test: `docker exec <portal-container> wget -qO- http://<n8n-hostname>:5678/healthz`

**Traefik not routing `portal.local`**
- Confirm the domain is set correctly in Coolify's resource settings
- Check Traefik dashboard on Server A to see if the router registered
- SSH tunnel test: `ssh -L 8080:<server-b-ip>:3000 user@<server-a-ip>`
  then open `http://localhost:8080`

**Container won't start**
- Coolify → resource → **Logs** tab
- Most common: a network name in the compose file doesn't exactly match
  what `docker network ls` shows on Server B
