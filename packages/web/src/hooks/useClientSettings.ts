/**
 * Global client settings stored in localStorage.
 *
 * A single key (`porta:settings`) holds all settings across workspaces.
 * Cross-tab sync via the `storage` event.
 */

import { useState, useEffect, useCallback } from "react";
import type { ClientSettings } from "../types";
import { DEFAULT_MODEL } from "../constants";
import {
  DEFAULT_PROJECT_PREFERENCE,
  normalizeProjectPreference,
} from "../utils/projectPreference";

export const CLIENT_SETTINGS_STORAGE_KEY = "porta:settings";

export const DEFAULT_SETTINGS: ClientSettings = {
  defaultModel: DEFAULT_MODEL,
  defaultPlannerType: "conversational",
  browserNotificationsEnabled: false,
  defaultProject: DEFAULT_PROJECT_PREFERENCE,
};

export function parseClientSettings(raw: string | null): ClientSettings {
  if (!raw) return { ...DEFAULT_SETTINGS };

  try {
    const parsed = JSON.parse(raw) as Partial<ClientSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      defaultProject: normalizeProjectPreference(parsed.defaultProject),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function readClientSettings(): ClientSettings {
  try {
    return parseClientSettings(localStorage.getItem(CLIENT_SETTINGS_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(settings: ClientSettings): void {
  try {
    localStorage.setItem(CLIENT_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage full or unavailable — silently degrade
  }
}

export function useClientSettings() {
  const [settings, setSettings] = useState<ClientSettings>(readClientSettings);

  // Listen for cross-tab storage events
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === CLIENT_SETTINGS_STORAGE_KEY) {
        setSettings(readClientSettings());
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const updateSettings = useCallback((patch: Partial<ClientSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      writeSettings(next);
      return next;
    });
  }, []);

  return { settings, updateSettings } as const;
}
