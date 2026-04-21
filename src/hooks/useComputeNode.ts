"use client";

import { useState, useCallback, useEffect } from "react";

interface RemoteNodeInfo {
  id: string;
  name: string;
  online?: boolean;
}

export function useComputeNode() {
  const [nodeId, setNodeId] = useState<string>("");
  const [nodes, setNodes] = useState<RemoteNodeInfo[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setNodeId(data.default_compute_node || "");
        try {
          const parsed = JSON.parse(data.remote_nodes || "[]") as RemoteNodeInfo[];
          setNodes(parsed);
        } catch {
          setNodes([]);
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const currentNode = nodes.find((n) => n.id === nodeId) ?? null;
  const isLocal = !nodeId;

  // Cycle: local → node0 → node1 → ... → local
  const toggle = useCallback(async () => {
    if (nodes.length === 0) return;

    let nextId: string;
    if (!nodeId) {
      // local → first node
      nextId = nodes[0].id;
    } else {
      const idx = nodes.findIndex((n) => n.id === nodeId);
      if (idx === -1 || idx === nodes.length - 1) {
        // unknown or last node → local
        nextId = "";
      } else {
        // next node
        nextId = nodes[idx + 1].id;
      }
    }

    setNodeId(nextId); // optimistic
    try {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default_compute_node: nextId }),
      });
    } catch {
      setNodeId(nodeId); // revert
    }
  }, [nodeId, nodes]);

  return { nodeId, currentNode, isLocal, nodes, toggle, loaded };
}
