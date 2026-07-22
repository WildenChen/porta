import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api/client";
import type { AuthStatus } from "../types";
import { PORTA_VERSION } from "../version";
import { LoginPage } from "./LoginPage";

interface AuthContextValue {
  status: AuthStatus;
  refreshStatus: () => Promise<void>;
}

interface Props {
  children: ReactNode;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuthStatus() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuthStatus must be used within AuthGate");
  }
  return value;
}

export function AuthGate({ children }: Props) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refreshStatus() {
    try {
      setError(null);
      setStatus(await api.authStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to check auth");
    }
  }

  useEffect(() => {
    void refreshStatus();
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
