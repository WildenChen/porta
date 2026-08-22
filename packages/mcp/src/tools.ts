import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LSInstance } from "@porta/proxy/discovery.js";
import {
  discovery,
  rpc,
  rpcAny,
  rpcForConversation,
  getStepCount,
  uriToWorkspaceId,
  normalizeWorkspaceId,
  conversationAffinity,
  conversationInstanceAffinity,
} from "@porta/proxy/routing.js";
import {
  getProjectInfos,
  getProjectNameMap,
  findProjectIdForWorkspaceUri,
  resolveProjectAssociation,
  extractConversationWorkspaces,
  getPrimaryWorkspaceUri,
  getMetadata,
} from "@porta/proxy/metadata.js";
import { runConversationMutation } from "@porta/proxy/conversation-mutations.js";
import { conversationSignals } from "@porta/proxy/signals.js";
import {
  fetchConversationSteps,
  getConversationStatus,
  waitForConversation,
} from "./status.js";

function formatToolError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message, success: false }, null, 2) }],
    isError: true,
  };
}

function formatToolSuccess(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function registerAllTools(server: McpServer) {
  // 1. antigravity_list_projects
  server.tool(
    "antigravity_list_projects",
    "List all configured Antigravity projects with their IDs, decoded names, and folder URIs using existing project metadata association.",
    {},
    async () => {
      try {
        const projects = await getProjectInfos();
        return formatToolSuccess({
          projects: projects.map((p: any) => ({
            id: p.id,
            name: p.name,
            folderUris: p.folderUris,
            selectionPriority: p.selectionPriority,
          })),
        });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  // 2. antigravity_list_workspaces
  server.tool(
    "antigravity_list_workspaces",
    "List available workspaces currently operable by running Antigravity Language Server instances with project associations.",
    {
      targetApp: z.enum(["all", "antigravity", "antigravity-ide"]).optional().describe("Target engine filter"),
    },
    async ({ targetApp }) => {
      try {
        const instances = await discovery.getInstances(false, targetApp);
        const workspaceMap = new Map<string, { workspaceUri: string; gitRootUri?: string }>();
        let homeDirPath = "";
        let homeDirUri = "";

        await Promise.allSettled(
          instances.map(async (inst: LSInstance) => {
            try {
              const data = (await rpc.call("GetWorkspaceInfos", {}, inst)) as {
                homeDirPath?: string;
                homeDirUri?: string;
                workspaceInfos?: { workspaceUri: string; gitRootUri?: string }[];
              };
              if (data.homeDirPath) homeDirPath = data.homeDirPath;
              if (data.homeDirUri) homeDirUri = data.homeDirUri;
              for (const info of data.workspaceInfos ?? []) {
                workspaceMap.set(info.workspaceUri, info);
              }
            } catch {
              // Skip unreachable instance
            }
          }),
        );

        await Promise.allSettled(
          instances.map(async (inst: LSInstance) => {
            try {
              const data = await rpc.call<{
                trajectorySummaries?: Record<string, Record<string, unknown>>;
              }>("GetAllCascadeTrajectories", {}, inst);
              for (const summary of Object.values(data.trajectorySummaries ?? {})) {
                for (const workspace of extractConversationWorkspaces(summary)) {
                  const workspaceUri = workspace.workspaceFolderAbsoluteUri;
                  if (!workspaceUri || workspaceMap.has(workspaceUri)) continue;
                  workspaceMap.set(workspaceUri, {
                    workspaceUri,
                    ...(workspace.gitRootAbsoluteUri ? { gitRootUri: workspace.gitRootAbsoluteUri } : {}),
                  });
                }
              }
            } catch {
              // Fallback
            }
          }),
        );

        const projectInfos = await getProjectInfos();
        const workspaceInfos = await Promise.all(
          Array.from(workspaceMap.values()).map(async (workspace) => {
            const association = await resolveProjectAssociation(
              { workspaceUri: workspace.workspaceUri },
              projectInfos,
            );
            return {
              ...workspace,
              projectAssociation: {
                matched: association.matched,
                ...(association.projectId ? { projectId: association.projectId } : {}),
                ...(association.projectName ? { projectName: association.projectName } : {}),
                ...(association.source ? { source: association.source } : {}),
              },
            };
          }),
        );

        return formatToolSuccess({
          homeDirPath,
          homeDirUri,
          runningInstancesCount: instances.length,
          workspaces: workspaceInfos,
        });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  // 3. antigravity_list_conversations
  server.tool(
    "antigravity_list_conversations",
    "List Antigravity conversations / cascades with status, stepCount, and workspace/project metadata. Supports workspace/project filters.",
    {
      workspaceUri: z.string().optional().describe("Filter conversations by workspace folder URI"),
      projectId: z.string().optional().describe("Filter conversations by project ID"),
      targetApp: z.enum(["all", "antigravity", "antigravity-ide"]).optional().describe("Target engine filter"),
    },
    async ({ workspaceUri, projectId, targetApp }) => {
      try {
        const projectInfos = await getProjectInfos();
        const projectNameMap = await getProjectNameMap(projectInfos);
        const instances = await discovery.getInstances(false, targetApp);

        const merged: Record<string, Record<string, unknown>> = {};
        await Promise.allSettled(
          instances.map(async (inst: LSInstance) => {
            try {
              const data = await rpc.call<{
                trajectorySummaries?: Record<string, Record<string, unknown>>;
              }>("GetAllCascadeTrajectories", {}, inst);
              const summaries = data.trajectorySummaries ?? {};
              for (const [id, summary] of Object.entries(summaries)) {
                const sumObj = (summary ?? {}) as Record<string, unknown>;
                const wsUri = getPrimaryWorkspaceUri(sumObj);
                let pId = (sumObj.trajectoryMetadata as any)?.projectId;
                if (!pId && wsUri) {
                  pId = await findProjectIdForWorkspaceUri(wsUri, projectInfos);
                }
                const projectName = pId ? projectNameMap.get(pId) : undefined;
                const enriched = {
                  ...sumObj,
                  ...(pId ? { projectId: pId } : {}),
                  ...(projectName ? { projectName } : {}),
                  ...(wsUri ? { workspaceFolderAbsoluteUri: wsUri } : {}),
                };
                merged[id] = enriched;
              }
            } catch {
              // Skip
            }
          }),
        );

        let list = Object.entries(merged).map(([id, summary]) => ({
          conversationId: id,
          summary: (summary.summary as string) || (summary.title as string) || id.slice(0, 8) + "…",
          status: (summary.status as string) || "CASCADE_RUN_STATUS_IDLE",
          stepCount: (summary.stepCount as number) ?? 0,
          lastModifiedTime: summary.lastModifiedTime as string | undefined,
          createdTime: summary.createdTime as string | undefined,
          workspaceFolderAbsoluteUri: summary.workspaceFolderAbsoluteUri as string | undefined,
          projectId: summary.projectId as string | undefined,
          projectName: summary.projectName as string | undefined,
        }));

        if (workspaceUri) {
          list = list.filter((c) => c.workspaceFolderAbsoluteUri === workspaceUri);
        }
        if (projectId) {
          list = list.filter((c) => c.projectId === projectId);
        }

        return formatToolSuccess({
          total: list.length,
          conversations: list,
        });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  // 4. antigravity_get_conversation
  server.tool(
    "antigravity_get_conversation",
    "Get full metadata and trajectory configuration for a single Antigravity conversation.",
    {
      conversationId: z.string().describe("The cascade / conversation ID"),
      targetApp: z.enum(["all", "antigravity", "antigravity-ide"]).optional().describe("Target engine filter"),
    },
    async ({ conversationId, targetApp }) => {
      try {
        const data = targetApp
          ? await rpcForConversation(
              "GetCascadeTrajectory",
              conversationId,
              { cascadeId: conversationId },
              undefined,
              true,
              targetApp,
            )
          : await rpcForConversation(
              "GetCascadeTrajectory",
              conversationId,
              { cascadeId: conversationId },
              undefined,
              true,
            );
        return formatToolSuccess(data);
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  // 5. antigravity_get_steps
  server.tool(
    "antigravity_get_steps",
    "Get execution steps for a conversation with offset / limit / tail support and oversized/corrupted step recovery.",
    {
      conversationId: z.string().describe("The cascade / conversation ID"),
      offset: z.number().int().min(0).optional().describe("Step offset start index (defaults to 0)"),
      limit: z.number().int().min(1).max(500).optional().describe("Maximum steps to return (defaults to all/100)"),
      tail: z.number().int().min(1).max(500).optional().describe("Return only the last N steps (overrides offset)"),
      targetApp: z.enum(["all", "antigravity", "antigravity-ide"]).optional().describe("Target engine filter"),
    },
    async ({ conversationId, offset, limit, tail, targetApp }) => {
      try {
        const res = await fetchConversationSteps(conversationId, { offset, limit, tail, targetApp });
        return formatToolSuccess(res);
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  // 6. antigravity_start
  server.tool(
    "antigravity_start",
    "Start a new Antigravity agent task / conversation in a workspace. Automatically resolves and injects projectId association.",
    {
      workspaceUri: z.string().describe("Target workspace folder URI (e.g. file:///Users/name/project)"),
      prompt: z.string().optional().describe("Initial user prompt to start the agent with"),
      model: z.string().optional().describe("Model name (optional)"),
      plannerType: z.enum(["planning", "conversational"]).optional().describe("Planner type mode (defaults to conversational)"),
      fileAccessGranted: z.boolean().optional().describe("Grant file system access permission (defaults to true)"),
      targetApp: z.enum(["all", "antigravity", "antigravity-ide"]).optional().describe("Target engine filter"),
    },
    async ({ workspaceUri, prompt, model, plannerType, fileAccessGranted = true, targetApp }) => {
      try {
        const metadata = await getMetadata(!!fileAccessGranted);
        const instances = await discovery.getInstances(false, targetApp);
        if (instances.length === 0) {
          throw new Error("No running Antigravity Language Server found. Please ensure Antigravity is open.");
        }

        let targetInstance: LSInstance | undefined;
        if (workspaceUri) {
          const wsId = normalizeWorkspaceId(uriToWorkspaceId(workspaceUri));
          targetInstance = instances.find((i: LSInstance) => i.workspaceId && normalizeWorkspaceId(i.workspaceId) === wsId);
          targetInstance ??= instances.filter((i: LSInstance) => !i.workspaceId).length === 1 ? instances.find((i: LSInstance) => !i.workspaceId) : undefined;
          if (!targetInstance) {
            throw new Error(`No Language Server instance found for workspace: ${workspaceUri}. Open the project in Antigravity first.`);
          }
        } else {
          targetInstance = instances[0];
        }

        const projectId = await findProjectIdForWorkspaceUri(workspaceUri);
        const typeConfig = plannerType === "planning" ? { planning: {} } : { conversational: {} };
        const cascadeConfig =
          model || plannerType
            ? {
                plannerConfig: {
                  plannerTypeConfig: typeConfig,
                  ...(model ? { requestedModel: { model } } : {}),
                },
              }
            : undefined;

        const startReq: Record<string, unknown> = {
          metadata,
          source: "CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT",
          workspaceFolderAbsoluteUri: workspaceUri,
          workspaceUris: [workspaceUri],
          ...(projectId
            ? {
                projectId,
                trajectoryMetadata: {
                  projectId,
                },
              }
            : {}),
          ...(cascadeConfig ? { cascadeConfig } : {}),
        };

        const data = (await rpc.call("StartCascade", startReq, targetInstance)) as Record<string, unknown>;
        const newId = data?.cascadeId as string | undefined;
        if (newId) {
          if (workspaceUri) {
            conversationAffinity.set(newId, uriToWorkspaceId(workspaceUri));
          } else if (targetInstance?.workspaceId) {
            conversationAffinity.set(newId, targetInstance.workspaceId);
          }
          if (targetInstance && !targetInstance.workspaceId) {
            conversationInstanceAffinity.set(newId, targetInstance);
          }
          conversationSignals.emit("activate", newId);
        }

        if (newId && prompt && prompt.trim().length > 0) {
          await runConversationMutation(newId, async () => {
            const msgReq: Record<string, unknown> = {
              metadata,
              cascadeId: newId,
              items: [{ text: prompt }],
              ...(cascadeConfig ? { cascadeConfig } : {}),
            };
            await rpcForConversation("SendUserCascadeMessage", newId, msgReq, targetInstance);
          });
        }

        return formatToolSuccess({
          success: true,
          cascadeId: newId,
          conversationId: newId,
          workspaceUri,
          projectId,
          raw: data,
        });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  // 7. antigravity_continue
  server.tool(
    "antigravity_continue",
    "Send a new user prompt / message to an existing conversation with serialized mutation ordering.",
    {
      conversationId: z.string().describe("The cascade / conversation ID"),
      prompt: z.string().describe("Prompt or message text"),
      model: z.string().optional().describe("Model name (optional)"),
      plannerType: z.enum(["planning", "conversational"]).optional().describe("Planner type (optional)"),
      fileAccessGranted: z.boolean().optional().describe("Grant file system access permission (defaults to true)"),
      targetApp: z.enum(["all", "antigravity", "antigravity-ide"]).optional().describe("Target engine filter"),
    },
    async ({ conversationId, prompt, model, plannerType, fileAccessGranted = true, targetApp }) => {
      try {
        const result = await runConversationMutation(conversationId, async () => {
          const metadata = await getMetadata(!!fileAccessGranted);
          const { instance } = await getStepCount(conversationId, undefined, false, targetApp);
          const typeConfig = plannerType === "planning" ? { planning: {} } : { conversational: {} };
          const req: Record<string, unknown> = {
            metadata,
            cascadeId: conversationId,
            items: [{ text: prompt }],
          };
          if (model || plannerType) {
            req.cascadeConfig = {
              plannerConfig: {
                plannerTypeConfig: typeConfig,
                ...(model ? { requestedModel: { model } } : {}),
              },
            };
          }
          conversationSignals.emit("activate", conversationId);
          return targetApp
            ? await rpcForConversation("SendUserCascadeMessage", conversationId, req, instance, false, targetApp)
            : await rpcForConversation("SendUserCascadeMessage", conversationId, req, instance);
        });
        return formatToolSuccess({ success: true, conversationId, result });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  // 8. antigravity_stop
  server.tool(
    "antigravity_stop",
    "Cancel and stop the active execution of an ongoing conversation.",
    {
      conversationId: z.string().describe("The cascade / conversation ID"),
      targetApp: z.enum(["all", "antigravity", "antigravity-ide"]).optional().describe("Target engine filter"),
    },
    async ({ conversationId, targetApp }) => {
      try {
        const data = targetApp
          ? await rpcForConversation("CancelCascadeInvocation", conversationId, { cascadeId: conversationId }, undefined, false, targetApp)
          : await rpcForConversation("CancelCascadeInvocation", conversationId, { cascadeId: conversationId });
        return formatToolSuccess({ success: true, conversationId, result: data });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  // 9. antigravity_delete
  server.tool(
    "antigravity_delete",
    "Permanently delete a conversation trajectory and its persisted state.",
    {
      conversationId: z.string().describe("The cascade / conversation ID"),
      targetApp: z.enum(["all", "antigravity", "antigravity-ide"]).optional().describe("Target engine filter"),
    },
    async ({ conversationId, targetApp }) => {
      try {
        const result = await runConversationMutation(conversationId, async () => {
          const metadata = await getMetadata(true);
          const data = targetApp
            ? await rpcForConversation("DeleteCascadeTrajectory", conversationId, { metadata, cascadeId: conversationId }, undefined, false, targetApp)
            : await rpcForConversation("DeleteCascadeTrajectory", conversationId, { metadata, cascadeId: conversationId });
          return data;
        });
        return formatToolSuccess({ success: true, conversationId, result });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  // 10. antigravity_revert
  server.tool(
    "antigravity_revert",
    "Revert a conversation back to a previous step index, optionally editing text.",
    {
      conversationId: z.string().describe("The cascade / conversation ID"),
      stepIndex: z.number().int().min(0).describe("The step index to revert back to"),
      editText: z.string().optional().describe("Optional new text for that step"),
      targetApp: z.enum(["all", "antigravity", "antigravity-ide"]).optional().describe("Target engine filter"),
    },
    async ({ conversationId, stepIndex, editText, targetApp }) => {
      try {
        const result = await runConversationMutation(conversationId, async () => {
          const metadata = await getMetadata(true);
          const req: Record<string, unknown> = {
            cascadeId: conversationId,
            stepIndex,
            ...(editText !== undefined ? { editText } : {}),
            metadata,
          };
          const data = targetApp
            ? await rpcForConversation("RevertToCascadeStep", conversationId, req, undefined, false, targetApp)
            : await rpcForConversation("RevertToCascadeStep", conversationId, req);
          conversationSignals.emit("activate", conversationId);
          return data;
        });
        return formatToolSuccess({ success: true, conversationId, stepIndex, result });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  // 11. antigravity_command_action
  server.tool(
    "antigravity_command_action",
    "Approve or reject a proposed terminal command requested by the Antigravity agent.",
    {
      conversationId: z.string().describe("The cascade / conversation ID"),
      trajectoryId: z.string().describe("The trajectory ID from the step metadata"),
      stepIndex: z.number().int().describe("The step index from the step metadata"),
      approved: z.boolean().describe("Whether to approve (true) or reject (false) the command"),
      targetApp: z.enum(["all", "antigravity", "antigravity-ide"]).optional().describe("Target engine filter"),
    },
    async ({ conversationId, trajectoryId, stepIndex, approved, targetApp }) => {
      try {
        const payload = {
          cascadeId: conversationId,
          interaction: {
            trajectoryId,
            stepIndex: Number(stepIndex),
            permission: {
              allow: !!approved,
            },
          },
        };
        const data = targetApp
          ? await rpcForConversation("HandleCascadeUserInteraction", conversationId, payload, undefined, false, targetApp)
          : await rpcForConversation("HandleCascadeUserInteraction", conversationId, payload);
        conversationSignals.emit("activate", conversationId);
        return formatToolSuccess({ success: true, approved, result: data });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  // 12. antigravity_file_permission
  server.tool(
    "antigravity_file_permission",
    "Allow or deny a file system read/write permission requested by the Antigravity agent.",
    {
      conversationId: z.string().describe("The cascade / conversation ID"),
      trajectoryId: z.string().describe("The trajectory ID from the step metadata"),
      stepIndex: z.number().int().describe("The step index from the step metadata"),
      allow: z.boolean().describe("Whether to allow (true) or deny (false) access"),
      absolutePathUri: z.string().describe("The absolute path URI requested"),
      scope: z.number().int().optional().describe("Permission scope (0 = once/default, 1 = session/workspace)"),
      targetApp: z.enum(["all", "antigravity", "antigravity-ide"]).optional().describe("Target engine filter"),
    },
    async ({ conversationId, trajectoryId, stepIndex, allow, absolutePathUri, scope = 0, targetApp }) => {
      try {
        const payload = {
          cascadeId: conversationId,
          interaction: {
            trajectoryId,
            stepIndex: Number(stepIndex),
            filePermission: {
              allow: !!allow,
              scope: Number(scope) || 0,
              absolutePathUri,
            },
          },
        };
        const data = targetApp
          ? await rpcForConversation("HandleCascadeUserInteraction", conversationId, payload, undefined, false, targetApp)
          : await rpcForConversation("HandleCascadeUserInteraction", conversationId, payload);
        conversationSignals.emit("activate", conversationId);
        return formatToolSuccess({ success: true, allow, absolutePathUri, result: data });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  // 13. antigravity_answer_question
  server.tool(
    "antigravity_answer_question",
    "Answer or cancel a structured multiple-choice or input prompt requested by the Antigravity agent.",
    {
      conversationId: z.string().describe("The cascade / conversation ID"),
      trajectoryId: z.string().describe("The trajectory ID from the step metadata"),
      stepIndex: z.number().int().describe("The step index from the step metadata"),
      responses: z.array(z.record(z.unknown())).optional().describe("Array of question response objects"),
      cancelled: z.boolean().optional().describe("Whether the prompt interaction was cancelled"),
      targetApp: z.enum(["all", "antigravity", "antigravity-ide"]).optional().describe("Target engine filter"),
    },
    async ({ conversationId, trajectoryId, stepIndex, responses = [], cancelled = false, targetApp }) => {
      try {
        const payload = {
          cascadeId: conversationId,
          interaction: {
            trajectoryId,
            stepIndex: Number(stepIndex),
            askQuestion: {
              responses: Array.isArray(responses) ? responses : [],
              cancelled: !!cancelled,
            },
          },
        };
        const data = targetApp
          ? await rpcForConversation("HandleCascadeUserInteraction", conversationId, payload, undefined, false, targetApp)
          : await rpcForConversation("HandleCascadeUserInteraction", conversationId, payload);
        conversationSignals.emit("activate", conversationId);
        return formatToolSuccess({ success: true, cancelled, result: data });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  // 14. antigravity_status
  server.tool(
    "antigravity_status",
    "Get aggregated high-level status of a conversation (running, waiting_for_command_approval, waiting_for_file_permission, waiting_for_question, completed, failed, cancelled, unloaded) with any required interaction payload.",
    {
      conversationId: z.string().describe("The cascade / conversation ID"),
      targetApp: z.enum(["all", "antigravity", "antigravity-ide"]).optional().describe("Target engine filter"),
    },
    async ({ conversationId, targetApp }) => {
      try {
        const status = await getConversationStatus(conversationId, targetApp);
        return formatToolSuccess(status);
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  // 15. antigravity_wait
  server.tool(
    "antigravity_wait",
    "Wait for a conversation to reach a non-running state (completed, failed, cancelled, waiting_for_approval, etc.) or timeout.",
    {
      conversationId: z.string().describe("The cascade / conversation ID"),
      timeoutSeconds: z.number().int().min(1).max(600).optional().describe("Maximum time to wait in seconds (defaults to 60)"),
      pollIntervalMs: z.number().int().min(200).max(10000).optional().describe("Polling interval in milliseconds (defaults to 1000)"),
      targetApp: z.enum(["all", "antigravity", "antigravity-ide"]).optional().describe("Target engine filter"),
    },
    async ({ conversationId, timeoutSeconds, pollIntervalMs, targetApp }) => {
      try {
        const status = await waitForConversation(conversationId, { timeoutSeconds, pollIntervalMs, targetApp });
        return formatToolSuccess(status);
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  // 16. antigravity_models
  server.tool(
    "antigravity_models",
    "List available models and configuration supported by the Antigravity Language Server.",
    {},
    async () => {
      try {
        const data = await rpcAny("GetCascadeModelConfigData");
        return formatToolSuccess(data);
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
}
