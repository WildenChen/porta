import { useState, useEffect, useRef } from "react";
import { IconFolder } from "./Icons";
import {
  slugFromUri,
  type WorkspaceEntry,
} from "../hooks/useWorkspaces";
import { rememberLastProjectSlug } from "../utils/projectPreference";

interface Props {
  workspaces: WorkspaceEntry[];
  selected: string;
  onSelect: (uri: string) => void;
}

export function WorkspaceSelector({ workspaces, selected, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const activeWorkspace = workspaces.find(
    (workspace) => workspace.uri === selected,
  );
  const activeLabel = activeWorkspace?.name ?? "Project";
  const activeAssociation = activeWorkspace?.projectAssociation;

  return (
    <div className="model-selector workspace-project-selector" ref={ref}>
      <button
        className="model-selector-btn"
        onClick={() => setOpen((value) => !value)}
        title="Select workspace"
        type="button"
        aria-expanded={open}
      >
        <span className="model-selector-label">
          <IconFolder size={12} /> {activeLabel}
        </span>
        <span className="model-selector-caret">▾</span>
      </button>

      {activeAssociation?.matched ? (
        <div className="workspace-association-status" role="status">
          Antigravity project: {activeAssociation.projectName ?? "Linked"}
        </div>
      ) : activeAssociation ? (
        <div
          className="workspace-association-status warning"
          role="status"
        >
          No matching Antigravity project. This conversation may appear under
          Outside of Project.
        </div>
      ) : null}

      {open && (
        <div
          className="model-selector-dropdown workspace-project-dropdown"
          style={{ bottom: "auto", top: "100%", marginTop: 4, marginBottom: 0 }}
        >
          {workspaces.map((workspace) => {
            const isActive = workspace.uri === selected;
            const association = workspace.projectAssociation;
            return (
              <button
                key={workspace.uri}
                className={`model-option ${isActive ? "active" : ""}`}
                onClick={() => {
                  rememberLastProjectSlug(
                    slugFromUri(workspace.uri),
                    workspaces.map((item) => slugFromUri(item.uri)),
                  );
                  onSelect(workspace.uri);
                  setOpen(false);
                }}
                type="button"
              >
                <span className="model-option-label">{workspace.name}</span>
                {association?.matched ? (
                  <span className="model-option-meta">
                    {association.projectName ?? "Linked"}
                  </span>
                ) : association ? (
                  <span className="model-option-meta warning">
                    Outside of Project
                  </span>
                ) : null}
              </button>
            );
          })}

          <button
            className="workspace-association-refresh"
            onClick={() => window.location.reload()}
            type="button"
          >
            Refresh project metadata
          </button>
        </div>
      )}
    </div>
  );
}
