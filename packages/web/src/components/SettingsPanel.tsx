/**
 * Settings panel — global client configuration.
 *
 * Currently supports:
 *   - Default model selection
 *   - Default planner type (Fast / Plan)
 *
 * Settings are stored client-side in localStorage.
 */

import { useState, useEffect, useCallback, type FormEvent } from "react";
import { IconChevronLeft, IconCheck } from "./Icons";
import { api } from "../api/client";
import {
  getBrowserNotificationPermission,
  requestBrowserNotificationPermission,
  type BrowserNotificationPermission,
} from "../utils/browserNotifications";
import type { AuthSettings, ClientSettings } from "../types";
import {
  PORTA_GIT_SHA,
  PORTA_UPSTREAM_VERSION,
  PORTA_VERSION,
} from "../version";
import type { PlannerType } from "./ChatInput";

interface ModelConfig {
  label: string;
  modelOrAlias: { model: string };
  supportsImages: boolean;
  isRecommended: boolean;
  quotaInfo?: { remainingFraction: number };
}

interface Props {
  settings: ClientSettings;
  onUpdate: (patch: Partial<ClientSettings>) => void;
  onBack: () => void;
  onLogout?: () => void;
}

type AuthDraftMode = "disabled" | "password";

interface PasswordFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  disabled?: boolean;
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  disabled,
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="settings-password-field">
      <label className="settings-field-label" htmlFor={id}>
        {label}
      </label>
      <div className="settings-password-input-wrap">
        <input
          id={id}
          className="settings-password-input"
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          disabled={disabled}
        />
        <button
          className="settings-password-visibility"
          type="button"
          onClick={() => setVisible((next) => !next)}
          disabled={disabled}
        >
          {visible ? "Hide" : "Show"}
        </button>
      </div>
    </div>
  );
}

