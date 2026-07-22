import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useRememberLastProject } from "../hooks/useLastProject";
import { LAST_PROJECT_STORAGE_KEY } from "../utils/projectPreference";

describe("useRememberLastProject", () => {
  beforeEach(() => localStorage.clear());

  it("saves a valid direct project route, including conversation routes", () => {
    renderHook(() =>
      useRememberLastProject("porta", "file:///work/porta", [
        { uri: "file:///work/docker" },
        { uri: "file:///work/porta" },
      ]),
    );

    expect(localStorage.getItem(LAST_PROJECT_STORAGE_KEY)).toBe("porta");
  });

  it("does not overwrite the last project for an invalid route", () => {
    localStorage.setItem(LAST_PROJECT_STORAGE_KEY, "porta");
    renderHook(() =>
      useRememberLastProject("unknown", undefined, [
        { uri: "file:///work/porta" },
      ]),
    );

    expect(localStorage.getItem(LAST_PROJECT_STORAGE_KEY)).toBe("porta");
  });
});
