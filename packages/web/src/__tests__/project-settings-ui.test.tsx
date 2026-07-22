import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "../components/SettingsPanel";
import { useClientSettings } from "../hooks/useClientSettings";

vi.mock("../api/client", () => ({
  api: {
    models: vi.fn().mockResolvedValue({ clientModelConfigs: [] }),
    authSettings: vi.fn().mockResolvedValue({
      mode: "disabled",
      sessionDuration: { seconds: 604800, label: "7 days" },
      configured: true,
      status: "Disabled",
      passwordPolicy: { minLength: 8 },
      canEnablePassword: true,
    }),
  },
}));

const workspaces = [
  { uri: "file:///work/docker", name: "Docker Services" },
  { uri: "file:///work/porta", name: "Porta Community Edition" },
];

function SettingsHarness({ available = workspaces }: { available?: typeof workspaces }) {
  const { settings, updateSettings } = useClientSettings();
  return (
    <SettingsPanel
      settings={settings}
      onUpdate={updateSettings}
      workspaces={available}
      onBack={() => {}}
    />
  );
}

describe("default project settings UI", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to Last used and lists readable workspace names", async () => {
    const user = userEvent.setup();
    render(<SettingsHarness />);

    expect(screen.getByRole("heading", { name: "Workspace" })).toBeInTheDocument();
    expect(screen.getByLabelText("Default project mode")).toHaveValue("last-used");

    await user.selectOptions(screen.getByLabelText("Default project mode"), "fixed");
    expect(screen.getByRole("option", { name: "Docker Services" })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Porta Community Edition" }),
    ).toBeInTheDocument();
  });

  it("persists a fixed workspace and restores it after remount", async () => {
    const user = userEvent.setup();
    const first = render(<SettingsHarness />);

    await user.selectOptions(screen.getByLabelText("Default project mode"), "fixed");
    await user.selectOptions(screen.getByLabelText("Fixed workspace"), "porta");

    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem("porta:settings") ?? "{}")).toMatchObject({
        defaultProject: { mode: "fixed", fixedProjectSlug: "porta" },
      });
    });

    first.unmount();
    render(<SettingsHarness />);
    expect(screen.getByLabelText("Default project mode")).toHaveValue("fixed");
    expect(screen.getByLabelText("Fixed workspace")).toHaveValue("porta");
  });

  it("shows an unavailable warning without clearing the fixed preference", () => {
    localStorage.setItem(
      "porta:settings",
      JSON.stringify({
        defaultProject: { mode: "fixed", fixedProjectSlug: "missing" },
      }),
    );
    render(<SettingsHarness />);

    expect(
      screen.getByText(/Previously selected workspace is currently unavailable/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Fixed workspace")).toHaveValue("");
    expect(JSON.parse(localStorage.getItem("porta:settings") ?? "{}")).toMatchObject({
      defaultProject: { mode: "fixed", fixedProjectSlug: "missing" },
    });
  });

  it("handles an empty workspace list with a mobile-safe control structure", () => {
    render(<SettingsHarness available={[]} />);

    expect(screen.getByText("No workspaces are currently available.")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Fixed workspace" })).toBeDisabled();
    expect(screen.getByLabelText("Default project mode").closest(".settings-workspace-controls"))
      .toBeInTheDocument();
  });
});
