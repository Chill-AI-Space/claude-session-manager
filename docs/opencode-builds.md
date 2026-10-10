# Named OpenCode builds

Settings → OpenCode builds registers already completed binaries. Every new-session
agent dropdown lists Codex, Claude, classic OpenCode, stable fork builds, snapshots newest first,
the installed OpenCode, then Forge. Entries appear when registered;
the installed binary is not assumed to be upstream or a stable fork.

Add an upstream binary with kind `upstream`, the approved fork with kind `stable`,
and selected completed branch/PR iterations with kind `snapshot`. Give each snapshot
a unique permanent ID and its own absolute executable path. Names, ISO build dates,
branch, commit, PR title/number and feature descriptions are optional metadata
(except the display name). Registration does not build, download or delete binaries.

Keep snapshot binaries in separate directories, e.g.:

```
~/opencode-builds/upstream/opencode
~/opencode-builds/pr-42-a1b2c3/opencode
~/opencode-builds/pr-57-d4e5f6/opencode
```

Do not overwrite a snapshot binary or change its ID/path after sessions use it.
Create another entry for the next iteration. A stable entry can point to a specific
snapshot, but changing its path affects sessions that selected that stable ID.
Deleting an entry does not delete its binary; affected sessions refuse to resume
until the same ID is restored. Builds must use the existing OpenCode database/config
locations and compatible session formats. Separate storage layouts and automatic
branch builds/retention are future work.

The fork supports `--auto`; upstream entries default to omitting that flag. Change
“Supports --auto” for a binary with different CLI capabilities. All builds use the
existing OpenCode model profile selector and shared profile configuration.

The registry is stored as the `opencode_builds` JSON string in the normal settings
file. `GET /api/opencode/builds` returns sorted entries and executable availability.
The settings API validates registry entries before saving. The start API accepts:

```json
{"path":"/absolute/project","message":"Your task","agent":"opencode","opencodeBuild":"pr-42-a1b2c3"}
```

Only registered IDs are accepted; a start request cannot supply an executable path.
The selected ID is saved as `sessions.opencode_build_id`, so terminal opens and replies
use the same registered build. Requests without a build ID preserve the installed
OpenCode behavior. For remote starts register the same ID on the target node; its
binary path is resolved on that node.

## Adding the next PR iteration

1. Build the desired commit in the OpenCode fork using that repository's build
   instructions. Use a completed, tested commit rather than a moving branch name.
2. Copy the resulting executable and any required companion files into a new
   directory, for example `~/opencode-builds/pr-42-a1b2c3/`. Preserve executable
   permissions. Run that exact binary with `--version` and verify its TUI works.
3. Open Session Manager → Settings → OpenCode builds → Add build.
4. Set ID `pr-42-a1b2c3`, name `OpenCode — improved approvals`, kind `Snapshot`,
   absolute executable path, build date, branch, full commit and PR title/number.
   Add a short feature description. Enable “Supports --auto” only if supported.
5. Click Save builds. Return to the new-session composer, open the agent dropdown,
   choose the new entry, select a model profile and send the first message.
6. After closing the terminal, open or reply to that session in Session Manager.
   It should launch the same snapshot executable again.

For another iteration of the same PR use a new directory and ID, for example
`pr-42-d4e5f6`; leave the old entry available for comparison. No Session Manager
restart or deploy is needed when adding a build.

For classic upstream, register an independently installed official binary with ID
`upstream` and kind `Classic OpenCode`. For the preferred fork, register its tested
binary with kind `Stable fork` and a versioned ID such as `stable-a1b2c3`.
To promote another stable version, add its own ID and change the previous entry's
kind to `Snapshot`. This preserves existing sessions' binary selection.

Example registry (replace all paths with your actual absolute paths):

```json
[
  {
    "id": "upstream",
    "name": "OpenCode Classic",
    "kind": "upstream",
    "binary": "/Users/you/opencode-builds/upstream/opencode",
    "autoFlag": false
  },
  {
    "id": "stable-a1b2c3",
    "name": "OpenCode MEM — stable",
    "kind": "stable",
    "binary": "/Users/you/opencode-builds/pr-42-a1b2c3/opencode",
    "builtAt": "2026-10-10T12:00:00Z",
    "commit": "a1b2c3",
    "pullRequest": "PR #42 — improved approvals",
    "description": "Improved approval handling",
    "autoFlag": true
  }
]
```

To register through the API, save that array in `builds.json`, then send it as the
JSON-string setting (this replaces the whole registry, so include existing entries):

```bash
node -e 'const fs=require("fs"); const builds=JSON.parse(fs.readFileSync("builds.json","utf8")); process.stdout.write(JSON.stringify({opencode_builds:JSON.stringify(builds)}))' > build-settings.json
curl --fail-with-body -X PUT http://localhost:3000/api/settings \
  -H 'Content-Type: application/json' --data-binary @build-settings.json
curl --fail-with-body http://localhost:3000/api/opencode/builds
```

`available: false` means the binary is missing, is not a file, or is not executable.
Correct the path/permissions and reload the composer. A registry validation error
means an ID is duplicated/invalid, a path is relative, a date is invalid, or a
required field is missing. An empty registry keeps only the installed OpenCode.
