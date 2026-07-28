export type ProjectAssociationSource = "metadata" | "folder-uri";

export interface ProjectAssociation {
  matched: boolean;
  projectId?: string;
  projectName?: string;
  source?: ProjectAssociationSource;
}

export interface WorkspaceApiInfo {
  workspaceUri: string;
  gitRootUri?: string;
  projectAssociation?: ProjectAssociation;
}

export interface WorkspacesResponse {
  homeDirPath?: string;
  homeDirUri?: string;
  workspaceInfos?: WorkspaceApiInfo[];
}

export interface WorkspaceEntry {
  uri: string;
  name: string;
  projectAssociation?: ProjectAssociation;
}
