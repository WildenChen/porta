import type { ProjectPreference } from "../types";

export const LAST_PROJECT_STORAGE_KEY = "porta:lastProjectSlug";

export const DEFAULT_PROJECT_PREFERENCE: ProjectPreference = {
  mode: "last-used",
};

export function normalizeProjectPreference(value: unknown): ProjectPreference {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_PROJECT_PREFERENCE };
  }

  const candidate = value as { mode?: unknown; fixedProjectSlug?: unknown };
  if (candidate.mode !== "fixed") {
    return { ...DEFAULT_PROJECT_PREFERENCE };
  }

  const fixedProjectSlug =
    typeof candidate.fixedProjectSlug === "string"
      ? candidate.fixedProjectSlug.trim()
      : "";

  return fixedProjectSlug
    ? { mode: "fixed", fixedProjectSlug }
    : { ...DEFAULT_PROJECT_PREFERENCE };
}

export function readLastProjectSlug(): string | null {
  try {
    const value = localStorage.getItem(LAST_PROJECT_STORAGE_KEY)?.trim();
    return value && value !== "unknown" ? value : null;
  } catch {
    return null;
  }
}

export function rememberLastProjectSlug(
  slug: string | null | undefined,
  validProjectSlugs: Iterable<string>,
): boolean {
  const normalized = slug?.trim();
  if (!normalized || normalized === "unknown") return false;

  const validSlugs =
    validProjectSlugs instanceof Set
      ? validProjectSlugs
      : new Set(validProjectSlugs);
  if (!validSlugs.has(normalized)) return false;

  try {
    localStorage.setItem(LAST_PROJECT_STORAGE_KEY, normalized);
    return true;
  } catch {
    return false;
  }
}

interface ResolveDefaultProjectArgs {
  validProjectSlugs: string[];
  preference: ProjectPreference;
  lastProjectSlug: string | null;
}

export function resolveDefaultProject({
  validProjectSlugs,
  preference,
  lastProjectSlug,
}: ResolveDefaultProjectArgs): string | null {
  const validSlugs = validProjectSlugs.filter(
    (slug) => slug.trim().length > 0 && slug !== "unknown",
  );
  const validSet = new Set(validSlugs);

  if (
    preference.mode === "fixed" &&
    preference.fixedProjectSlug &&
    validSet.has(preference.fixedProjectSlug)
  ) {
    return preference.fixedProjectSlug;
  }

  if (lastProjectSlug && validSet.has(lastProjectSlug)) {
    return lastProjectSlug;
  }

  return validSlugs[0] ?? null;
}
