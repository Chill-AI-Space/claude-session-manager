# Live deploy via CI/CD — setup and security model

Merging to `main` deploys to the live server automatically, with the soft restart from `scripts/deploy-live.js`
(snapshot live sessions → build → restart → resume the ones that died → smoke test). Nobody needs to remember the command.

```
PR opened  ──► CI: tsc + tests + build (fork PRs too; no secrets, read-only token)
PR merged  ──► CI on main ──► job `deploy` (only if `check` is green and DEPLOY_ENABLED=true)
                              └─ ssh deploy@server  →  forced command: node scripts/deploy-live.js --pull
```

Workflow: `.github/workflows/ci.yml`. It is inert until you finish the one-time setup below.

## Who can trigger a deploy? (repo is public)

Only people who can push to `main`. Specifically:

- **Fork PRs / strangers**: their `pull_request` runs get a read-only token and *no secrets*, and the `deploy` job's
  `if:` requires a `push` event on `refs/heads/main`. They can open a PR and see it build; they can't deploy.
- **Never use `pull_request_target` or `workflow_run` to run PR code with secrets** — that is the classic way public repos get owned.
- **Pushing to `main`** needs write access. Add branch protection on `main` (require a PR + green `check`) so even collaborators go through review.
- **Environment `production`**: the SSH secrets live in the environment, not in the repo. Restrict it to branch `main`, optionally add required reviewers.
- **Leaked key blast radius**: the server's `authorized_keys` entry uses a forced command, so the key can only run the deploy script — no shell, no port forwarding.
- Repo Settings → Actions → General → "Fork pull request workflows": set **Require approval for all outside collaborators**.

## One-time setup

### 1. Deploy key (on your machine)

```bash
ssh-keygen -t ed25519 -N "" -C "csm-ci-deploy" -f ~/.ssh/csm_ci_deploy
```

Keep the private key only in the GitHub secret (step 3) and, if you want to deploy from your own machine, in a local
file such as `~/.ssh/csm_ci_deploy` (chmod 600). Never commit it.

### 2. Server (GCE VM or any Linux box running the systemd unit from `docs/gce-vm-setup-guide.md`)

Add to `~deploy-user/.ssh/authorized_keys` (one line; adjust the path to where the repo is checked out):

```
command="cd /opt/claude-session-manager && node scripts/deploy-live.js --pull",restrict ssh-ed25519 AAAA...pubkey... csm-ci-deploy
```

The deploy user needs passwordless `sudo systemctl restart claude-session-manager` only:

```
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart claude-session-manager
```

Make sure the unit has `KillMode=process` (see the setup guide) so a restart doesn't kill running `claude` processes.
Get the host key to pin: `ssh-keyscan -t ed25519 <host>`.

### 3. GitHub (Settings → Environments → `production`, branch restriction: `main`)

Secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` (contents of the private key), `DEPLOY_KNOWN_HOSTS` (output of `ssh-keyscan`).
Repo variable `DEPLOY_ENABLED=true` (Settings → Secrets and variables → Actions → Variables) switches the deploy job on.

```bash
gh secret set DEPLOY_SSH_KEY --env production < ~/.ssh/csm_ci_deploy
gh secret set DEPLOY_HOST --env production --body "<host>"
gh secret set DEPLOY_USER --env production --body "<user>"
ssh-keyscan -t ed25519 <host> | gh secret set DEPLOY_KNOWN_HOSTS --env production
gh variable set DEPLOY_ENABLED --body true
```

### 4. Branch protection on `main`

Require pull requests and the `check` status before merging.

## Manual deploys and other machines

- Anyone with shell access to the server: `npm run deploy:live`.
- A local Mac instance: `npm run deploy:live` (launchd). CI deploys only the server configured above.
- Building with `npm run build` on a machine with a live instance prints a warning pointing to `deploy:live`.
