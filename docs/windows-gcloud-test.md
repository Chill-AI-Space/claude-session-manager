# Windows Testing on Google Cloud

## Option A — Port Forward (easiest, test web UI in your Mac browser)

### 1. Create the VM (one time)
```bash
gcloud compute instances create claude-win-test \
  --zone=us-central1-a \
  --machine-type=e2-standard-2 \
  --image-project=windows-cloud \
  --image-family=windows-server-2022-dc \
  --boot-disk-size=50GB \
  --tags=http-server
```

### 2. Enable SSH on Windows VM (one time, run in GCloud Console)
```bash
gcloud compute project-info add-metadata \
  --metadata=enable-windows-ssh=TRUE
```

### 3. SSH in with port forward
```bash
gcloud compute ssh claude-win-test \
  --zone=us-central1-a \
  --tunnel-through-iap \
  -- -L 3000:localhost:3000
```
Now open http://localhost:3000 in YOUR Mac browser — it connects to the Windows server.

### 4. Inside the SSH session — setup
```powershell
# Install Node.js (winget available on Server 2022)
winget install OpenJS.NodeJS.LTS

# Reload PATH
$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine")

# Install Claude Code
npm install -g @anthropic-ai/claude-code

# Clone the repo
git clone https://github.com/YOUR/claude-session-manager
cd claude-session-manager
npm install
npm run build

# Create .env.local if needed
echo "GEMINI_API_KEY=your-key" > .env.local

# Start server
npm run start
```

Then go back to your Mac and open http://localhost:3000 ✅

---

## Option B — Full Windows Desktop (RDP)

When you want to see actual Windows + test Chrome rendering.

### 1. Get RDP password
```bash
gcloud compute reset-windows-password claude-win-test \
  --zone=us-central1-a \
  --user=testuser
```
Save the generated password.

### 2. Get the external IP
```bash
gcloud compute instances describe claude-win-test \
  --zone=us-central1-a \
  --format="get(networkInterfaces[0].accessConfigs[0].natIP)"
```

### 3. Connect from Mac
- Download **Microsoft Remote Desktop** from Mac App Store (free)
- Add PC → enter the IP → username: `testuser` → password from step 1
- You now see the full Windows desktop

### 4. Open the web app
Inside the Windows RDP session, open Edge/Chrome and go to `http://localhost:3000`

---

## Windows Testing Checklist

Run through these in order:

### Basic setup
- [ ] `claude --version` works in PowerShell
- [ ] `node --version` shows 20+
- [ ] `npm run build` completes without errors
- [ ] `npm run start` starts on port 3000
- [ ] Settings page → System Setup shows claude ✅

### Session browsing
- [ ] Sessions appear in the sidebar after scan
- [ ] Clicking a session loads messages
- [ ] Pagination works (Load earlier messages)
- [ ] Search by title works

### Web replies
- [ ] Type a message and send → Claude responds
- [ ] Streaming text appears in real-time
- [ ] Session shows "Waiting for reply" (blue dot) after Claude responds

### Features that should be DISABLED on Windows (verify graceful failure)
- [ ] Focus Terminal → shows error, doesn't crash
- [ ] "Active" green dot → sessions show as inactive (expected)
- [ ] Kill terminal → button hidden or no-op

### Notifications
- [ ] Sound works (click Settings → enable sound → send a message)
- [ ] Browser notifications work after permission grant

### Known Windows quirks to watch for
- PATH issues after npm install (restart terminal / reload PATH)
- `claude` not found even after install → add `%APPDATA%\npm` to System PATH manually
- File paths use backslash → check FileBrowser shows paths correctly
- Sessions at `%USERPROFILE%\.claude\projects\` — confirm scanner finds them

---

## Cost estimate
- e2-standard-2 = ~$0.07/hour
- 50GB disk = ~$2/month
- Stop when not testing: `gcloud compute instances stop claude-win-test --zone=us-central1-a`
- Delete when done: `gcloud compute instances delete claude-win-test --zone=us-central1-a`
