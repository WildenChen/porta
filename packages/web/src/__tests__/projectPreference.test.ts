import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAST_PROJECT_STORAGE_KEY,
  readLastProjectSlug,
  rememberLastProjectSlug,
  resolveDefaultProject,
} from "../utils/projectPreference";
import { parseClientSettings } from "../hooks/useClientSettings";

describe("project preference", () => {
  beforeEach(() => localStorage.clear());

  it("prefers an available fixed project", () => {
    expect(
      resolveDefaultProject({
        validProjectSlugs: ["docker", "porta"],
        preference: { mode: "fixed", fixedProjectSlug: "porta" },
        lastProjectSlug: "docker",
      }),
    ).toBe("porta");
  });

  it("falls back from an unavailable fixed project to last used", () => {
    expect(
      resolveDefaultProject({
        validProjectSlugs: ["docker", "porta"],
        preference: { mode: "fixed", fixedProjectSlug: "missing" },
        lastProjectSlug: "porta",
      }),
    ).toBe("porta");
  });

  it("falls back to the first workspace when fixed and last used are invalid", () => {
    expect(
      resolveDefaultProject({
        validProjectSlugs: ["docker", "porta"],
        preference: { mode: "fixed", fixedProjectSlug: "missing" },
        lastProjectSlug: "also-missing",
      }),
    ).toBe("docker");
  });

  it("uses an available last-used project", () => {
    expect(
      resolveDefaultProject({
        validProjectSlugs: ["docker", "porta"],
        preference: { mode: "last-used" },
        lastProjectSlug: "porta",
      }),
    ).toBe("porta");
  });

  it("falls back from an invalid last-used project to the first workspace", () => {
    expect(
      resolveDefaultProject({
        validProjectSlugs: ["docker", "porta"],
        preference: { mode: "last-used" },
        lastProjectSlug: "missing",
      }),
    ).toBe("docker");
  });

  it("returns null when there are no valid workspaces", () => {
    expect(
      resolveDefaultProject({
        validProjectSlugs: ["", "unknown"],
        preference: { mode: "last-used" },
        lastProjectSlug: "porta",
      }),
    ).toBeNull();
  });

  it("does not save empty, unknown, or unverified slugs", () => {
    localStorage.setItem(LAST_PROJECT_STORAGE_KEY, "porta");
    expect(rememberLastProjectSlug("", ["porta"])).toBe(false);
    expect(rememberLastProjectSlug("unknown", ["porta"])).toBe(false);
    expect(rememberLastProjectSlug("missing", ["porta"])).toBe(false);
    expect(readLastProjectSlug()).toBe("porta");
  });

  it("saves a verified project slug", () => {
    expect(rememberLastProjectSlug("porta", ["docker", "porta"])).toBe(true);
    expect(readLastProjectSlug()).toBe("porta");
  });

  it("falls back safely for malformed and unsupported settings", () => {
    expect(parseClientSettings("not-json").defaultProject).toEqual({
      mode: "last-used",
    });
    expect(
      parseClientSettings(JSON.stringify({ defaultProject: { mode: "future" } }))
        .defaultProject,
    ).toEqual({ mode: "last-used" });
    expect(
      parseClientSettings(
        JSON.stringify({ defaultProject: { mode: "fixed", fixedProjectSlug: "" } }),
      ).defaultProject,
    ).toEqual({ mode: "last-used" });
  });

  it("does not crash when localStorage throws", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(readLastProjectSlug()).toBeNull();
    expect(rememberLastProjectSlug("porta", ["porta"])).toBe(false);

    getItem.mockRestore();
    setItem.mockRestore();
  });
});
