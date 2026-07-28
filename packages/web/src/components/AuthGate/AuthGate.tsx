import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../../api/client";
import type { AuthStatus } from "../../types";
import { PORTA_VERSION } from "../../version";
import { LoginPage } from "../LoginPage";
import { AuthContext } from "./authContext";

interface Props {
  children: ReactNode;
}

export function AuthGate({ children }: Props) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const nextStatus = await api.authStatus();
      setError(null);
      setStatus(nextStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to check auth");
    }
  }, []);

  useEffect(() => {
    let active = true;

    void api
      .authStatus()
      .then((nextStatus) => {
        if (!active) return;
        setError(null);
        setStatus(nextStatus);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Unable to check auth");
      });

    return () => {
      active = false;
    };
  }, []);

  if (error) {
    return (
      <main className="login-page">
        <div className="login-form">
          <div className="login-heading">
            <h1 className="login-title">Porta</h1>
            <div className="login-version">{PORTA_VERSION}</div>
          </div>
          <div className="login-error">{error}</div>
        </div>
      </main>
    );
  }

  if (!status) return null;

  if (!status.configured) {
    return (
      <main className="login-page">
        <div className="login-form">
          <div className="login-heading">
            <h1 className="login-title">Porta</h1>
            <div className="login-version">{PORTA_VERSION}</div>
          </div>
          <div className="login-error">
            PORTA_PASSWORD is required when password authentication is enabled.
          </div>
        </div>
      </main>
    );
  }

  if (status.enabled && !status.authenticated) {
    return <LoginPage onAuthenticated={() => void refreshStatus()} />;
  }

  return (
    <AuthContext.Provider value={{ status, refreshStatus }}>
      {children}
    </AuthContext.Provider>
  );
}
