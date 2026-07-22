import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RootRedirect } from "../App";
import { api } from "../api/client";

vi.mock("../api/client", () => ({
  api: {
    getWorkspaces: vi.fn(),
  },
}));

function LocationView() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderRoutes(initialEntry = "/") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route path="*" element={<LocationView />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RootRedirect", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(api.getWorkspaces).mockResolvedValue({
      workspaceInfos: [
        { workspaceUri: "file:///work/docker" },
        { workspaceUri: "file:///work/porta" },
      ],
    });
  });

  it("uses the configured fixed project", async () => {
    localStorage.setItem(
      "porta:settings",
      JSON.stringify({ defaultProject: { mode: "fixed", fixedProjectSlug: "porta" } }),
    );
    renderRoutes();
    expect(await screen.findByTestId("location")).toHaveTextContent("/porta");
  });

  it("uses last project when configured for last used", async () => {
    localStorage.setItem("porta:lastProjectSlug", "porta");
    renderRoutes();
    expect(await screen.findByTestId("location")).toHaveTextContent("/porta");
  });

  it("falls back to unknown when no workspace exists", async () => {
    vi.mocked(api.getWorkspaces).mockResolvedValueOnce({ workspaceInfos: [] });
    renderRoutes();
    expect(await screen.findByTestId("location")).toHaveTextContent("/unknown");
  });

  it("does not run for an explicit project or conversation URL", async () => {
    renderRoutes("/porta/conversation-id");
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/porta/conversation-id",
    );
    await waitFor(() => expect(api.getWorkspaces).not.toHaveBeenCalled());
  });
});
