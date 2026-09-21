"use client";

import { useEffect, useState } from "react";

export interface OpencodeProfile {
  id: string;
  name: string;
  description?: string;
}

/** Fetches the OpenCode model profiles available on this machine (~/.config/opencode/profiles). */
export function useOpencodeProfiles() {
  const [profiles, setProfiles] = useState<OpencodeProfile[]>([]);
  const [currentProfile, setCurrentProfile] = useState("value");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/opencode/profiles")
      .then((response) => response.json())
      .then((data) => {
        setProfiles(Array.isArray(data.profiles) ? data.profiles : []);
        if (data.current) setCurrentProfile(data.current);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  return { profiles, currentProfile, loaded };
}
