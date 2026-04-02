"use client";

import { useEffect, useState, useRef } from "react";

interface MemoryStats {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
  timestamp: number;
}

interface ObjectCount {
  constructor: string;
  count: number;
  size: number;
}

export default function MemoryProfilerPage() {
  const [stats, setStats] = useState<MemoryStats[]>([]);
  const [objectCounts, setObjectCounts] = useState<ObjectCount[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Record initial snapshot
  const takeSnapshot = () => {
    if ("memory" in performance) {
      const mem = (performance as any).memory;
      const snapshot: MemoryStats = {
        usedJSHeapSize: mem.usedJSHeapSize,
        totalJSHeapSize: mem.totalJSHeapSize,
        jsHeapSizeLimit: mem.jsHeapSizeLimit,
        timestamp: Date.now(),
      };
      setStats((prev) => [...prev.slice(-20), snapshot]); // Keep last 20
      return snapshot;
    }
    return null;
  };

  // Count objects by looking at global scope and known arrays
  const countObjects = () => {
    const counts: ObjectCount[] = [];

    // Check if we have sessions data in window (from a test hook)
    const win = window as unknown as { __sessions_test__?: unknown[] };
    if (win.__sessions_test__) {
      counts.push({
        constructor: "Session Array",
        count: win.__sessions_test__.length,
        size: JSON.stringify(win.__sessions_test__).length,
      });
    }

    // Count DOM nodes
    const allElements = document.querySelectorAll("*");
    counts.push({
      constructor: "DOM Nodes",
      count: allElements.length,
      size: 0,
    });

    setObjectCounts(counts);
  };

  // Force garbage collection (Chrome-specific with --js-flags)
  const forceGC = () => {
    if ("gc" in window) {
      (window as unknown as { gc: () => void }).gc();
    } else {
      alert("GC not exposed. Restart Chrome with: --js-flags='--expose-gc'");
    }
  };

  // Start/stop recording
  const toggleRecording = () => {
    setIsRecording((prev) => {
      if (!prev) {
        intervalRef.current = setInterval(() => {
          takeSnapshot();
          countObjects();
        }, 2000);
      } else {
        if (intervalRef.current) clearInterval(intervalRef.current);
      }
      return !prev;
    });
  };

  // Clear history
  const clearHistory = () => {
    setStats([]);
  };

  // Initial snapshot
  useEffect(() => {
    takeSnapshot();
    countObjects();

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const latest = stats[stats.length - 1];
  const usedMB = latest ? (latest.usedJSHeapSize / 1024 / 1024).toFixed(1) : "N/A";
  const limitMB = latest ? (latest.jsHeapSizeLimit / 1024 / 1024).toFixed(0) : "N/A";

  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <h1 className="text-2xl font-bold mb-4">Memory Profiler</h1>

      <div className="bg-card border rounded-lg p-4 mb-4">
        <div className="flex items-center gap-4 mb-4">
          <div>
            <div className="text-sm text-muted-foreground">Current Usage</div>
            <div className="text-2xl font-bold">{usedMB} MB</div>
          </div>
          <div>
            <div className="text-sm text-muted-foreground">Heap Limit</div>
            <div className="text-lg">{limitMB} MB</div>
          </div>
          <button
            onClick={toggleRecording}
            className={`px-4 py-2 rounded ${isRecording ? "bg-red-500 hover:bg-red-600" : "bg-green-500 hover:bg-green-600"} text-white`}
          >
            {isRecording ? "Stop Recording" : "Start Recording"}
          </button>
          <button onClick={forceGC} className="px-4 py-2 rounded bg-blue-500 hover:bg-blue-600 text-white">
            Force GC
          </button>
          <button onClick={clearHistory} className="px-4 py-2 rounded bg-gray-500 hover:bg-gray-600 text-white">
            Clear History
          </button>
        </div>

        {stats.length > 1 && (
          <div className="text-sm">
            <span className="text-muted-foreground">Trend: </span>
            <span className={latest.usedJSHeapSize > stats[0].usedJSHeapSize ? "text-red-500" : "text-green-500"}>
              {((latest.usedJSHeapSize - stats[0].usedJSHeapSize) / 1024 / 1024).toFixed(1)} MB
            </span>
            <span className="text-muted-foreground"> over {stats.length} samples</span>
          </div>
        )}
      </div>

      <div className="bg-card border rounded-lg p-4 mb-4">
        <h2 className="text-lg font-semibold mb-2">Object Counts</h2>
        <div className="space-y-1">
          {objectCounts.map((obj) => (
            <div key={obj.constructor} className="flex justify-between text-sm">
              <span>{obj.constructor}</span>
              <span>
                {obj.count}
                {obj.size > 0 && ` (${(obj.size / 1024).toFixed(1)} KB)`}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-card border rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-2">Memory History</h2>
        <div className="space-y-1 max-h-64 overflow-y-auto">
          {stats.map((s, i) => (
            <div key={s.timestamp} className="flex justify-between text-sm font-mono">
              <span>{new Date(s.timestamp).toLocaleTimeString()}</span>
              <span>{(s.usedJSHeapSize / 1024 / 1024).toFixed(1)} MB</span>
              <span className="text-muted-foreground">
                {i > 0 ? (((s.usedJSHeapSize - stats[i - 1].usedJSHeapSize) / 1024 / 1024).toFixed(2)) : "-"} MB
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 p-4 bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg">
        <h3 className="font-semibold mb-2">How to use</h3>
        <ol className="list-decimal list-inside space-y-1 text-sm">
          <li>Open http://localhost:3000/claude-sessions in another tab</li>
          <li>Navigate around, scroll the session list</li>
          <li>Come back here and check memory usage</li>
          <li>Click "Force GC" to see if memory is reclaimed</li>
          <li>If memory keeps growing, check the History for the trend</li>
        </ol>
        <p className="text-xs mt-2 text-muted-foreground">
          Note: For best results, open Chrome DevTools Memory tab before starting and take heap snapshots manually.
        </p>
      </div>
    </div>
  );
}
