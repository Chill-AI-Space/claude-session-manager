import { NextRequest } from "next/server";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

interface SettingMatch {
  key: string;
  description: string;
  defaultValue: string;
  section: string;
  pluginId?: string;
}

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.toLowerCase().trim();
  if (!q || q.length < 2) {
    return Response.json({ results: [] });
  }

  const mdPath = path.join(process.cwd(), "public", "docs", "settings-reference.md");
  let content: string;
  try {
    content = fs.readFileSync(mdPath, "utf-8");
  } catch {
    return Response.json({ results: [], error: "settings-reference.md not found" });
  }

  const results: SettingMatch[] = [];
  let currentSection = "";
  let currentSectionName = "";
  let currentKey = "";
  let currentDefault = "";
  let currentPlugin = "";
  let currentDesc = "";
  let currentKeywords = "";
  let allLines: string[] = [];

  function flush() {
    if (!currentKey) return;
    // Search across all fields including section name and keywords
    const blob = [currentKey, currentDesc, currentSection, currentSectionName, currentPlugin, currentKeywords, ...allLines]
      .join(" ").toLowerCase();
    if (blob.includes(q!)) {
      results.push({
        key: currentKey,
        description: currentDesc,
        defaultValue: currentDefault,
        section: currentSection,
        pluginId: currentPlugin || undefined,
      });
    }
  }

  for (const line of content.split("\n")) {
    if (line.startsWith("## ")) {
      flush();
      currentSection = line.slice(3).trim();
      currentSectionName = currentSection;
      currentKey = "";
      currentDefault = "";
      currentPlugin = "";
      currentDesc = "";
      currentKeywords = "";
      allLines = [];
      continue;
    }
    if (line.startsWith("### ")) {
      flush();
      currentKey = line.slice(4).trim();
      currentDefault = "";
      currentPlugin = "";
      currentDesc = "";
      currentKeywords = "";
      allLines = [];
      continue;
    }
    allLines.push(line);
    if (line.startsWith("- **Default**:")) {
      currentDefault = line.replace("- **Default**:", "").trim();
    } else if (line.startsWith("- **Plugin**:")) {
      currentPlugin = line.replace("- **Plugin**:", "").trim();
    } else if (line.startsWith("- **Section**:")) {
      currentSectionName = line.replace("- **Section**:", "").trim();
    } else if (line.startsWith("- **Keywords**:")) {
      currentKeywords = line.replace("- **Keywords**:", "").trim();
    } else if (line.startsWith("- ") && currentKey && !currentDesc) {
      currentDesc = line.slice(2).trim();
    }
  }

  flush();

  return Response.json({ results });
}
