/**
 * Shared metadata and disk-scanning utilities for the proxy.
 */

import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ConversationWorkspaceMetadata {
  workspaceFolderAbsoluteUri?: string;
  gitRootAbsoluteUri?: string;
  repository?: {
    computedName?: string;
    gitOriginUrl?: string;
  };
  branchName?: string;
}

const KNOWN_APP_DATA_DIRS = ["antigravity", "antigravity-ide"] as const;
const DEFAULT_APP_DATA_DIRS = ["antigravity"] as const;

function conversationDirForAppDataDir(appDataDir: string): string {
  return join(homedir(), ".gemini", appDataDir, "conversations");
}

const DEFAULT_CONVERSATIONS_DIRS =
  DEFAULT_APP_DATA_DIRS.map(conversationDirForAppDataDir);

const CONVERSATION_EXTENSIONS = [".pb", ".db"] as const;

function conversationIdFromFilename(file: string): string | undefined {
  const extension = CONVERSATION_EXTENSIONS.find((ext) => file.endsWith(ext));
  return extension ? file.slice(0, -extension.length) : undefined;
}

/**
 * Build the metadata object that the LS requires on write RPCs.
 * Mirrors what the VS Code extension sends via MetadataProvider.
 */
export async function getMetadata(
  fileAccessGranted = false,
): Promise<Record<string, unknown>> {
  const meta: Record<string, unknown> = {
    ideName: "porta",
    ideVersion: "0.1.0",
    extensionVersion: "0.1.0",
  };
  if (fileAccessGranted) {
    meta.allowFileAccess = true;
    meta.allWorkspaceTrustGranted = true;
  }
  return meta;
}

/** Scan disk for conversation files not loaded in memory */
export async function scanDiskConversations(
  conversationsDirs: string | string[] = DEFAULT_CONVERSATIONS_DIRS,
): Promise<{ id: string; mtime: string }[]> {
  const dirs = Array.isArray(conversationsDirs)
    ? conversationsDirs
    : [conversationsDirs];
  const results = new Map<string, { id: string; mtime: string }>();

  for (const conversationsDir of dirs) {
    try {
      const files = await readdir(conversationsDir);
      for (const file of files) {
        const id = conversationIdFromFilename(file);
        if (!id) continue;
        try {
          const s = await stat(join(conversationsDir, file));
          const mtime = s.mtime.toISOString();
          const existing = results.get(id);
          if (!existing || existing.mtime < mtime) {
            results.set(id, { id, mtime });
          }
        } catch {
          results.set(id, { id, mtime: new Date().toISOString() });
        }
      }
    } catch {
      // Conversation dir missing or unreadable
    }
  }

  return [...results.values()];
}

