import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDb();
  
  // Check database size
  const dbPath = db.name;
  const fs = require('fs');
  let dbSize = 0;
  try {
    const stats = fs.statSync(dbPath);
    dbSize = stats.size;
  } catch {}
  
  // Count sessions
  const sessionCount = db.prepare("SELECT COUNT(*) as count FROM sessions WHERE archived = 0").get() as { count: number };
  
  // Check average text sizes
  const avgSizes = db.prepare(`
    SELECT 
      AVG(LENGTH(first_prompt)) as avg_prompt,
      AVG(LENGTH(last_message)) as avg_last,
      MAX(LENGTH(first_prompt)) as max_prompt,
      MAX(LENGTH(last_message)) as max_last
    FROM sessions WHERE archived = 0
  `).get() as {
    avg_prompt: number;
    avg_last: number;
    max_prompt: number;
    max_last: number;
  };
  
  return NextResponse.json({
    dbSize: `${(dbSize / 1024 / 1024).toFixed(2)} MB`,
    sessionCount: sessionCount.count,
    avgPromptSize: `${avgSizes.avg_prompt?.toFixed(0) || 0} chars`,
    avgLastMessageSize: `${avgSizes.avg_last?.toFixed(0) || 0} chars`,
    maxPromptSize: `${avgSizes.max_prompt || 0} chars`,
    maxLastMessageSize: `${avgSizes.max_last || 0} chars`,
    estimatedMemory: `~${((avgSizes.avg_prompt + avgSizes.avg_last) * sessionCount.count * 2 / 1024 / 1024).toFixed(2)} MB (strings only)`,
  });
}
