"use client";

import { Bell, Volume2, Monitor } from "lucide-react";
import { requestBrowserNotificationPermission } from "@/hooks/useNotifications";
import { SettingsComponentProps } from "./types";

interface NotificationsSettingsProps extends SettingsComponentProps {
  onError?: (msg: string) => void;
}

export function NotificationsSettings({ settings, onUpdate, onError }: NotificationsSettingsProps) {
  return (
    <div className="space-y-4">
      <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
        Notifications — when Claude finishes
      </h2>
      <p className="text-xs text-muted-foreground leading-relaxed">
        Get notified when Claude finishes a response and is waiting for your reply.
        Works for both web and terminal sessions.
      </p>

      {/* Sound */}
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={settings.notify_sound === "true"}
          onChange={(e) => onUpdate("notify_sound", e.target.checked ? "true" : "false")}
          className="mt-1 h-4 w-4 rounded border-input accent-primary"
        />
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <Volume2 className="h-3.5 w-3.5 text-muted-foreground" />
            Sound
          </div>
          <div className="text-xs text-muted-foreground">
            Two-tone beep — audible even when the tab is in background
          </div>
        </div>
      </label>

      {/* Browser notification */}
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={settings.notify_browser === "true"}
          onChange={async (e) => {
            const checked = e.target.checked;
            if (checked) {
              const perm = await requestBrowserNotificationPermission();
              if (perm !== "granted") {
                onError?.("Browser notifications blocked — allow them in your browser settings first.");
                return;
              }
            }
            onUpdate("notify_browser", checked ? "true" : "false");
          }}
          className="mt-1 h-4 w-4 rounded border-input accent-primary"
        />
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <Bell className="h-3.5 w-3.5 text-muted-foreground" />
            Browser notification
          </div>
          <div className="text-xs text-muted-foreground">
            System popup — visible even when the window is minimized. Requires browser permission.
          </div>
        </div>
      </label>

      {/* Tab badge */}
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={settings.notify_tab_badge === "true"}
          onChange={(e) => onUpdate("notify_tab_badge", e.target.checked ? "true" : "false")}
          className="mt-1 h-4 w-4 rounded border-input accent-primary"
        />
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <Monitor className="h-3.5 w-3.5 text-muted-foreground" />
            Tab title badge
          </div>
          <div className="text-xs text-muted-foreground">
            Prepends <code className="bg-muted px-1 rounded">(N) Claude is waiting</code> to the page title — visible in the browser taskbar
          </div>
        </div>
      </label>
    </div>
  );
}
