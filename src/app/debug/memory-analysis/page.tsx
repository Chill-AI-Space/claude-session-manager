"use client";

import { useEffect, useState } from "react";

export default function MemoryAnalysis() {
  const [analysis, setAnalysis] = useState<any>(null);

  useEffect(() => {
    // Analyze window object size
    const analyzeMemory = () => {
      const sessionKeys = Object.keys(window).filter(k => k.includes('session') || k.includes('react'));
      const refs = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers?.size || 0;
      
      // Check React internal fiber nodes
      const rootElement = document.getElementById('__next');
      let fiberNodes = 0;
      let reactComponents = 0;
      
      if (rootElement) {
        const walk = (node: any) => {
          if (node?.__reactFiber) fiberNodes++;
          if (node?.__reactProps) reactComponents++;
          for (const child of node?.children || []) {
            walk(child);
          }
        };
        walk(rootElement);
      }
      
      // Check performance.memory if available
      const perfMemory = (performance as any).memory;
      const memoryInfo = perfMemory ? {
        jsHeapSizeLimit: `${(perfMemory.jsHeapSizeLimit / 1024 / 1024).toFixed(2)} MB`,
        totalJSHeapSize: `${(perfMemory.totalJSHeapSize / 1024 / 1024).toFixed(2)} MB`,
        usedJSHeapSize: `${(perfMemory.usedJSHeapSize / 1024 / 1024).toFixed(2)} MB`,
      } : { note: "performance.memory not available (use Chrome)" };
      
      return {
        reactInternalFiberNodes: fiberNodes,
        reactComponentInstances: reactComponents,
        devtoolsRenderers: refs,
        windowKeys: sessionKeys.length,
        ...memoryInfo,
      };
    };
    
    setAnalysis(analyzeMemory());
  }, []);

  if (!analysis) return <div className="p-8">Loading...</div>;

  return (
    <div className="p-8 space-y-4">
      <h1 className="text-2xl font-bold">Memory Analysis</h1>
      <pre className="bg-gray-100 dark:bg-gray-800 p-4 rounded text-sm">
        {JSON.stringify(analysis, null, 2)}
      </pre>
      <div className="text-sm text-muted-foreground">
        <p>💡 Open Chrome DevTools → Memory → Take Heap Snapshot for detailed analysis</p>
      </div>
    </div>
  );
}
