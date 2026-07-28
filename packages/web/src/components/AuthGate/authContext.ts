import { createContext, useContext } from "react";
import type { AuthStatus } from "../../types";

export interface AuthContextValue {
  status: AuthStatus;
  refreshStatus: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuthStatus(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuthStatus must be used within AuthGate");
  }
  return value;
}
