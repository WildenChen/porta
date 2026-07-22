import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "../components/SettingsPanel";
import { api } from "../api/client";

vi.mock("../api/client", () => ({
  api: {
    models: vi.fn().mockResolvedValue({ clientModelConfigs: [] }),
    authSettings: vi.fn(),
    enablePasswordAuth: vi.fn(),
    changePasswordAuth: vi.fn(),
    disablePasswordAuth: vi.fn(),
  },
}));

function renderSettings() {
  return render(
    <SettingsPanel
      settings={{
        defaultModel: null,
        defaultPlannerType: "conversational",
        browserNotificationsEnabled: false,
      }}
      onUpdate={() => {}}
      onBack={() => {}}
      onLogout={() => {}}
    />,
  );
}

describe("authentication settings UI", () => {
  beforeEach(() => {
    vi.mocked(api.authSettings).mockResolvedValue({
      mode: "disabled",
      sessionDuration: { seconds: 604800, label: "7 days" },
      configured: true,
      status: "Disabled",
      passwordPolicy: { minLength: 8 },
      canEnablePassword: true,
    });
    vi.mocked(api.enablePasswordAuth).mockReset();
    vi.mocked(api.changePasswordAuth).mockReset();
    vi.mocked(api.disablePasswordAuth).mockReset();
  });

  it("shows authentication status and session duration", async () => {
    renderSettings();

    expect(screen.getByRole("heading", { name: "Authentication" })).toBeInTheDocument();
    expect((await screen.findAllByText("Disabled")).length).toBeGreaterThan(1);
    expect(screen.getByText("7 days")).toBeInTheDocument();
  });

  it("validates password mismatch before enabling password mode", async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.selectOptions(await screen.findByDisplayValue("Disabled"), "password");
    await user.type(screen.getByLabelText("New password"), "new-password");
    await user.type(screen.getByLabelText("Confirm password"), "different");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Passwords do not match.")).toBeInTheDocument();
    expect(api.enablePasswordAuth).not.toHaveBeenCalled();
  });

  it("validates short passwords before enabling password mode", async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.selectOptions(await screen.findByDisplayValue("Disabled"), "password");
    await user.type(screen.getByLabelText("New password"), "short");
    await user.type(screen.getByLabelText("Confirm password"), "short");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Password must be at least 8 characters.")).toBeInTheDocument();
    expect(api.enablePasswordAuth).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation before disabling password mode", async () => {
    const user = userEvent.setup();
    vi.mocked(api.authSettings).mockResolvedValue({
      mode: "password",
      sessionDuration: { seconds: 604800, label: "7 days" },
      configured: true,
      status: "Password protection enabled",
      passwordPolicy: { minLength: 8 },
      canEnablePassword: true,
    });
    renderSettings();

    await screen.findByText("Password protection enabled");
    await user.type(screen.getAllByLabelText("Current password")[1], "secret-pass");

    expect(screen.getByRole("button", { name: "Disable password mode" })).toBeDisabled();
    await user.click(screen.getByLabelText("I understand external protection must remain in place."));
    expect(screen.getByRole("button", { name: "Disable password mode" })).toBeEnabled();
  });
});
