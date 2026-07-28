import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSelector } from "../components/WorkspaceSelector";
import type { WorkspaceEntry } from "../types/workspaces";
import { LAST_PROJECT_STORAGE_KEY } from "../utils/projectPreference";

const matchedWorkspace: WorkspaceEntry = {
  uri: "file:///home/test/porta",
  name: "porta",
  projectAssociation: {
    matched: true,
    projectId: "project-porta",
    projectName: "Porta Project",
    source: "folder-uri",
  },
};

const unmatchedWorkspace: WorkspaceEntry = {
  uri: "file:///home/test/scratch",
  name: "scratch",
  projectAssociation: {
    matched: false,
  },
};

describe("WorkspaceSelector", () => {
  beforeEach(() => localStorage.clear());

  it("remembers the selected verified workspace", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <WorkspaceSelector
        workspaces={[
          { uri: "file:///work/docker", name: "Docker" },
          { uri: "file:///work/porta", name: "Porta" },
        ]}
        selected="file:///work/docker"
        onSelect={onSelect}
      />,
    );

    await user.click(screen.getByTitle("Select workspace"));
    await user.click(screen.getByRole("button", { name: "Porta" }));

    expect(onSelect).toHaveBeenCalledWith("file:///work/porta");
    expect(localStorage.getItem(LAST_PROJECT_STORAGE_KEY)).toBe("porta");
  });

  it("shows the matched Antigravity project before a conversation is created", () => {
    render(
      <WorkspaceSelector
        workspaces={[matchedWorkspace]}
        selected={matchedWorkspace.uri}
        onSelect={() => {}}
      />,
    );

    expect(
      screen.getByText("Antigravity project: Porta Project"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/may appear under Outside of Project/i),
    ).not.toBeInTheDocument();
  });

  it("shows a non-blocking warning and still allows workspace selection", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(
      <WorkspaceSelector
        workspaces={[unmatchedWorkspace, matchedWorkspace]}
        selected={unmatchedWorkspace.uri}
        onSelect={onSelect}
      />,
    );

    expect(
      screen.getByText(/may appear under Outside of Project/i),
    ).toBeInTheDocument();

    await user.click(screen.getByTitle("Select workspace"));
    expect(screen.getByText("Outside of Project")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /porta Porta Project/i }),
    );
    expect(onSelect).toHaveBeenCalledWith(matchedWorkspace.uri);
  });

  it("offers a project metadata refresh action in the workspace menu", async () => {
    const user = userEvent.setup();

    render(
      <WorkspaceSelector
        workspaces={[matchedWorkspace]}
        selected={matchedWorkspace.uri}
        onSelect={() => {}}
      />,
    );

    await user.click(screen.getByTitle("Select workspace"));

    expect(
      screen.getByRole("button", { name: "Refresh project metadata" }),
    ).toBeInTheDocument();
  });
});