export function SettingsPanel({ settings, onUpdate, onBack, onLogout }: Props) {
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [fetchError, setFetchError] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [authSettings, setAuthSettings] = useState<AuthSettings | null>(null);
  const [authDraftMode, setAuthDraftMode] =
    useState<AuthDraftMode>("disabled");
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [enablePassword, setEnablePassword] = useState("");
  const [enableConfirm, setEnableConfirm] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [changePassword, setChangePassword] = useState("");
  const [changeConfirm, setChangeConfirm] = useState("");
  const [disablePassword, setDisablePassword] = useState("");
  const [disableConfirmChecked, setDisableConfirmChecked] = useState(false);
  const [notificationPermission, setNotificationPermission] =
    useState<BrowserNotificationPermission>(
      getBrowserNotificationPermission,
    );

  const fetchModels = useCallback(async (retries = 3) => {
    for (let i = 0; i < retries; i++) {
      try {
        const data = await api.models();
        setModels(data.clientModelConfigs ?? []);
        setFetchError(false);
        return;
      } catch {
        if (i < retries - 1) {
          await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
        }
      }
    }
    setFetchError(true);
  }, []);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  const fetchAuthSettings = useCallback(async () => {
    try {
      const data = await api.authSettings();
      setAuthSettings(data);
      setAuthDraftMode(data.mode);
      setAuthError(null);
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : "Unable to load authentication settings.",
      );
    }
  }, []);

  useEffect(() => {
    void fetchAuthSettings();
  }, [fetchAuthSettings]);

  useEffect(() => {
    const syncPermission = () => {
      setNotificationPermission(getBrowserNotificationPermission());
    };

    window.addEventListener("focus", syncPermission);
    return () => window.removeEventListener("focus", syncPermission);
  }, []);

  useEffect(() => {
    if (
      settings.browserNotificationsEnabled &&
      notificationPermission !== "granted"
    ) {
      onUpdate({ browserNotificationsEnabled: false });
    }
  }, [notificationPermission, onUpdate, settings.browserNotificationsEnabled]);

  const flashSaved = useCallback(() => {
    setSavedFlash(true);
    const timer = setTimeout(() => setSavedFlash(false), 1500);
    return () => clearTimeout(timer);
  }, []);

  const handleModelChange = useCallback(
    (modelId: string) => {
      const value = modelId === "__none__" ? null : modelId;
      onUpdate({ defaultModel: value });
      flashSaved();
    },
    [onUpdate, flashSaved],
  );

  const handlePlannerChange = useCallback(
    (value: string) => {
      onUpdate({ defaultPlannerType: value as PlannerType });
      flashSaved();
    },
    [onUpdate, flashSaved],
  );

  const handleNotificationsChange = useCallback(
    async (checked: boolean) => {
      if (!checked) {
        onUpdate({ browserNotificationsEnabled: false });
        flashSaved();
        return;
      }

      const permission = await requestBrowserNotificationPermission();
      setNotificationPermission(permission);
      onUpdate({ browserNotificationsEnabled: permission === "granted" });
      flashSaved();
    },
    [onUpdate, flashSaved],
  );

  const handleReset = useCallback(() => {
    onUpdate({
      defaultModel: null,
      defaultPlannerType: "conversational",
      browserNotificationsEnabled: false,
    });
    flashSaved();
  }, [onUpdate, flashSaved]);

  const validateNewPassword = useCallback(
    (password: string, confirmPassword: string): string | null => {
      const minLength = authSettings?.passwordPolicy.minLength ?? 8;
      if (password.trim().length === 0) return "Password must not be blank.";
      if (password.length < minLength) {
        return `Password must be at least ${minLength} characters.`;
      }
      if (password !== confirmPassword) return "Passwords do not match.";
      return null;
    },
    [authSettings],
  );

  const redirectToLogin = useCallback(() => {
    window.location.assign("/");
  }, []);

  const handleEnablePassword = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const validation = validateNewPassword(enablePassword, enableConfirm);
      if (validation) {
        setAuthError(validation);
        return;
      }

      setAuthLoading(true);
      setAuthError(null);
      setAuthMessage(null);
      try {
        await api.enablePasswordAuth(enablePassword, enableConfirm);
        setAuthMessage("Password protection enabled. Please log in again.");
        redirectToLogin();
      } catch (err) {
        setAuthError(err instanceof Error ? err.message : "Unable to enable password mode.");
      } finally {
        setAuthLoading(false);
      }
    },
    [enableConfirm, enablePassword, redirectToLogin, validateNewPassword],
  );

  const handleChangePassword = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const validation = validateNewPassword(changePassword, changeConfirm);
      if (validation) {
        setAuthError(validation);
        return;
      }
      if (currentPassword.trim().length === 0) {
        setAuthError("Current password is required.");
        return;
      }

      setAuthLoading(true);
      setAuthError(null);
      setAuthMessage(null);
      try {
        await api.changePasswordAuth(currentPassword, changePassword, changeConfirm);
        setAuthMessage("Password changed. Please log in again.");
        redirectToLogin();
      } catch (err) {
        setAuthError(err instanceof Error ? err.message : "Unable to change password.");
      } finally {
        setAuthLoading(false);
      }
    },
    [
      changeConfirm,
      changePassword,
      currentPassword,
      redirectToLogin,
      validateNewPassword,
    ],
  );

  const handleDisablePassword = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!disableConfirmChecked) {
        setAuthError("Confirm that external protection is still in place before disabling.");
        return;
      }
      if (disablePassword.trim().length === 0) {
        setAuthError("Current password is required.");
        return;
      }

      setAuthLoading(true);
      setAuthError(null);
      setAuthMessage(null);
      try {
        await api.disablePasswordAuth(disablePassword);
        setDisablePassword("");
        setDisableConfirmChecked(false);
        await fetchAuthSettings();
        setAuthMessage("Password protection disabled.");
      } catch (err) {
        setAuthError(err instanceof Error ? err.message : "Unable to disable password mode.");
      } finally {
        setAuthLoading(false);
      }
    },
    [disableConfirmChecked, disablePassword, fetchAuthSettings],
  );

  const notificationsChecked =
    settings.browserNotificationsEnabled &&
    notificationPermission === "granted";
  const notificationsDisabled = notificationPermission === "unsupported";
  const notificationStatus =
    notificationPermission === "unsupported"
      ? "Unsupported"
      : notificationPermission === "denied"
        ? "Blocked"
        : notificationsChecked
          ? "On"
          : "Off";

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <button
          className="settings-back-btn"
          onClick={onBack}
          title="Back to chat"
        >
          <IconChevronLeft size={18} />
        </button>
        <h1 className="settings-title">Settings</h1>
        <span className={`settings-saved-badge ${savedFlash ? "visible" : ""}`}>
          <IconCheck size={12} /> Saved
        </span>
      </div>

      <div className="settings-body">
        {/* Authentication */}
        <div className="settings-section">
          <h2 className="settings-section-title">Authentication</h2>
          <div className="settings-build-list">
            <div className="settings-build-row">
              <span>Mode</span>
              {authSettings ? (
                <select
                  className="settings-select settings-auth-mode-select"
                  value={authDraftMode}
                  onChange={(e) => setAuthDraftMode(e.target.value as AuthDraftMode)}
                  disabled={authLoading || authSettings.mode === "password"}
                >
                  <option value="disabled">Disabled</option>
                  <option value="password">Password</option>
                </select>
              ) : (
                <code>Loading</code>
              )}
            </div>
            <div className="settings-build-row">
              <span>Session duration</span>
              <code>{authSettings?.sessionDuration.label ?? "7 days"}</code>
            </div>
            <div className="settings-build-row">
              <span>Status</span>
              <code>{authSettings?.status ?? "Loading"}</code>
            </div>
          </div>

          {authError && <div className="settings-auth-error">{authError}</div>}
          {authMessage && <div className="settings-auth-message">{authMessage}</div>}

          {authSettings?.mode === "disabled" && authDraftMode === "password" && (
            <form className="settings-auth-form" onSubmit={handleEnablePassword}>
              {!authSettings.canEnablePassword && (
                <div className="settings-auth-warning">
                  Password mode can only be enabled from the local Porta host.
                </div>
              )}
              <PasswordField
                id="porta-enable-password"
                label="New password"
                value={enablePassword}
                onChange={setEnablePassword}
                autoComplete="new-password"
                disabled={authLoading || !authSettings.canEnablePassword}
              />
              <PasswordField
                id="porta-enable-confirm"
                label="Confirm password"
                value={enableConfirm}
                onChange={setEnableConfirm}
                autoComplete="new-password"
                disabled={authLoading || !authSettings.canEnablePassword}
              />
              <button
                className="settings-primary-btn"
                type="submit"
                disabled={authLoading || !authSettings.canEnablePassword}
              >
                {authLoading ? "Saving..." : "Save"}
              </button>
            </form>
          )}

          {authSettings?.mode === "password" && (
            <>
              <form className="settings-auth-form" onSubmit={handleChangePassword}>
                <PasswordField
                  id="porta-current-password"
                  label="Current password"
                  value={currentPassword}
                  onChange={setCurrentPassword}
                  autoComplete="current-password"
                  disabled={authLoading}
                />
                <PasswordField
                  id="porta-change-password"
                  label="New password"
                  value={changePassword}
                  onChange={setChangePassword}
                  autoComplete="new-password"
                  disabled={authLoading}
                />
                <PasswordField
                  id="porta-change-confirm"
                  label="Confirm new password"
                  value={changeConfirm}
                  onChange={setChangeConfirm}
                  autoComplete="new-password"
                  disabled={authLoading}
                />
                <button
                  className="settings-primary-btn"
                  type="submit"
                  disabled={authLoading}
                >
                  {authLoading ? "Saving..." : "Change password"}
                </button>
              </form>

              <form className="settings-auth-form" onSubmit={handleDisablePassword}>
                <div className="settings-auth-warning">
                  停用後，任何能連到此 Porta 服務的人都可直接存取 Antigravity。
                  確認外層保護仍存在後才停用。
                </div>
                <PasswordField
                  id="porta-disable-password"
                  label="Current password"
                  value={disablePassword}
                  onChange={setDisablePassword}
                  autoComplete="current-password"
                  disabled={authLoading}
                />
                <label className="settings-auth-confirm">
                  <input
                    type="checkbox"
                    checked={disableConfirmChecked}
                    onChange={(e) => setDisableConfirmChecked(e.target.checked)}
                    disabled={authLoading}
                  />
                  I understand external protection must remain in place.
                </label>
                <button
                  className="settings-danger-btn"
                  type="submit"
                  disabled={authLoading || !disableConfirmChecked}
                >
                  {authLoading ? "Saving..." : "Disable password mode"}
                </button>
              </form>
            </>
          )}
        </div>

        {/* ── Model ── */}
        <div className="settings-section">
          <h2 className="settings-section-title">Model</h2>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Default Model</span>
              <span className="settings-row-desc">
                The model used when you haven't explicitly selected one
                per-message. Changes apply to new messages only.
              </span>
            </div>
            <select
              className="settings-select"
              value={settings.defaultModel ?? "__none__"}
              onChange={(e) => handleModelChange(e.target.value)}
            >
              <option value="__none__">Server default</option>
              {fetchError && (
                <option disabled>⚠ Failed to load models</option>
              )}
              {models.map((m) => (
                <option key={m.modelOrAlias.model} value={m.modelOrAlias.model}>
                  {m.label}
                  {m.supportsImages ? " [Vision]" : ""}
                  {m.isRecommended ? " (Recommended)" : ""}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* ── Planner ── */}
        <div className="settings-section">
          <h2 className="settings-section-title">Planner</h2>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Default Mode</span>
              <span className="settings-row-desc">
                Fast gives direct single-step responses. Plan uses a
                multi-step structured approach for complex tasks.
              </span>
            </div>
            <select
              className="settings-select"
              value={settings.defaultPlannerType}
              onChange={(e) => handlePlannerChange(e.target.value)}
            >
              <option value="conversational">Fast</option>
              <option value="planning">Plan</option>
            </select>
          </div>
        </div>

        {/* Notifications */}
        <div className="settings-section">
          <h2 className="settings-section-title">Notifications</h2>
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Browser Notifications</span>
              <span className="settings-row-desc">
                Run completion and approval requests.
              </span>
            </div>
            <div className="settings-notification-control">
              <span className="settings-permission-status">
                {notificationStatus}
              </span>
              <label className="settings-switch">
                <input
                  type="checkbox"
                  checked={notificationsChecked}
                  disabled={notificationsDisabled}
                  onChange={(e) => {
                    void handleNotificationsChange(e.target.checked);
                  }}
                  aria-label="Browser Notifications"
                />
                <span className="settings-switch-track" />
              </label>
            </div>
          </div>
        </div>

        {/* Build */}
        <div className="settings-section">
          <h2 className="settings-section-title">About</h2>
          <div className="settings-build-list">
            <div className="settings-build-row">
              <span>Version</span>
              <code>{PORTA_VERSION}</code>
            </div>
            <div className="settings-build-row">
              <span>Based on upstream</span>
              <code>{PORTA_UPSTREAM_VERSION}</code>
            </div>
            <div className="settings-build-row">
              <span>Commit</span>
              <code>{PORTA_GIT_SHA}</code>
            </div>
          </div>
        </div>

        {/* ── Reset ── */}
        <button className="settings-reset-btn" onClick={handleReset}>
          Reset all settings to defaults
        </button>

        {onLogout && (
          <button className="settings-logout-btn" onClick={onLogout}>
            Logout
          </button>
        )}
      </div>
    </div>
  );
}
