import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LSInstance } from "../discovery.js";

const {
  mockGetInstances,
  mockGetProjectInfos,
  mockResolveProjectAssociation,
  mockRpcCall,
} = vi.hoisted(() => ({
  mockGetInstances: vi.fn<() => Promise<LSInstance[]>>(),
  mockGetProjectInfos: vi.fn(),
  mockResolveProjectAssociation: vi.fn(),
  mockRpcCall: vi.fn(),
}));

vi.mock("../routing.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    discovery: { getInstances: mockGetInstances },
    rpc: { call: mockRpcCall },
  };
});

vi.mock("../metadata.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getProjectInfos: mockGetProjectInfos,
    resolveProjectAssociation: mockResolveProjectAssociation,
  };
});

const { registerWorkspaceRoutes } = await import("../routes/workspaces.js");

const instance: LSInstance = {
  pid: 10,
  httpsPort: 9010,
  httpPort: 0,
  lspPort: 0,
  csrfToken: "test-csrf",
  source: "daemon",
  workspaceId: "file_home_test_project-a",
};

function app() {
  const hono = new Hono();
  registerWorkspaceRoutes(hono);
  return hono;
}

describe("GET /api/workspaces project association", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInstances.mockResolvedValue([instance]);
    mockGetProjectInfos.mockResolvedValue([
      {
        id: "project-a",
        name: "Project A",
        folderUris: ["file:///home/test/project-a"],
      },
    ]);
    mockRpcCall.mockImplementation(async (method: string) => {
      if (method === "GetWorkspaceInfos") {
        return {
          homeDirPath: "/home/test",
          homeDirUri: "file:///home/test",
          workspaceInfos: [
            {
              workspaceUri: "file:///home/test/project-a",
              gitRootUri: "file:///home/test/project-a",
            },
          ],
        };
      }
      if (method === "GetAllCascadeTrajectories") {
        return { trajectorySummaries: {} };
      }
      throw new Error(`unexpected RPC: ${method}`);
    });
  });

  it("returns only the matched project id, name, source, and status", async () => {
    mockResolveProjectAssociation.mockResolvedValue({
      workspaceUri: "file:///home/test/project-a",
      projectId: "project-a",
      projectName: "Project A",
      matched: true,
      source: "folder-uri",
    });

    const res = await app().request("/api/workspaces");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      homeDirPath: "/home/test",
      homeDirUri: "file:///home/test",
      workspaceInfos: [
        {
          workspaceUri: "file:///home/test/project-a",
          gitRootUri: "file:///home/test/project-a",
          projectAssociation: {
            matched: true,
            projectId: "project-a",
            projectName: "Project A",
            source: "folder-uri",
          },
        },
      ],
    });
    expect(mockResolveProjectAssociation).toHaveBeenCalledWith(
      { workspaceUri: "file:///home/test/project-a" },
      expect.any(Array),
    );
  });

  it("returns a non-blocking unmatched status without raw project metadata", async () => {
    mockResolveProjectAssociation.mockResolvedValue({
      workspaceUri: "file:///home/test/project-a",
      matched: false,
    });

    const res = await app().request("/api/workspaces");
    const body = (await res.json()) as {
      workspaceInfos: Array<Record<string, unknown>>;
    };

    expect(body.workspaceInfos[0]).toEqual({
      workspaceUri: "file:///home/test/project-a",
      gitRootUri: "file:///home/test/project-a",
      projectAssociation: { matched: false },
    });
    expect(JSON.stringify(body)).not.toContain("folderUris");
  });
});
