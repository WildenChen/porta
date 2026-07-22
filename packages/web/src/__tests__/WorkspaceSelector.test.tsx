import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSelector } from "../components/WorkspaceSelector";
import { LAST_PROJECT_STORAGE_KEY } from "../utils/projectPreference";

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
});
