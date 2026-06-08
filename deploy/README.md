# Deploying notify-activities on the VPS (host cron)

Runs the notifier directly on the VPS host as a per-minute (or per-5-min) cron job,
posting to the Hermes webhook on `127.0.0.1:8644`. Decoupled from the Hermes
container, so it survives Hermes redeploys. No credentials are ever handed to an agent.

## 0. Prerequisites on the VPS host
- **Node 24** (see [`.nvmrc`](../.nvmrc)). The Hermes *container* having node doesn't help — this runs on the host. Install via `nvm install 24` or NodeSource.
- `git` (to clone) and the ability to edit your crontab.
- Hermes reachable at `http://127.0.0.1:8644` on the host (confirm: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8644/webhooks/coros` → expect `405`, which means it's up and POST-only).

## 1. Get the code onto the VPS
Push your working tree (including the uncommitted changes: the new `src/notify/**`,
`event_type`, the `apiCode` fix, and **`pnpm-lock.yaml`**) to a **private** repo, then:
```sh
git clone <your-private-repo> ~/coros-api && cd ~/coros-api
```
> Do NOT commit `.env` — it's gitignored. `.coros-state.json` is gitignored too.
> (rsync works as well: `rsync -a --exclude node_modules --exclude .git ./ vps:~/coros-api/`.)

## 2. Create `.env` on the VPS (never in the repo)
```dotenv
COROS_API_URL=https://teameuapi.coros.com
COROS_EMAIL=you@example.com
COROS_PASSWORD=your-password
HERMES_WEBHOOK_URL=http://127.0.0.1:8644/webhooks/coros
HERMES_WEBHOOK_SECRET=<your-hermes-route-secret>
# Optional: absolute state path (defaults to ./.coros-state.json relative to the repo)
COROS_STATE_FILE=/home/<user>/coros-api/.coros-state.json
```

## 3. Build + verify
```sh
bash deploy/install.sh
```
This installs deps, builds, checks `.env`, and prints the crontab line. Then do the
first run manually — it will **bootstrap** (seed state, send nothing):
```sh
node dist/main notify-activities
```

## 4. Install the cron
`crontab -e`, then paste the line `install.sh` printed (it uses the absolute node path
because cron's PATH is minimal). Recommended cadence — every 5 min:
```cron
*/5 * * * * cd /home/<user>/coros-api && /path/to/node dist/main notify-activities >> /home/<user>/coros-api/notify.log 2>&1
```

That's it. The next tick after bootstrap will start sending `new_activity` payloads as
you log workouts, plus an `inactive` nudge after 48h idle.

## 5. Keep the log from growing (optional but recommended)
Each run prints a few Nest startup lines, so `notify.log` grows. Add a logrotate rule
(`/etc/logrotate.d/coros-notify`):
```
/home/<user>/coros-api/notify.log {
  weekly
  rotate 4
  compress
  missingok
  notifempty
  copytruncate
}
```

## Updating later
```sh
cd ~/coros-api && git pull && bash deploy/install.sh
```
(No cron change needed — the crontab line points at `dist/main`, which the rebuild refreshes.)

## Alternative: systemd timer (more robust than crontab)
If you'd rather have journald handle logs (no log-growth problem) and better failure
visibility, use a `oneshot` service + timer instead of cron. Ask and I'll generate the
`.service` and `.timer` units. Functionally identical; just sturdier on a server.

## Troubleshooting
- **`Hermes notify failed` / 401 in the log** → secret mismatch. Ensure `HERMES_WEBHOOK_SECRET` in `.env` equals the route secret, with no surrounding quotes.
- **`{"status":"ignored","event":"unknown"}`** → the route's `events` filter doesn't include `activity` (the notifier sends `event_type: "activity"`).
- **`Access token is invalid` (result 1019)** → wrong region; must be `teameuapi.coros.com`.
- **cron does nothing** → check the log path is writable and that the absolute node path in the crontab line is correct (`which node`).
