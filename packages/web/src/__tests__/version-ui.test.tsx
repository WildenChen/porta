import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoginPage } from "../components/LoginPage";
import { SettingsPanel } from "../components/SettingsPanel";
import {
  PORTA_GIT_SHA,
  PORTA_UPSTREAM_VERSION,
  PORTA_VERSION,
} from "../version";

vi.mock("../api/client", () => ({
  api: {
    login: vi.fn(),
    models: vi.fn().mockResolvedValue({ clientModelConfigs: [] }),
  },
}));

describe("build version UI", () => {
  it("derives version metadata from build-time values", () => {
    expect(PORTA_VERSION).toBe("0.13.0+wilden.01");
    expect(PORTA_UPSTREAM_VERSION).toBe("0.13.0");
    expect(PORTA_GIT_SHA).toMatch(/^[a-f0-9]{7,}|unknown$/);
  });

  it("shows the build version on the login page", () => {
    render(<LoginPage onAuthenticated={() => {}} />);

    expect(screen.getByRole("heading", { name: "Porta" })).toBeInTheDocument();
    expect(screen.getByText("0.13.0+wilden.01")).toBeInTheDocument();
  });

  it("shows version, upstream base, and commit in settings", async () => {
    render(
      <SettingsPanel
        settings={{
          defaultModel: null,
          defaultPlannerType: "conversational",
          browserNotificationsEnabled: false,
        }}
        onUpdate={() => {}}
        onBack={() => {}}
      />,
    );

    expect(screen.getByRole("heading", { name: "About" })).toBeInTheDocument();
    expect(screen.getByText("Version")).toBeInTheDocument();
    expect(screen.getByText("0.13.0+wilden.01")).toBeInTheDocument();
    expect(screen.getByText("Based on upstream")).toBeInTheDocument();
    expect(screen.getByText("0.13.0")).toBeInTheDocument();
    expect(screen.getByText("Commit")).toBeInTheDocument();
  });
});
