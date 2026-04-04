import fs from "fs"

/** Sync line iterator to avoid loading entire file into memory */
export function* iterateLinesSync(filePath: string): IterableIterator<string> {
  const fd = fs.openSync(filePath, "r");
  try {
    const CHUNK_SIZE = 256 * 1024; // 256KB chunks
    const buf = Buffer.alloc(CHUNK_SIZE);
    let remainder = "";

    while (true) {
      const bytesRead = fs.readSync(fd, buf, 0, CHUNK_SIZE, null);
      if (bytesRead === 0) break;
      const chunk = remainder + buf.toString("utf-8", 0, bytesRead);
      const parts = chunk.split(/\r?\n/);
      remainder = parts.pop() || "";
      for (const p of parts) {
        const trimmed = p.trim();
        if (trimmed) yield trimmed;
      }
    }
    const finalTrimmed = remainder.trim();
    if (finalTrimmed) yield finalTrimmed;
  } finally {
    fs.closeSync(fd);
  }
}
