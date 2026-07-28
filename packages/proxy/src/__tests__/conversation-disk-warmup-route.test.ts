import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LSInstance } from "../discovery.js";
import type { ProjectInfo } from "../metadata.js";

const {
  mockFindProjectIdForWorkspaceUri,
  mockGetInstances,
  mockGetProjectInfos,
  mockGetProjectNameMap,
  mockGetStepCount,
  mockRpcCall,
  mockRpcForConversation,
  mockScanDiskConversations,
} = vi.hoisted(() => ({
  mockFindProjectIdForWorkspaceUri: vi.fn(),
  mockGetInstances: vi.fn<() => Promise<LSInstance[]>>(),
  mockGetProjectInfos: vi.fn(),
  mockGetProjectNameMap: vi.fn(),
  mockGetStepCount: vi.fn(),
  mockRpcCall: vi.fn(),
  mockRpcForConversation: vi.fn(),
  mockScanDiskConversations: vi.fn(),
}));

const conversationAffinity = new Map<string, string>();
const conversationInstanceAffinity = new Map<string, LSInstance>();

vi.mock("../routing.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    discovery: {
      getInstances: mockGetInstances,
      getInstance: async () => (await mockGetInstances())[0] ?? null,
    },
    rpc: { call: mockRpcCall },
    rpcForConversation: mockRpcForConversation,
    getStepCount: mockGetStepCount,
    conversationAffinity,
    conversationInstanceAffinity,
  };
});

vi.mock("../metadata.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    findProjectIdForWorkspaceUri: mockFindProjectIdForWorkspaceUri,
    getProjectInfos: mockGetProjectInfos,
    getProjectNameMap: mockGetProjectNameMap,
    scanDiskConversations: mockScanDiskConversations,
  };
});

const { registerConversationRoutes } = await import("../routes/conversations.js");

function instance(pid: number): LSInstance {
  return {
    pid,
    httpsPort: 9000 + pid,
    httpPort: 0,
    lspPort: 0,
    csrfToken: `csrf-${pid}`,
    appDataDir: "antigravity",
    source: "daemon",
  };
}

function app() {
  const hono = new Hono();
  registerConversationRoutes(hono);
  return hono;
}

function warmUpCalls() {
  return mockRpcCall.mock.calls.filter(
    ([method]) => method === "GetCascadeTrajectorySteps",
  );
}

async function waitForWarmUpCalls(expected: number) {
  await vi.waitFor(() => {
    expect(warmUpCalls()).toHaveLength(expected);
  });
}

const defaultProjectInfos: ProjectInfo[] = [
  {
    id: "project-a",
    name: "Project A",
    folderUris: ["file:///work/project-a"],
  },
];

