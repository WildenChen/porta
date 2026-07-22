import { useEffect } from "react";
import { slugFromUri } from "./useWorkspaces";
import { rememberLastProjectSlug } from "../utils/projectPreference";

export function useRememberLastProject(
  projectSlug: string | undefined,
  currentWorkspaceUri: string | undefined,
  workspaces: { uri: string }[],
): void {
  useEffect(() => {
    if (!projectSlug || !currentWorkspaceUri) return;
    rememberLastProjectSlug(
      projectSlug,
      workspaces.map((workspace) => slugFromUri(workspace.uri)),
    );
  }, [currentWorkspaceUri, projectSlug, workspaces]);
}
