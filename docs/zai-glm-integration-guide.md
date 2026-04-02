# Z.ai GLM 5.1 Integration Guide for Claude Session Manager

## Overview

Claude Session Manager now **automatically detects** when you're using Z.ai GLM models via environment variables and displays the effective model correctly in the UI.

This means:
- ✅ Session details show the actual model being used (e.g., `glm-5.1 (Z.ai)`)
- ✅ Settings page warns you about environment overrides
- ✅ No more confusion between reported model (in JSONL) and effective model (actual API calls)

## Quick Setup

### Step 1: Install Z.ai DevPack

Visit [docs.z.ai/devpack/tool/claude](https://docs.z.ai/devpack/tool/claude) and install the DevPack.

### Step 2: Configure Environment Variables

Add to your `~/.zshrc` (or `~/.bashrc`):

```bash
export ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"
export ANTHROPIC_DEFAULT_SONNET_MODEL="glm-5.1"
export ANTHROPIC_DEFAULT_OPUS_MODEL="glm-5.1"
```

Then restart your terminal or run `source ~/.zshrc`.

### Step 3: Verify in Claude Session Manager

1. Open Claude Session Manager
2. Go to **Settings → Summary AI**
3. You should see a warning: **"Model overridden by environment variables"**
4. The badge will show: **`glm-5.1 (Z.ai)`**

## How It Works

### Detection Logic

Claude Session Manager checks these environment variables on the server:

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_BASE_URL` | Proxy URL (e.g., `https://api.z.ai/api/anthropic`) |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Model to use when Sonnet is requested |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Model to use when Opus is requested |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Model to use when Haiku is requested |

### What You'll See

#### Session Details Page
```
[Active] My awesome session
~/my-project  main

12 messages  [glm-5.1 (Z.ai)]  145K tok
```

#### Settings Page (Summary AI section)
```
⚠️ Model overridden by environment variables

Your shell environment (e.g., ~/.zshrc) sets ANTHROPIC_BASE_URL and
ANTHROPIC_DEFAULT_*_MODEL. The effective model is glm-5.1 (Z.ai).

[glm-5.1 (Z.ai)] [↗]
```

#### API Response
```json
{
  "reportedModel": "claude-sonnet-4-6",
  "effectiveModel": "glm-5.1",
  "isOverridden": true,
  "provider": "Z.ai",
  "label": "claude-sonnet-4-6 → glm-5.1 (Z.ai)",
  "shortLabel": "glm-5.1 (Z.ai)"
}
```

## Common Scenarios

### Scenario 1: Standard Claude (No Override)

**Environment:** No `ANTHROPIC_BASE_URL` set

**Result:**
```
reportedModel: "claude-sonnet-4-6"
effectiveModel: "claude-sonnet-4-6"
isOverridden: false
```

**UI shows:** `claude-sonnet-4-6`

---

### Scenario 2: Z.ai GLM 5.1 (Override)

**Environment:**
```bash
ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"
ANTHROPIC_DEFAULT_SONNET_MODEL="glm-5.1"
```

**Result:**
```json
{
  "reportedModel": "claude-sonnet-4-6",
  "effectiveModel": "glm-5.1",
  "isOverridden": true,
  "provider": "Z.ai",
  "label": "claude-sonnet-4-6 → glm-5.1 (Z.ai)",
  "shortLabel": "glm-5.1 (Z.ai)"
}
```

**UI shows:** `glm-5.1 (Z.ai)` with link icon to Z.ai docs

---

### Scenario 3: AWS Bedrock (Override)

**Environment:**
```bash
ANTHROPIC_BASE_URL="https://bedrock-runtime.us-east-1.amazonaws.com"
ANTHROPIC_DEFAULT_SONNET_MODEL="anthropic.claude-3-sonnet-20240229-v1:0"
```

**Result:**
```json
{
  "reportedModel": "claude-sonnet-4-6",
  "effectiveModel": "anthropic.claude-3-sonnet-20240229-v1:0",
  "isOverridden": true,
  "provider": "AWS Bedrock",
  "label": "claude-sonnet-4-6 → anthropic.claude-3-sonnet-20240229-v1:0 (AWS Bedrock)",
  "shortLabel": "anthropic.claude-3-sonnet-20240229-v1:0 (AWS Bedrock)"
}
```

---

### Scenario 4: Z.ai via Settings (Not Environment)

**Settings:** `claude_model = "z.ai-claude-sonnet-4-6"`

**Environment:** No `ANTHROPIC_BASE_URL` set

**Result:**
```json
{
  "reportedModel": "z.ai-claude-sonnet-4-6",
  "effectiveModel": "z.ai-claude-sonnet-4-6",
  "isOverridden": false,
  "provider": null,
  "label": "z.ai-claude-sonnet-4-6",
  "shortLabel": "z.ai-claude-sonnet-4-6"
}
```

**Note:** This is the **old way** (using `z.ai-` prefix in settings). The new way (environment variables) is preferred because it works across all Claude CLI tools.

## API Reference

### GET `/api/model/effective`

Returns the effective model after checking environment overrides.

**Query Parameters:**
- `reportedModel` (optional): The model name from JSONL/session metadata

**Response:**
```typescript
{
  reportedModel: string | null;    // Model from JSONL
  effectiveModel: string;           // Actual model being used
  isOverridden: boolean;            // True if env vars override
  provider: string | null;          // "Z.ai", "AWS Bedrock", etc.
  label: string;                    // Human-readable full label
  shortLabel: string;               // Compact label for UI
}
```

**Example:**
```bash
curl "http://localhost:3000/api/model/effective?reportedModel=claude-sonnet-4-6"
```

## Troubleshooting

### "Model not showing correctly"

1. Check that environment variables are set in your shell:
   ```bash
   echo $ANTHROPIC_BASE_URL
   echo $ANTHROPIC_DEFAULT_SONNET_MODEL
   ```

2. Restart the Claude Session Manager server:
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.vova.claude-sessions.plist
   launchctl load ~/Library/LaunchAgents/com.vova.claude-sessions.plist
   ```

3. Verify the API endpoint:
   ```bash
   curl "http://localhost:3000/api/model/effective?reportedModel=claude-sonnet-4-6" | jq .
   ```

### "Still shows old model after setting env vars"

Environment variables are read **once at server startup**. You must restart the server after changing them.

### "Settings page shows no warning"

The warning only appears when `isOverridden = true`. Check:
- `ANTHROPIC_BASE_URL` is set
- `ANTHROPIC_BASE_URL` contains a known proxy domain (z.ai, bedrock, etc.)
- At least one `ANTHROPIC_DEFAULT_*_MODEL` is set

## Implementation Details

### Files Added

- `src/lib/model-detector.ts` — Core detection logic
- `src/app/api/model/effective/route.ts` — API endpoint
- `src/components/EffectiveModelBadge.tsx` — UI component

### Files Modified

- `src/app/claude-sessions/[sessionId]/page.tsx` — Show effective model in session header
- `src/components/settings/SummaryAiSettings.tsx` — Show override warning

### Detection Priority

1. Check `ANTHROPIC_BASE_URL` for known proxy domains
2. If Z.ai detected → use `ANTHROPIC_DEFAULT_*_MODEL`
3. If AWS Bedrock detected → use `ANTHROPIC_DEFAULT_*_MODEL`
4. If Vertex AI detected → use `ANTHROPIC_DEFAULT_*_MODEL`
5. Otherwise → no override, use reported model as-is

## Future Enhancements

Possible improvements:
- [ ] Detect other proxies (Azure OpenAI, Google Cloud, etc.)
- [ ] Show proxy latency/cost comparison
- [ ] Allow toggling between models from UI
- [ ] Export model usage report (Claude vs GLM)
- [ ] Warn if model is deprecated or unavailable

## Links

- [Z.ai DevPack Documentation](https://docs.z.ai/devpack/tool/claude)
- [Z.ai GLM Models](https://docs.z.ai/models)
- [Claude Session Manager GitHub](https://github.com/Chill-AI-Space/claude-session-manager)
