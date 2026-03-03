"use client";

import { Input } from "@/components/ui/input";
import { ProjectListItem } from "@/lib/types";
import { Search, X } from "lucide-react";

interface SessionSearchProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  projects: ProjectListItem[];
  selectedProject: string | null;
  onProjectChange: (project: string | null) => void;
  sortBy: "modified" | "created" | "tokens";
  onSortChange: (sort: "modified" | "created" | "tokens") => void;
}

export function SessionSearch({
  searchQuery,
  onSearchChange,
  projects,
  selectedProject,
  onProjectChange,
  sortBy,
  onSortChange,
}: SessionSearchProps) {
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Search sessions..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="h-8 pl-8 pr-8 text-sm"
        />
        {searchQuery && (
          <button
            onClick={() => onSearchChange("")}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="flex gap-1.5">
        <select
          value={selectedProject || ""}
          onChange={(e) =>
            onProjectChange(e.target.value || null)
          }
          className="flex-1 h-7 text-xs bg-background border border-input rounded-md px-2 text-foreground"
        >
          <option value="">All projects ({projects.length})</option>
          {projects.map((p) => (
            <option key={p.project_dir} value={p.project_dir}>
              {p.display_name} ({p.session_count})
            </option>
          ))}
        </select>

        <select
          value={sortBy}
          onChange={(e) =>
            onSortChange(
              e.target.value as "modified" | "created" | "tokens"
            )
          }
          className="h-7 text-xs bg-background border border-input rounded-md px-2 text-foreground"
        >
          <option value="modified">Recent</option>
          <option value="created">Oldest</option>
          <option value="tokens">Tokens</option>
        </select>
      </div>
    </div>
  );
}
