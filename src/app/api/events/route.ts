import { addChangeListener } from "@/lib/file-watcher";

export const dynamic = "force-dynamic";

export async function GET() {
  const encoder = new TextEncoder();

  let keepalive: ReturnType<typeof setInterval>;
  let removeListener: () => void;

  const stream = new ReadableStream({
    start(controller) {
      // Send keepalive every 30s
      keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          clearInterval(keepalive);
          removeListener?.();
        }
      }, 30000);

      // Listen for file changes
      removeListener = addChangeListener((event) => {
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
    },
    cancel() {
      clearInterval(keepalive);
      removeListener?.();
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
