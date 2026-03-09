import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

interface ContentResult {
  path: string;
  line: number;
  preview: string;
}

export async function POST(request: NextRequest) {
  const { query, roots } = await request.json() as { query: string; roots: string[] };

  if (!query?.trim()) return NextResponse.json({ results: [] });
  if (!roots?.length) return NextResponse.json({ error: "roots required" }, { status: 400 });

  try {
    // Use ripgrep for fast content search
    const { stdout } = await execFileAsync(
      "rg",
      [
        "--json",
        "--max-count=3",
        "--max-filesize=1M",
        "--type-not=binary",
        "--",
        query,
        ...roots,
      ],
      { maxBuffer: 5 * 1024 * 1024, timeout: 10_000 }
    );

    const results: ContentResult[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === "match" && results.length < 100) {
          const data = msg.data;
          results.push({
            path: data.path.text,
            line: data.line_number,
            preview: data.lines.text.trim().slice(0, 200),
          });
        }
      } catch {
        // skip malformed lines
      }
    }

    return NextResponse.json({ results });
  } catch (err: unknown) {
    // rg exits with code 1 when no matches — that's not an error
    const exitCode = (err as NodeJS.ErrnoException & { code?: number }).code;
    if (exitCode === 1) return NextResponse.json({ results: [] });
    // rg not found
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ error: "ripgrep (rg) not installed" }, { status: 500 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
