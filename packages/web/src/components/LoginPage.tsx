import { useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api/client";
import { PORTA_VERSION } from "../version";

interface Props {
  onAuthenticated: () => void;
}

export function LoginPage({ onAuthenticated }: Props) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const status = await api.login(password);
      if (status.authenticated) {
        onAuthenticated();
        return;
      }
      setError("Invalid password");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <form className="login-form" onSubmit={handleSubmit}>
        <div className="login-heading">
          <h1 className="login-title">Porta</h1>
          <div className="login-version">{PORTA_VERSION}</div>
        </div>
        <label className="login-label" htmlFor="porta-password">
          Password
        </label>
        <input
          id="porta-password"
          className="login-input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          autoFocus
          disabled={submitting}
        />
        {error && <div className="login-error">{error}</div>}
        <button
          className="login-button"
          type="submit"
          disabled={submitting || password.length === 0}
        >
          Login
        </button>
      </form>
    </main>
  );
}
