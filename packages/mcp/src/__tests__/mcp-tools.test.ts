import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { LSInstance } from "@porta/proxy/discovery.js";

const {
  mockGetInstances,
  mockRpcCall,
  mockRpcAny,
  mockRpcForConversation,
  mockGetStepCount,
  mockGetProjectInfos,
  mockFindProjectIdForWorkspaceUri,
  mockResolveProjectAssociation,
  mockGetProjectNameMap,
} = vi.hoisted(() => ({
  mockGetInstances: vi.fn<() => Promise<LSInstance[]>>(),
  mockRpcCall: vi.fn<(method: string, body: unknown, inst?: LSInstance) => Promise<unknown>>(),
  mockRpcAny: vi.fn<(method: string, body?: unknown) => Promise<unknown>>(),
  mockRpcForConversation: vi.fn(),
  mockGetStepCount: vi.fn(),
  mockGetProjectInfos: vi.fn(),
  mockFindProjectIdForWorkspaceUri: vi.fn(),
  mockResolveProjectAssociation: vi.fn(),
  mockGetProjectNameMap: vi.fn(),
}));

vi.mock("@porta/proxy/routing.js", () => {
  return {
    discovery: {
      getInstances: mockGetInstances,
    },
    rpc: { call: mockRpcCall },
    rpcAny: mockRpcAny,
    rpcForConversation: mockRpcForConversation,
    getStepCount: mockGetStepCount,
    uriToWorkspaceId: (uri: string) => uri.replace(/^file:\/\/\//, "file_").replace(/\//g, "_"),
    normalizeWorkspaceId: (id: string) => id.replace(/:/g, "_3a").toLowerCase(),
    conversationAffinity: new Map(),
    conversationInstanceAffinity: new Map(),
  };
});

vi.mock("@porta/proxy/metadata.js", () => {
  return {
    getProjectInfos: mockGetProjectInfos,
    findProjectIdForWorkspaceUri: mockFindProjectIdForWorkspaceUri,
    resolveProjectAssociation: mockResolveProjectAssociation,
    getProjectNameMap: mockGetProjectNameMap,
    extractConversationWorkspaces: (summary: any) => summary?.workspaces ?? [],
    getPrimaryWorkspaceUri: (summary: any) => summary?.workspaces?.[0]?.workspaceFolderAbsoluteUri,
    getMetadata: vi.fn().mockResolvedValue({ ideName: "porta", ideVersion: "0.1.0" }),
  };
});

vi.mock("@porta/proxy/conversation-mutations.js", () => {
  return {
    runConversationMutation: async (_id: string, fn: () => Promise<unknown>) => fn(),
  };
});

vi.mock("@porta/proxy/signals.js", () => {
  return {
    conversationSignals: {
      emit: vi.fn(),
      on: vi.fn(),
    },
  };
});

const { createAntigravityMcpServer } = await import("../server.js");

const makeInstance = (overrides: Partial<LSInstance> = {}): LSInstance => ({
  pid: 1234,
  httpsPort: 9000,
  httpPort: 0,
  lspPort: 0,
  csrfToken: "test-csrf",
  source: "daemon",
  workspaceId: "file_home_user_project",
  ...overrides,
});

describe("Antigravity MCP Server", () => {
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;

  beforeEach(async () => {
    vi.clearAllMocks();

    const mcpServer = createAntigravityMcpServer();
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);

    client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  it("lists all 16 required antigravity tools", async () => {
    const result = await client.listTools();
    const toolNames = result.tools.map((t) => t.name).sort();

    expect(toolNames).toEqual([
      "antigravity_answer_question",
      "antigravity_command_action",
      "antigravity_continue",
      "antigravity_delete",
      "antigravity_file_permission",
      "antigravity_get_conversation",
      "antigravity_get_steps",
      "antigravity_list_conversations",
      "antigravity_list_projects",
      "antigravity_list_workspaces",
      "antigravity_models",
      "antigravity_revert",
      "antigravity_search_conversations",
      "antigravity_start",
      "antigravity_status",
      "antigravity_stop",
      "antigravity_wait",
    ]);
  });

  it("antigravity_list_projects returns projects from metadata", async () => {
    mockGetProjectInfos.mockResolvedValue([
      { id: "proj-1", name: "Porta", folderUris: ["file:///Users/wilden/Projects/porta"], selectionPriority: 7 },
    ]);

    const res = await client.callTool({ name: "antigravity_list_projects", arguments: {} });
    const text = (res.content[0] as any).text;
    const data = JSON.parse(text);

    expect(data.projects).toEqual([
      { id: "proj-1", name: "Porta", folderUris: ["file:///Users/wilden/Projects/porta"], selectionPriority: 7 },
    ]);
  });

  it("antigravity_start initiates StartCascade and associates projectId", async () => {
    const inst = makeInstance({ workspaceId: "file_users_wilden_projects_porta" });
    mockGetInstances.mockResolvedValue([inst]);
    mockFindProjectIdForWorkspaceUri.mockResolvedValue("proj-porta");
    mockRpcCall.mockResolvedValue({ cascadeId: "cascade-123" });
    mockRpcForConversation.mockResolvedValue({ ok: true });

    const res = await client.callTool({
      name: "antigravity_start",
      arguments: {
        workspaceUri: "file:///Users/wilden/Projects/porta",
        prompt: "hello agent",
      },
    });

    const data = JSON.parse((res.content[0] as any).text);
    expect(data.cascadeId).toBe("cascade-123");
    expect(data.projectId).toBe("proj-porta");
    expect(mockRpcCall).toHaveBeenCalledWith(
      "StartCascade",
      expect.objectContaining({
        workspaceFolderAbsoluteUri: "file:///Users/wilden/Projects/porta",
        workspaceUris: ["file:///Users/wilden/Projects/porta"],
        projectId: "proj-porta",
      }),
      inst,
    );
    expect(mockRpcForConversation).toHaveBeenCalledWith(
      "SendUserCascadeMessage",
      "cascade-123",
      expect.objectContaining({
        cascadeId: "cascade-123",
        items: [{ text: "hello agent" }],
      }),
      inst,
    );
  });

  it("antigravity_continue sends user message with serialized mutation", async () => {
    const inst = makeInstance();
    mockGetStepCount.mockResolvedValue({ count: 10, instance: inst });
    mockRpcForConversation.mockResolvedValue({ ok: true });

    const res = await client.callTool({
      name: "antigravity_continue",
      arguments: {
        conversationId: "cascade-123",
        prompt: "continue working",
      },
    });

    const data = JSON.parse((res.content[0] as any).text);
    expect(data.success).toBe(true);
    expect(mockRpcForConversation).toHaveBeenCalledWith(
      "SendUserCascadeMessage",
      "cascade-123",
      expect.objectContaining({
        cascadeId: "cascade-123",
        items: [{ text: "continue working" }],
      }),
      inst,
    );
  });

  it("antigravity_continue supports structured items and media payload", async () => {
    const inst = makeInstance();
    mockGetStepCount.mockResolvedValue({ count: 10, instance: inst });
    mockRpcForConversation.mockResolvedValue({ ok: true });

    const items = [{ text: "custom item 1" }, { text: "custom item 2" }];
    const media = [{ mimeType: "image/png", inlineData: "base64data" }];

    const res = await client.callTool({
      name: "antigravity_continue",
      arguments: {
        conversationId: "cascade-123",
        items,
        media,
      },
    });

    const data = JSON.parse((res.content[0] as any).text);
    expect(data.success).toBe(true);
    expect(mockRpcForConversation).toHaveBeenCalledWith(
      "SendUserCascadeMessage",
      "cascade-123",
      expect.objectContaining({
        cascadeId: "cascade-123",
        items,
        media,
      }),
      inst,
    );
  });

  it("antigravity_search_conversations returns matching conversations and snippets", async () => {
    mockRpcCall.mockImplementation(async (method: string, body: any) => {
      if (method === "GetAllCascadeTrajectories") {
        return {
          trajectorySummaries: {
            "c-1": { title: "Refactor MCP Server", summary: "Summary text" },
            "c-2": { title: "Other Task", summary: "Other summary" },
          },
        };
      }
      if (method === "GetCascadeTrajectorySteps") {
        if (body.cascadeId === "c-1") {
          return {
            steps: [
              { userInput: { items: [{ text: "Please help refactor the MCP bridge." }] } },
            ],
          };
        }
        if (body.cascadeId === "c-2") {
          return {
            steps: [
              { userInput: { items: [{ text: "Unrelated conversation." }] } },
            ],
          };
        }
      }
      return {};
    });

    const res = await client.callTool({
      name: "antigravity_search_conversations",
      arguments: {
        query: "refactor",
      },
    });

    const data = JSON.parse((res.content[0] as any).text);
    expect(data.query).toBe("refactor");
    expect(data.results).toHaveLength(1);
    expect(data.results[0].conversationId).toBe("c-1");
    expect(data.results[0].title).toBe("Refactor MCP Server");
    expect(data.results[0].snippets.length).toBeGreaterThan(0);
    expect(data.results[0].snippets[0].toLowerCase()).toContain("refactor");
  });

  it("antigravity_status returns simplified status and required command interaction", async () => {
    mockRpcForConversation.mockImplementation(async (method: string) => {
      if (method === "GetCascadeTrajectory") {
        return { status: "CASCADE_RUN_STATUS_RUNNING", summary: "My task" };
      }
      if (method === "GetCascadeTrajectorySteps") {
        return {
          steps: [
            {
              type: "CORTEX_STEP_TYPE_RUN_COMMAND",
              status: "CORTEX_STEP_STATUS_WAITING",
              metadata: { sourceTrajectoryStepInfo: { trajectoryId: "traj-1", stepIndex: 3 } },
              runCommand: { proposedCommandLine: "npm test" },
            },
          ],
        };
      }
      return {};
    });
    mockGetStepCount.mockResolvedValue({ count: 4, instance: undefined });

    const res = await client.callTool({
      name: "antigravity_status",
      arguments: { conversationId: "cascade-123" },
    });

    const data = JSON.parse((res.content[0] as any).text);
    expect(data.status).toBe("waiting_for_command_approval");
    expect(data.requiredInteraction).toEqual({
      type: "command",
      trajectoryId: "traj-1",
      stepIndex: 3,
      commandLine: "npm test",
    });
  });

  it("antigravity_command_action approves command with verified permission payload", async () => {
    mockRpcForConversation.mockResolvedValue({ ok: true });

    const res = await client.callTool({
      name: "antigravity_command_action",
      arguments: {
        conversationId: "cascade-123",
        trajectoryId: "traj-1",
        stepIndex: 3,
        approved: true,
      },
    });

    const data = JSON.parse((res.content[0] as any).text);
    expect(data.success).toBe(true);
    expect(mockRpcForConversation).toHaveBeenCalledWith(
      "HandleCascadeUserInteraction",
      "cascade-123",
      {
        cascadeId: "cascade-123",
        interaction: {
          trajectoryId: "traj-1",
          stepIndex: 3,
          permission: { allow: true },
        },
      },
    );
  });

  it("antigravity_file_permission submits filePermission payload", async () => {
    mockRpcForConversation.mockResolvedValue({ ok: true });

    const res = await client.callTool({
      name: "antigravity_file_permission",
      arguments: {
        conversationId: "cascade-123",
        trajectoryId: "traj-1",
        stepIndex: 4,
        allow: true,
        absolutePathUri: "file:///Users/wilden/test.txt",
        scope: 1,
      },
    });

    const data = JSON.parse((res.content[0] as any).text);
    expect(data.success).toBe(true);
    expect(mockRpcForConversation).toHaveBeenCalledWith(
      "HandleCascadeUserInteraction",
      "cascade-123",
      {
        cascadeId: "cascade-123",
        interaction: {
          trajectoryId: "traj-1",
          stepIndex: 4,
          filePermission: {
            allow: true,
            scope: 1,
            absolutePathUri: "file:///Users/wilden/test.txt",
          },
        },
      },
    );
  });

  it("antigravity_answer_question submits askQuestion payload", async () => {
    mockRpcForConversation.mockResolvedValue({ ok: true });

    const res = await client.callTool({
      name: "antigravity_answer_question",
      arguments: {
        conversationId: "cascade-123",
        trajectoryId: "traj-1",
        stepIndex: 5,
        responses: [{ selectedOptionIds: ["opt-1"] }],
      },
    });

    const data = JSON.parse((res.content[0] as any).text);
    expect(data.success).toBe(true);
    expect(mockRpcForConversation).toHaveBeenCalledWith(
      "HandleCascadeUserInteraction",
      "cascade-123",
      {
        cascadeId: "cascade-123",
        interaction: {
          trajectoryId: "traj-1",
          stepIndex: 5,
          askQuestion: {
            responses: [{ selectedOptionIds: ["opt-1"] }],
            cancelled: false,
          },
        },
      },
    );
  });

  it("antigravity_stop calls CancelCascadeInvocation", async () => {
    mockRpcForConversation.mockResolvedValue({ ok: true });

    const res = await client.callTool({
      name: "antigravity_stop",
      arguments: { conversationId: "cascade-123" },
    });

    const data = JSON.parse((res.content[0] as any).text);
    expect(data.success).toBe(true);
    expect(mockRpcForConversation).toHaveBeenCalledWith(
      "CancelCascadeInvocation",
      "cascade-123",
      { cascadeId: "cascade-123" },
    );
  });
});
