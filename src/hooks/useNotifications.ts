"use client";

import { useCallback, useEffect, useRef } from "react";

export interface NotificationSettings {
  notify_sound: boolean;
  notify_browser: boolean;
  notify_tab_badge: boolean;
}

// Play a short double-beep using Web Audio API — no audio file needed
function playBeep() {
  try {
    const ctx = new AudioContext();
    const times = [0, 0.18];
    for (const t of times) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0, ctx.currentTime + t);
      gain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.25);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.25);
    }
  } catch {
    // AudioContext may not be available
  }
}

let tabBadgeCount = 0;
const originalTitle = typeof document !== "undefined" ? document.title : "";

function setTabBadge(count: number) {
  tabBadgeCount = count;
  if (typeof document === "undefined") return;
  if (count > 0) {
    document.title = `(${count}) Claude is waiting — ${originalTitle.replace(/^\(\d+\) Claude is waiting — /, "")}`;
  } else {
    document.title = originalTitle.replace(/^\(\d+\) Claude is waiting — /, "");
  }
}

export function clearTabBadge() {
  setTabBadge(0);
}

export async function requestBrowserNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === "undefined" || !("Notification" in window)) return "denied";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  return Notification.requestPermission();
}

export function useTriggerNotification(settings: NotificationSettings | null) {
  const tabBadgeRef = useRef(0);

  // Reset tab badge when page becomes visible
  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden && tabBadgeRef.current > 0) {
        tabBadgeRef.current = 0;
        setTabBadge(0);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  return useCallback(
    (title: string) => {
      if (!settings) return;

      if (settings.notify_sound) {
        playBeep();
      }

      if (settings.notify_browser && typeof window !== "undefined" && "Notification" in window) {
        if (Notification.permission === "granted") {
          new Notification("Claude is waiting for you", {
            body: title,
            icon: "/icon.png",
            tag: "claude-waiting", // Replace previous notification instead of stacking
          });
        }
      }

      if (settings.notify_tab_badge) {
        tabBadgeRef.current += 1;
        setTabBadge(tabBadgeRef.current);
      }
    },
    [settings]
  );
}
