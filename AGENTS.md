# Agent instructions (Claude Code, Codex, Cursor, any other agent or human)

Full project instructions: [README.md](README.md) and [CLAUDE.md](CLAUDE.md).

## Deploying to a running instance — read before you build or restart anything

**Use `npm run deploy:live`. Never restart the service by hand** (`launchctl`, `systemctl`, `pkill`, `kill`, `npm run build` over a live server). A raw restart kills every Claude session the server spawned. `deploy:live` snapshots live sessions, rebuilds, restarts, resumes the ones that died, and runs the smoke test.

- **There is no CI deploy.** Job `deploy` in `.github/workflows/ci.yml` SSHes into a *remote* Linux server and restarts a systemd unit. No such server exists for this project, the `production` environment isn't created, and none of `DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_SSH_KEY` / `DEPLOY_KNOWN_HOSTS` are set — so every run reports `deploy: skipping`. The live instance is a launchd agent on the owner's Mac, not that server. Don't wait for a deploy that will never fire, and don't "fix" it by setting `DEPLOY_ENABLED=true` — that just turns the skip into a failing `ssh` step.
- **So the full loop is: branch → PR → CI green → merge → `npm run deploy:live`.** The last step is not optional. For a single-user setup this is the intended flow.
- Manual/local: `npm run deploy:live` (or `node scripts/deploy-live.js --dry-run` to just look).
- The smoke test can flake on "Session detail has messages" right after a restart, while the session index is still rebuilding — re-run `bash scripts/smoke-test.sh` before treating it as a real failure.
- If someone ever does want CI deploy, it needs the full one-time setup first (remote box, forced-command deploy key, secrets): [docs/deploy-live-ci-cd-setup.md](docs/deploy-live-ci-cd-setup.md).
