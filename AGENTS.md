# Agent instructions (Claude Code, Codex, Cursor, any other agent or human)

Full project instructions: [README.md](README.md) and [CLAUDE.md](CLAUDE.md).

## Deploying to a running instance — read before you build or restart anything

**Use `npm run deploy:live`. Never restart the service by hand** (`launchctl`, `systemctl`, `pkill`, `kill`, `npm run build` over a live server). A raw restart kills every Claude session the server spawned. `deploy:live` snapshots live sessions, rebuilds, restarts, resumes the ones that died, and runs the smoke test.

- Merged to `main` → CI deploys automatically (`.github/workflows/ci.yml`, job `deploy`). You normally don't run anything by hand.
- Manual/local: `npm run deploy:live` (or `node scripts/deploy-live.js --dry-run` to just look).
- Setup and security model of the CI deploy: [docs/deploy-live-ci-cd-setup.md](docs/deploy-live-ci-cd-setup.md).
