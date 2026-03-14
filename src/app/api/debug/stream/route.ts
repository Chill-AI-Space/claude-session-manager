/**
 * GET /api/debug/stream — SSE endpoint for real-time debug logs.
 *
 * On connect: replays buffered entries, then streams new ones.
 * Requires debug_mode=true setting (returns 403 otherwise).
 *
 * Usage:
 *   curl -N http://localhost:3000/api/debug/stream
 *   Or open in browser — renders as plain text SSE stream.
 */
import { isDebugEnabled, getBufferedEntries, subscribe, subscriberCount, type LogEntry } from "@/lib/debug-logger";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isDebugEnabled()) {
    return Response.json(
      { error: "Debug mode is disabled. Enable via: PUT /api/settings {\"debug_mode\": \"true\"}" },
      { status: 403 }
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      function send(entry: LogEntry) {
        if (closed) return;
        try {
          const line = `data: ${JSON.stringify(entry)}\n\n`;
          controller.enqueue(encoder.encode(line));
        } catch {
          closed = true;
        }
      }

      function sendComment(text: string) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ${text}\n\n`));
        } catch {
          closed = true;
        }
      }

      // Replay buffer
      const buffered = getBufferedEntries();
      sendComment(`debug stream connected — ${buffered.length} buffered entries, ${subscriberCount()} active subscribers`);
      for (const entry of buffered) {
        send(entry);
      }
      sendComment("live stream starting");

      // Subscribe to new entries
      const unsubscribe = subscribe((entry) => {
        if (closed) {
          unsubscribe();
          return;
        }
        send(entry);
      });

      // Keepalive
      const keepalive = setInterval(() => {
        if (closed) {
          clearInterval(keepalive);
          unsubscribe();
          return;
        }
        sendComment("keepalive");
      }, 15_000);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