describe("GET /api/conversations disk warm-up", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    conversationAffinity.clear();
    conversationInstanceAffinity.clear();
    mockGetProjectInfos.mockResolvedValue(defaultProjectInfos);
    mockGetProjectNameMap.mockImplementation(async (projectInfos: ProjectInfo[]) =>
      new Map(projectInfos.map((project) => [project.id, project.name])),
    );
    mockFindProjectIdForWorkspaceUri.mockResolvedValue(undefined);
    mockScanDiskConversations.mockResolvedValue([]);
    mockGetInstances.mockResolvedValue([instance(1)]);
    mockRpcCall.mockImplementation(async (method: string) => {
      if (method === "GetAllCascadeTrajectories") {
        return { trajectorySummaries: {} };
      }
      if (method === "GetCascadeTrajectorySteps") {
        return { steps: [] };
      }
      throw new Error(`unexpected RPC: ${method}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses one project metadata snapshot for all summaries in a listing", async () => {
    mockRpcCall.mockImplementation(async (method: string) => {
      if (method === "GetAllCascadeTrajectories") {
        return {
          trajectorySummaries: {
            "conversation-a": {
              summary: "A",
              stepCount: 1,
              workspaces: [
                { workspaceFolderAbsoluteUri: "file:///work/project-a/a" },
              ],
            },
            "conversation-b": {
              summary: "B",
              stepCount: 1,
              workspaces: [
                { workspaceFolderAbsoluteUri: "file:///work/project-a/b" },
              ],
            },
          },
        };
      }
      throw new Error(`unexpected RPC: ${method}`);
    });
    mockFindProjectIdForWorkspaceUri.mockImplementation(
      async (_workspaceUri: string, projectInfos: ProjectInfo[]) => {
        expect(projectInfos).toBe(defaultProjectInfos);
        return "project-a";
      },
    );

    const response = await app().request("/api/conversations");
    const body = (await response.json()) as {
      trajectorySummaries: Record<string, { projectName?: string }>;
    };

    expect(response.status).toBe(200);
    expect(mockGetProjectInfos).toHaveBeenCalledTimes(1);
    expect(mockGetProjectNameMap).toHaveBeenCalledWith(defaultProjectInfos);
    expect(mockFindProjectIdForWorkspaceUri).toHaveBeenCalledTimes(2);
    expect(body.trajectorySummaries["conversation-a"].projectName).toBe(
      "Project A",
    );
    expect(body.trajectorySummaries["conversation-b"].projectName).toBe(
      "Project A",
    );
  });

  it("does not repeat warm-up within the TTL and retries after expiry", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mockScanDiskConversations.mockResolvedValue([
      { id: "ttl-disk-conversation", mtime: "2026-07-28T00:00:00.000Z" },
    ]);

    expect((await app().request("/api/conversations")).status).toBe(200);
    await waitForWarmUpCalls(1);

    expect((await app().request("/api/conversations")).status).toBe(200);
    await Promise.resolve();
    expect(warmUpCalls()).toHaveLength(1);

    now += 60_001;
    expect((await app().request("/api/conversations")).status).toBe(200);
    await waitForWarmUpCalls(2);
  });

  it("removes a warm-up entry after the conversation is loaded", async () => {
    let loaded = false;
    mockScanDiskConversations.mockResolvedValue([
      { id: "loaded-cache-conversation", mtime: "2026-07-28T00:00:00.000Z" },
    ]);
    mockRpcCall.mockImplementation(async (method: string) => {
      if (method === "GetAllCascadeTrajectories") {
        return {
          trajectorySummaries: loaded
            ? {
                "loaded-cache-conversation": {
                  summary: "Loaded",
                  stepCount: 1,
                  lastModifiedTime: "2026-07-28T00:00:00.000Z",
                },
              }
            : {},
        };
      }
      if (method === "GetCascadeTrajectorySteps") {
        return { steps: [] };
      }
      throw new Error(`unexpected RPC: ${method}`);
    });

    expect((await app().request("/api/conversations")).status).toBe(200);
    await waitForWarmUpCalls(1);

    loaded = true;
    expect((await app().request("/api/conversations")).status).toBe(200);
    await Promise.resolve();
    expect(warmUpCalls()).toHaveLength(1);

    loaded = false;
    expect((await app().request("/api/conversations")).status).toBe(200);
    await waitForWarmUpCalls(2);
  });

  it("falls back to the next Language Server when the first cannot load the conversation", async () => {
    const first = instance(11);
    const second = instance(12);
    mockGetInstances.mockResolvedValue([first, second]);
    mockScanDiskConversations.mockResolvedValue([
      { id: "fallback-disk-conversation", mtime: "2026-07-28T00:00:00.000Z" },
    ]);
    mockRpcCall.mockImplementation(
      async (method: string, _body: unknown, target: LSInstance) => {
        if (method === "GetAllCascadeTrajectories") {
          return { trajectorySummaries: {} };
        }
        if (method === "GetCascadeTrajectorySteps") {
          if (target.pid === first.pid) throw new Error("not owned here");
          return { steps: [] };
        }
        throw new Error(`unexpected RPC: ${method}`);
      },
    );

    const response = await app().request("/api/conversations");

    expect(response.status).toBe(200);
    await waitForWarmUpCalls(2);
    expect(warmUpCalls().map((call) => (call[2] as LSInstance).pid)).toEqual([
      first.pid,
      second.pid,
    ]);
  });

  it("keeps the route successful when every Language Server warm-up attempt fails", async () => {
    mockGetInstances.mockResolvedValue([instance(21), instance(22)]);
    mockScanDiskConversations.mockResolvedValue([
      { id: "failed-disk-conversation", mtime: "2026-07-28T00:00:00.000Z" },
    ]);
    mockRpcCall.mockImplementation(async (method: string) => {
      if (method === "GetAllCascadeTrajectories") {
        return { trajectorySummaries: {} };
      }
      if (method === "GetCascadeTrajectorySteps") {
        throw new Error("cannot load");
      }
      throw new Error(`unexpected RPC: ${method}`);
    });

    const response = await app().request("/api/conversations");
    const body = (await response.json()) as {
      trajectorySummaries: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(body.trajectorySummaries).toHaveProperty("failed-disk-conversation");
    await waitForWarmUpCalls(2);
  });

  it("ranks recent disk-only conversations before applying the 100-item cap", async () => {
    const summaries = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => {
        const id = `loaded-${String(index).padStart(3, "0")}`;
        return [
          id,
          {
            summary: id,
            stepCount: 1,
            lastModifiedTime: new Date(
              Date.UTC(2026, 0, 1, 0, index),
            ).toISOString(),
          },
        ];
      }),
    );
    mockScanDiskConversations.mockResolvedValue([
      { id: "newest-disk-only", mtime: "2026-07-28T00:00:00.000Z" },
    ]);
    mockRpcCall.mockImplementation(async (method: string) => {
      if (method === "GetAllCascadeTrajectories") {
        return { trajectorySummaries: summaries };
      }
      if (method === "GetCascadeTrajectorySteps") {
        return { steps: [] };
      }
      throw new Error(`unexpected RPC: ${method}`);
    });

    const response = await app().request("/api/conversations");
    const body = (await response.json()) as {
      trajectorySummaries: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(Object.keys(body.trajectorySummaries)).toHaveLength(100);
    expect(body.trajectorySummaries).toHaveProperty("newest-disk-only");
    expect(body.trajectorySummaries).not.toHaveProperty("loaded-000");
    await waitForWarmUpCalls(1);
  });
});
