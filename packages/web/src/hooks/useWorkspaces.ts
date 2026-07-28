import { useState, useEffect, useRef, useMemo } from "react";
import { api } from "../api/client";
import type {
  WorkspaceEntry,
  WorkspacesResponse,
} from "../types/workspaces";
import {
  workspaceNameFromMetadata,
  workspaceNameFromUri,
} from "../utils/workspaceNames";

/** Extract a short slug from a workspace URI: file:///home/user/work/porta → porta */
function slugFromUri(uri: string): string {
  return workspaceNameFromUri(uri);
}

/** Resolve a slug back to a full workspace URI using the workspace list. */
function uriFromSlug(
  slug: string,
  workspaces: Pick<WorkspaceEntry, "uri" | "name">[],
): string | undefined {
  return workspaces.find((workspace) => slugFromUri(workspace.uri) === slug)?.uri;
}

interface ConversationEntry {
  id: string;
  summary: {
    lastModifiedTime?: string;
    workspaces?: {
      workspaceFolderAbsoluteUri?: string;
      repository?: { computedName?: string };
    }[];
  };
}

interface UseWorkspacesResult {
  workspaces: WorkspaceEntry[];
  currentWorkspaceUri: string | undefined;
}

/**
 * Merge workspace sources: LS API + conversation metadata.
 * Returns a stable list of known workspaces and the resolved URI for the current URL slug.
 */
export function useWorkspaces(
  conversations: ConversationEntry[],
  projectSlug: string | undefined,
): UseWorkspacesResult {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const wsInitialized = useRef(false);

  useEffect(() => {
    // Collect from conversations and track their last modified time.
    const fromConversations = new Map<string, WorkspaceEntry>();
    const workspaceRecency = new Map<string, number>();

    for (const conversation of conversations) {
      const workspace = conversation.summary.workspaces?.[0];
      if (!workspace?.workspaceFolderAbsoluteUri) continue;
      const uri = workspace.workspaceFolderAbsoluteUri;
      fromConversations.set(uri, {
        uri,
        name: workspaceNameFromMetadata(workspace),
      });

      const time = conversation.summary.lastModifiedTime
        ? new Date(conversation.summary.lastModifiedTime).getTime()
        : 0;
      const existing = workspaceRecency.get(uri) ?? 0;
      if (time > existing) {
        workspaceRecency.set(uri, time);
      }
    }

    // Collect from the workspace API. The server includes a minimal project
    // association result when that metadata is available.
    api
      .getWorkspaces()
      .then((rawData) => {
        const data = rawData as WorkspacesResponse;
        const fromApi: WorkspaceEntry[] = (data.workspaceInfos ?? []).map(
          (workspace) => ({
            uri: workspace.workspaceUri,
            name: workspaceNameFromUri(workspace.workspaceUri),
            ...(workspace.projectAssociation
              ? { projectAssociation: workspace.projectAssociation }
              : {}),
          }),
        );

        // Assign a high score to active workspaces without past conversations
        // so that they stay at the top of the list.
        for (const workspace of fromApi) {
          if (!workspaceRecency.has(workspace.uri)) {
            workspaceRecency.set(workspace.uri, Date.now());
          }
        }

        const merged = new Map<string, WorkspaceEntry>();
        for (const workspace of fromApi) {
          merged.set(workspace.uri, workspace);
        }
        for (const [uri, workspace] of fromConversations) {
          if (!merged.has(uri)) merged.set(uri, workspace);
        }

        const list = Array.from(merged.values());
        list.sort((a, b) => {
          const timeA = workspaceRecency.get(a.uri) ?? 0;
          const timeB = workspaceRecency.get(b.uri) ?? 0;
          return timeB - timeA;
        });

        setWorkspaces(list);
        wsInitialized.current = true;
      })
      .catch(() => {
        const list = Array.from(fromConversations.values());
        list.sort((a, b) => {
          const timeA = workspaceRecency.get(a.uri) ?? 0;
          const timeB = workspaceRecency.get(b.uri) ?? 0;
          return timeB - timeA;
        });
        setWorkspaces(list);
        wsInitialized.current = true;
      });
  }, [conversations]);

  const currentWorkspaceUri = useMemo(
    () => (projectSlug ? uriFromSlug(projectSlug, workspaces) : undefined),
    [projectSlug, workspaces],
  );

  return { workspaces, currentWorkspaceUri };
}

export { slugFromUri, uriFromSlug };
export type { WorkspaceEntry } from "../types/workspaces";
