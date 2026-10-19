# Permissions and autonomy in Claude Session Manager

This document covers every mechanism that lets sessions run without asking for
approval on each tool call.

## 1. Global toggle: Skip permissions

Setting key: `dangerously_skip_permissions` (default `false`).

When enabled, Session Manager passes an agent-specific "skip" flag on start and
resume:

| Agent | Flag |
|-------|------|
| Claude | `--dangerously-skip-permissions` |
| OpenCode | `--auto` (auto-approve permissions that are not explicitly denied) |
| Codex | `--dangerously-bypass-approvals-and-sandbox` |

Enable in **Settings → Permissions → Dangerously skip permissions**, or via API:

```bash
curl -s -X PUT http://localhost:3000/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"dangerously_skip_permissions":"true"}'
```

The toggle is read live; existing sessions pick it up on the next resume/reply.

## 2. Claude

- Flag: `--dangerously-skip-permissions`.
- Applies to terminal starts (`buildStartShellCommand`) and web replies
  (`claude -p`).
- Web replies also honour `max_turns` (default 80) — raise to 100-200 for
  complex autonomous tasks.

## 3. OpenCode

Two layers:

### 3.1 CLI flag `--auto`

Added automatically when `dangerously_skip_permissions=true` and the selected
build supports it (`autoFlag`). Upstream builds default to no `--auto`.

### 3.2 Generated config permissions

`src/lib/opencode-profiles.ts` (`allowAttachmentDirectory`) writes a private
`opencode.json` for every OpenCode session. It:

- leaves `permission` untouched if it is a string (e.g. `"allow"`);
- otherwise sets every permission key to `"allow"` unless explicitly configured:
  `read`, `edit`, `glob`, `grep`, `list`, `bash`, `task`,
  `external_directory`, `todowrite`, `question`, `webfetch`, `websearch`,
  `lsp`, `doom_loop`, `skill`;
- always allows these `external_directory` globs:
  - `<tmpdir>/session-drops/*` (UI attachments)
  - `<tmpdir>/*` and `<tmpdir>/**` (whole temp directory)

To allow an additional directory, edit `allowAttachmentDirectory` and add globs:

```ts
nextPermission.external_directory = {
  ...externalRules,
  [attachmentGlob]: "allow",
  [tmpGlob]: "allow",
  [tmpRecursiveGlob]: "allow",
  ["/path/to/dir/*"]: "allow",
  ["/path/to/dir/**"]: "allow",
};
```

For a blanket allow (all directories), set in `~/.config/opencode/base.json`:

```json
{ "permission": "allow" }
```

## 4. Codex

- Flag: `--dangerously-bypass-approvals-and-sandbox`.
- Added in `src/lib/codex-command.ts` when the toggle is on.

## 5. Permission bridge auto-escalation

When a Claude session stalls waiting for tool approval, Session Manager can
auto-escalate it to a terminal session with skip permissions.

Settings:
- `auto_escalate_permissions` (default `true`)
- `permission_wait_threshold_ms` (default `120000`)
- `permission_check_interval_ms` (default `180000`)
- `auto_close_escalation_terminals` (default `true`)

Detection runs in the scanner and a periodic checker; escalation opens a
terminal with `--dangerously-skip-permissions`.

## 6. Effort level

Setting: `effort_level` (high/medium/low, default high). Controls Claude
thinking depth; not a permission skip but affects autonomy/quality.

## 7. Manual OpenCode runs

For `opencode` started outside Session Manager, put in
`~/.config/opencode/base.json`:

```json
{ "permission": "allow" }
```

Or register a profile with `"permission": "allow"`.

## 8. Safety notes

- Skip permissions removes all confirmation prompts; use only if you understand
  the risks.
- Prefer directory-scoped allows over the blanket `"allow"` string.
- `max_turns` limits how far a web reply can go even with skips enabled.
EOF
echo done