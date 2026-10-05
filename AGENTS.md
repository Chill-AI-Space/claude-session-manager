# Agent instructions (Claude Code, Codex, Cursor, any other agent or human)

Full project instructions: [README.md](README.md) and [CLAUDE.md](CLAUDE.md).

## Deploying to a running instance — read before you build or restart anything

**Use `npm run deploy:live`. Never restart the service by hand** (`launchctl`, `systemctl`, `pkill`, `kill`, `npm run build` over a live server). A raw restart kills every Claude session the server spawned. `deploy:live` snapshots live sessions, rebuilds, restarts, resumes the ones that died, and runs the smoke test.

- **CI deploy is currently OFF** — job `deploy` is gated on the repo variable `DEPLOY_ENABLED=true`, which is not set, so every run reports `deploy: skipping`. Merging to `main` changes nothing on the live instance until you deploy it yourself. Don't wait for a deploy that will never fire.
- **So the full loop is: branch → PR → CI green → merge → `npm run deploy:live`.** The last step is not optional.
- Manual/local: `npm run deploy:live` (or `node scripts/deploy-live.js --dry-run` to just look).
- The smoke test can flake on "Session detail has messages" right after a restart, while the session index is still rebuilding — re-run `bash scripts/smoke-test.sh` before treating it as a real failure.
- To turn CI deploy on: `gh variable set DEPLOY_ENABLED --body true` plus the `DEPLOY_*` secrets. Setup and security model: [docs/deploy-live-ci-cd-setup.md](docs/deploy-live-ci-cd-setup.md).
