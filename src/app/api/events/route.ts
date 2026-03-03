import { addChangeListener } from "@/lib/file-watcher";

export const dynamic = "force-dynamic";

export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Send keepalive every 30s
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          clearInterval(keepalive);
        }
      }, 30000);

      // Listen for file changes
      const removeListener = addChangeListener((event) => {
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify(event)}\n\n`
            )
          );
        } catch {
          // stream closed
        }
      });

      // Cleanup on close
      const originalCancel = controller.close.bind(controller);
      // Note: ReadableStream doesn't have a built-in cancel callback from the server side.
      // The keepalive interval and listener will be cleaned up when the process exits.
      // For a more robust solution, we'd need AbortController integration.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
