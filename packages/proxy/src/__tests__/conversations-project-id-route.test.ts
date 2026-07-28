import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LSInstance } from "../discovery.js";

const {
  mockFindProjectIdForWorkspaceUri,
  mockGetInstances,
  mockGetStepCount,
  mockRpcCall,
  mockRpcForConversation,
  mockScanDiskConversations,
} = vi.hoisted(() => ({
  mockFindProjectIdForWorkspaceUri: vi.fn(),
  mockGetInstances: vi.fn<() => Promise<LSInstance[]>>(),
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
    scanDiskConversations: mockScanDiskConversations,
  };
});

const { registerConversationRoutes } = await import("../routes/conversations.js");

const scopedLS: LSInstance = {
  pid: 10,
  httpsPort: 9010,
  httpPort: 0,
  lspPort: 0,
  csrfToken: "test-csrf",
  source: "daemon",
  workspaceId: "file_home_user_projectA",
};

function app() {
  const hono = new Hono();
  registerConversationRoutes(hono);
  return hono;
}

describe("POST /api/conversations project association", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    conversationAffinity.clear();
    conversationInstanceAffinity.clear();
    mockGetInstances.mockResolvedValue([scopedLS]);
    mockScanDiskConversations.mockResolvedValue([]);
    mockRpcCall.mockResolvedValue({ cascadeId: "new-cascade-1" });
  });

  it("passes projectId in both StartCascade fields", async () => {
    mockFindProjectIdForWorkspaceUri.mockResolvedValue("project-a");

    const res = await app().request("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceFolderAbsoluteUri: "file:///home/user/projectA",
      }),
    });

    expect(res.status).toBe(201);
    expect(mockFindProjectIdForWorkspaceUri).toHaveBeenCalledWith(
      "file:///home/user/projectA",
    );
    expect(mockRpcCall).toHaveBeenCalledWith(
      "StartCascade",
      expect.objectContaining({
        projectId: "project-a",
        trajectoryMetadata: {
          projectId: "project-a",
        },
      }),
      scopedLS,
    );
  });

  it("does not add project fields when no association exists", async () => {
    mockFindProjectIdForWorkspaceUri.mockResolvedValue(undefined);

    const res = await app().request("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceFolderAbsoluteUri: "file:///home/user/projectA",
      }),
    });

    expect(res.status).toBe(201);
    const startPayload = mockRpcCall.mock.calls.find(
      ([method]) => method === "StartCascade",
    )?.[1] as Record<string, unknown>;
    expect(startPayload).not.toHaveProperty("projectId");
    expect(startPayload).not.toHaveProperty("trajectoryMetadata");
  });
});
