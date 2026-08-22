import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LSInstance } from "@porta/proxy/discovery.js";
import { discovery, rpc } from "@porta/proxy/routing.js";
import { getProjectInfos } from "@porta/proxy/metadata.js";

export function registerAllResources(server: McpServer) {
  // antigravity://projects
  server.resource(
    "projects",
    "antigravity://projects",
    {
      description: "List of all configured Antigravity projects",
      mimeType: "application/json",
    },
    async () => {
      const projects = await getProjectInfos();
      return {
        contents: [
          {
            uri: "antigravity://projects",
            text: JSON.stringify(projects, null, 2),
            mimeType: "application/json",
          },
        ],
      };
    },
  );

  // antigravity://workspaces
  server.resource(
    "workspaces",
    "antigravity://workspaces",
    {
      description: "List of all available workspace URIs from running Antigravity instances",
      mimeType: "application/json",
    },
    async () => {
      const instances = await discovery.getInstances();
      const workspaceUris = new Set<string>();
      await Promise.allSettled(
        instances.map(async (inst: LSInstance) => {
          try {
            const data = (await rpc.call("GetWorkspaceInfos", {}, inst)) as {
              workspaceInfos?: { workspaceUri: string }[];
            };
            for (const info of data.workspaceInfos ?? []) {
              workspaceUris.add(info.workspaceUri);
            }
          } catch {
            // skip
          }
        }),
      );
      return {
        contents: [
          {
            uri: "antigravity://workspaces",
            text: JSON.stringify(Array.from(workspaceUris), null, 2),
            mimeType: "application/json",
          },
        ],
      };
    },
  );

  // antigravity://conversations
  server.resource(
    "conversations",
    "antigravity://conversations",
    {
      description: "List of recent Antigravity conversation summaries",
      mimeType: "application/json",
    },
    async () => {
      const instances = await discovery.getInstances();
      const merged: Record<string, unknown> = {};
      await Promise.allSettled(
        instances.map(async (inst: LSInstance) => {
          try {
            const data = await rpc.call<{
              trajectorySummaries?: Record<string, unknown>;
            }>("GetAllCascadeTrajectories", {}, inst);
            Object.assign(merged, data.trajectorySummaries ?? {});
          } catch {
            // skip
          }
        }),
      );
      return {
        contents: [
          {
            uri: "antigravity://conversations",
            text: JSON.stringify(merged, null, 2),
            mimeType: "application/json",
          },
        ],
      };
    },
  );
}