export function conversationDirsForAppDataDirs(
  appDataDirs: Iterable<string | undefined>,
): string[] {
  const known = new Set<string>(KNOWN_APP_DATA_DIRS);
  const dirs = new Set<string>();

  for (const appDataDir of appDataDirs) {
    if (appDataDir && known.has(appDataDir)) {
      dirs.add(conversationDirForAppDataDir(appDataDir));
    }
  }

  return [...dirs];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function workspaceArray(value: unknown): ConversationWorkspaceMetadata[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((workspace) => ({
    ...(typeof workspace.workspaceFolderAbsoluteUri === "string"
      ? { workspaceFolderAbsoluteUri: workspace.workspaceFolderAbsoluteUri }
      : {}),
    ...(typeof workspace.gitRootAbsoluteUri === "string"
      ? { gitRootAbsoluteUri: workspace.gitRootAbsoluteUri }
      : {}),
    ...(isRecord(workspace.repository)
      ? {
          repository: {
            ...(typeof workspace.repository.computedName === "string"
              ? { computedName: workspace.repository.computedName }
              : {}),
            ...(typeof workspace.repository.gitOriginUrl === "string"
              ? { gitOriginUrl: workspace.repository.gitOriginUrl }
              : {}),
          },
        }
      : {}),
    ...(typeof workspace.branchName === "string"
      ? { branchName: workspace.branchName }
      : {}),
  }));
}

/**
 * Extract workspace metadata from a conversation summary.
 *
 * Antigravity 1.x exposed this at `summary.workspaces`. Antigravity 2.x still
 * exposes that for loaded conversations, but also mirrors it under
 * `summary.trajectoryMetadata.workspaces` and may only expose URI strings in
 * `summary.trajectoryMetadata.workspaceUris`.
 */
export function extractConversationWorkspaces(
  summary: unknown,
): ConversationWorkspaceMetadata[] {
  if (!isRecord(summary)) return [];

  const topLevel = workspaceArray(summary.workspaces);
  if (topLevel.length > 0) return topLevel;

  const trajectoryMetadata = summary.trajectoryMetadata;
  if (!isRecord(trajectoryMetadata)) return [];

  const metadataWorkspaces = workspaceArray(trajectoryMetadata.workspaces);
  if (metadataWorkspaces.length > 0) return metadataWorkspaces;

  if (!Array.isArray(trajectoryMetadata.workspaceUris)) return [];
  return trajectoryMetadata.workspaceUris
    .filter((uri): uri is string => typeof uri === "string")
    .map((uri) => ({ workspaceFolderAbsoluteUri: uri }));
}

export function getPrimaryWorkspaceUri(summary: unknown): string | undefined {
  return extractConversationWorkspaces(summary)[0]?.workspaceFolderAbsoluteUri;
}

export function withNormalizedConversationWorkspaces<
  T extends Record<string, unknown>,
>(summary: T): T {
  if (Array.isArray(summary.workspaces) && summary.workspaces.length > 0) {
    return summary;
  }

  const workspaces = extractConversationWorkspaces(summary);
  if (workspaces.length === 0) return summary;
  return { ...summary, workspaces };
}

function safeDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export interface ProjectInfo {
  id: string;
  name: string;
  folderUris: string[];
  /**
   * Higher values identify richer Antigravity project records. Headless/new
   * clients can leave duplicate minimal records for the same folder, so folder
   * matching must not depend on readdir order.
   */
  selectionPriority?: number;
}

export type ProjectAssociationSource = "metadata" | "folder-uri";

export interface ProjectAssociation {
  workspaceUri?: string;
  projectId?: string;
  projectName?: string;
  matched: boolean;
  source?: ProjectAssociationSource;
}

export interface ResolveProjectAssociationInput {
  workspaceUri?: string;
  projectId?: string;
}

function projectSelectionPriority(data: Record<string, unknown>): number {
  const resources = (
    data.projectResources as
      | {
          resources?: Array<{
            folderUri?: unknown;
            gitFolder?: { folderUri?: unknown };
          }>;
        }
      | undefined
  )?.resources;
  const hasGitFolder =
    Array.isArray(resources) &&
    resources.some(
      (resource) => typeof resource.gitFolder?.folderUri === "string",
    );

  // Antigravity's persisted project records carry lifecycle metadata; the
  // duplicate workspace-only records created by transient/headless clients do
  // not. Prefer the persisted record, then a Git-aware record, with the ID used
  // only as a deterministic final tie-breaker.
  return (
    (typeof data.updatedAt === "string" ? 4 : 0) +
    (data.isWorkspaceOnly === false ? 2 : 0) +
    (hasGitFolder ? 1 : 0)
  );
}

export async function getProjectInfos(): Promise<ProjectInfo[]> {
  const projects: ProjectInfo[] = [];
  const projectsDir = join(homedir(), ".gemini", "config", "projects");
  try {
    const files = await readdir(projectsDir);
    for (const file of files) {
      if (file.endsWith(".json") && file !== "outside-of-project.json") {
        try {
          const content = await readFile(join(projectsDir, file), "utf8");
          const data = JSON.parse(content);
          if (data.id && data.name) {
            const folderUris: string[] = [];
            const resources = data.projectResources?.resources;
            if (Array.isArray(resources)) {
              for (const res of resources) {
                if (typeof res.folderUri === "string") {
                  folderUris.push(res.folderUri);
                }
                if (typeof res.gitFolder?.folderUri === "string") {
                  folderUris.push(res.gitFolder.folderUri);
                }
              }
            }
            projects.push({
              id: data.id,
              name: safeDecodeUriComponent(data.name),
              folderUris,
              selectionPriority: projectSelectionPriority(data),
            });
          }
        } catch {
          // ignore invalid json
        }
      }
    }
  } catch {
    // projects dir missing or unreadable
  }
  return projects.sort(
    (left, right) =>
      (right.selectionPriority ?? 0) - (left.selectionPriority ?? 0) ||
      left.id.localeCompare(right.id),
  );
}

function normalizeProjectWorkspaceUri(workspaceUri: string): string {
  return safeDecodeUriComponent(workspaceUri).replace(/\/$/, "");
}

function findProjectForWorkspaceUri(
  workspaceUri: string,
  projects: ProjectInfo[],
): ProjectInfo | undefined {
  const normalizedTarget = normalizeProjectWorkspaceUri(workspaceUri);
  const matches: Array<{
    project: ProjectInfo;
    folderLength: number;
  }> = [];

  for (const project of projects) {
    for (const folderUri of project.folderUris) {
      const normalizedFolder = normalizeProjectWorkspaceUri(folderUri);
      if (
        normalizedTarget === normalizedFolder ||
        normalizedTarget.startsWith(normalizedFolder + "/")
      ) {
        matches.push({ project, folderLength: normalizedFolder.length });
      }
    }
  }

  matches.sort(
    (left, right) =>
      right.folderLength - left.folderLength ||
      (right.project.selectionPriority ?? 0) -
        (left.project.selectionPriority ?? 0) ||
      left.project.id.localeCompare(right.project.id),
  );

  return matches[0]?.project;
}

/**
 * Resolve the Antigravity project association used by conversation listing,
 * conversation creation, and workspace status APIs.
 *
 * A projectId already stored in conversation metadata takes precedence over
 * folder matching because it represents the association chosen when the
 * conversation was created.
 */
export async function resolveProjectAssociation(
  input: ResolveProjectAssociationInput,
  projectInfos?: ProjectInfo[],
): Promise<ProjectAssociation> {
  const projects = projectInfos ?? (await getProjectInfos());

  if (input.projectId) {
    const project = projects.find((candidate) => candidate.id === input.projectId);
    return {
      ...(input.workspaceUri ? { workspaceUri: input.workspaceUri } : {}),
      projectId: input.projectId,
      ...(project?.name ? { projectName: project.name } : {}),
      matched: true,
      source: "metadata",
    };
  }

  if (!input.workspaceUri) {
    return { matched: false };
  }

  const project = findProjectForWorkspaceUri(input.workspaceUri, projects);
  if (!project) {
    return { workspaceUri: input.workspaceUri, matched: false };
  }

  return {
    workspaceUri: input.workspaceUri,
    projectId: project.id,
    projectName: project.name,
    matched: true,
    source: "folder-uri",
  };
}

export async function getProjectNameMap(
  projectInfos?: ProjectInfo[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const projects = projectInfos ?? (await getProjectInfos());
  for (const project of projects) {
    map.set(project.id, project.name);
  }
  return map;
}

export async function findProjectIdForWorkspaceUri(
  workspaceUri: string | undefined,
  projectInfos?: ProjectInfo[],
): Promise<string | undefined> {
  return (await resolveProjectAssociation({ workspaceUri }, projectInfos)).projectId;
}
