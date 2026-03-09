import { NextRequest, NextResponse } from "next/server";
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import os from "os";

export const dynamic = "force-dynamic";

const CONFIG_PATH = path.join(os.homedir(), ".teamhub", "config.yaml");

interface HubSearchSettings {
  bm25_keep_ratio: number;
  gemini_input_tokens: number;
  gemini_output_tokens: number;
  top_k: number;
}

interface HubInfo {
  path: string;
  team: string[];
  search: HubSearchSettings;
}

const SEARCH_DEFAULTS: HubSearchSettings = {
  bm25_keep_ratio: 0.3,
  gemini_input_tokens: 100000,
  gemini_output_tokens: 800,
  top_k: 3,
};

function parseConfig(raw: string): Record<string, HubInfo> {
  const hubs: Record<string, HubInfo> = {};
  const hubsMatch = raw.match(/^hubs:\s*\n((?:[ \t]+.+\n?)*)/m);
  if (!hubsMatch) return hubs;

  let currentHub: string | null = null;
  let currentInfo: Partial<HubInfo> = {};
  let inSearch = false;
  let searchSettings: Partial<HubSearchSettings> = {};
  let inTeam = false;
  const teamMembers: string[] = [];

  for (const line of hubsMatch[1].split("\n")) {
    const hubNameMatch = line.match(/^  (\S+):\s*$/);
    if (hubNameMatch) {
      // Save previous hub
      if (currentHub) {
        hubs[currentHub] = {
          path: currentInfo.path || "",
          team: currentInfo.team || [],
          search: { ...SEARCH_DEFAULTS, ...searchSettings },
        };
      }
      currentHub = hubNameMatch[1];
      currentInfo = {};
      searchSettings = {};
      inSearch = false;
      inTeam = false;
      teamMembers.length = 0;
      continue;
    }

    if (!currentHub) continue;

    const pathMatch = line.match(/^    path:\s*["']?([^"'\n]+?)["']?\s*$/);
    if (pathMatch) {
      currentInfo.path = pathMatch[1];
      inSearch = false;
      inTeam = false;
      continue;
    }

    if (line.match(/^    team:\s*$/)) {
      inTeam = true;
      inSearch = false;
      currentInfo.team = [];
      continue;
    }

    if (inTeam) {
      const memberMatch = line.match(/^      - (.+)$/);
      if (memberMatch) {
        currentInfo.team = currentInfo.team || [];
        currentInfo.team.push(memberMatch[1].trim());
        continue;
      } else {
        inTeam = false;
      }
    }

    if (line.match(/^    search:\s*$/)) {
      inSearch = true;
      inTeam = false;
      continue;
    }

    if (inSearch) {
      const kvMatch = line.match(/^      (\w+):\s*([^\s#]+)/);
      if (kvMatch) {
        const [, key, val] = kvMatch;
        if (key in SEARCH_DEFAULTS) {
          (searchSettings as Record<string, number>)[key] = parseFloat(val);
        }
        continue;
      } else if (!line.match(/^\s*$/)) {
        inSearch = false;
      }
    }
  }

  // Save last hub
  if (currentHub) {
    hubs[currentHub] = {
      path: currentInfo.path || "",
      team: currentInfo.team || [],
      search: { ...SEARCH_DEFAULTS, ...searchSettings },
    };
  }

  return hubs;
}

export async function GET() {
  if (!existsSync(CONFIG_PATH)) {
    return NextResponse.json({ available: false });
  }

  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const hubs = parseConfig(raw);
    return NextResponse.json({ available: true, hubs });
  } catch {
    return NextResponse.json({ available: false });
  }
}

export async function PATCH(req: NextRequest) {
  if (!existsSync(CONFIG_PATH)) {
    return NextResponse.json({ error: "TeamHub not configured" }, { status: 404 });
  }

  const body = await req.json();
  const { hubName, search } = body as { hubName: string; search: Partial<HubSearchSettings> };

  if (!hubName || !search) {
    return NextResponse.json({ error: "hubName and search required" }, { status: 400 });
  }

  try {
    let raw = readFileSync(CONFIG_PATH, "utf-8");

    // Find this hub's search section and update it
    // Strategy: rebuild the search block for this hub
    const hubRegex = new RegExp(
      `(^  ${hubName}:\\s*\\n(?:    (?!\\S).+\\n)*)`,
      "m"
    );

    const hubMatch = raw.match(hubRegex);
    if (!hubMatch) {
      return NextResponse.json({ error: `Hub "${hubName}" not found` }, { status: 404 });
    }

    const hubBlock = hubMatch[1];

    // Parse current settings to merge
    const currentHubs = parseConfig(raw);
    const currentSearch = currentHubs[hubName]?.search || SEARCH_DEFAULTS;
    const merged = { ...currentSearch, ...search };

    // Build new search block
    const searchBlock = [
      "    search:",
      `      bm25_keep_ratio: ${merged.bm25_keep_ratio}`,
      `      gemini_input_tokens: ${merged.gemini_input_tokens}`,
      `      gemini_output_tokens: ${merged.gemini_output_tokens}`,
      `      top_k: ${merged.top_k}`,
    ].join("\n");

    // Replace or add search block within hub
    let newHubBlock: string;
    if (hubBlock.includes("    search:")) {
      // Replace existing search section
      newHubBlock = hubBlock.replace(
        /    search:\s*\n(?:      .+\n?)*/,
        searchBlock + "\n"
      );
    } else {
      // Append search section
      newHubBlock = hubBlock.trimEnd() + "\n" + searchBlock + "\n";
    }

    raw = raw.replace(hubBlock, newHubBlock);
    writeFileSync(CONFIG_PATH, raw, "utf-8");

    const updatedHubs = parseConfig(raw);
    return NextResponse.json({ ok: true, hubs: updatedHubs });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
