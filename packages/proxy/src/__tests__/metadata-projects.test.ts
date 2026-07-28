import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockReaddir, mockReadFile, mockStat } = vi.hoisted(() => ({
  mockReaddir: vi.fn(),
  mockReadFile: vi.fn(),
  mockStat: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: () => "/home/test",
}));

vi.mock("node:fs/promises", () => ({
  readdir: mockReaddir,
  readFile: mockReadFile,
  stat: mockStat,
}));

const {
  findProjectIdForWorkspaceUri,
  getProjectInfos,
  getProjectNameMap,
} = await import("../metadata.js");

describe("Antigravity project metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads project names and folder URIs while excluding outside-of-project", async () => {
    mockReaddir.mockResolvedValue([
      "project-a.json",
      "outside-of-project.json",
      "notes.txt",
    ]);
    mockReadFile.mockImplementation(async (path: string) => {
      if (path.endsWith("project-a.json")) {
        return JSON.stringify({
          id: "project-a",
          name: "Project%20A",
          projectResources: {
            resources: [
              { folderUri: "file:///home/test/project-a" },
              { gitFolder: { folderUri: "file:///home/test/project-a/repo" } },
            ],
          },
        });
      }
      throw new Error(`unexpected read: ${path}`);
    });

    await expect(getProjectInfos()).resolves.toEqual([
      {
        id: "project-a",
        name: "Project A",
        folderUris: [
          "file:///home/test/project-a",
          "file:///home/test/project-a/repo",
        ],
      },
    ]);
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  it("maps project ids to decoded names", async () => {
    mockReaddir.mockResolvedValue(["project-a.json"]);
    mockReadFile.mockResolvedValue(
      JSON.stringify({ id: "project-a", name: "Project%20A" }),
    );

    const map = await getProjectNameMap();

    expect([...map.entries()]).toEqual([["project-a", "Project A"]]);
  });

  it.each([
    ["file:///home/test/project-a", "project-a"],
    ["file:///home/test/project-a/", "project-a"],
    ["file:///home/test/project-a/packages/web", "project-a"],
  ])("resolves %s to its parent project", async (workspaceUri, expected) => {
    mockReaddir.mockResolvedValue(["project-a.json"]);
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        id: "project-a",
        name: "Project A",
        projectResources: {
          resources: [{ folderUri: "file:///home/test/project-a/" }],
        },
      }),
    );

    await expect(findProjectIdForWorkspaceUri(workspaceUri)).resolves.toBe(
      expected,
    );
  });

  it("returns undefined when no project matches", async () => {
    mockReaddir.mockResolvedValue(["project-a.json"]);
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        id: "project-a",
        name: "Project A",
        projectResources: {
          resources: [{ folderUri: "file:///home/test/project-a" }],
        },
      }),
    );

    await expect(
      findProjectIdForWorkspaceUri("file:///home/test/project-b"),
    ).resolves.toBeUndefined();
    await expect(findProjectIdForWorkspaceUri(undefined)).resolves.toBeUndefined();
  });

  it("ignores invalid project JSON", async () => {
    mockReaddir.mockResolvedValue(["broken.json", "project-a.json"]);
    mockReadFile.mockImplementation(async (path: string) => {
      if (path.endsWith("broken.json")) return "{";
      return JSON.stringify({ id: "project-a", name: "Project A" });
    });

    await expect(getProjectInfos()).resolves.toEqual([
      { id: "project-a", name: "Project A", folderUris: [] },
    ]);
  });
});
