import React, { useEffect, useState } from "react";
import { api } from "./api.js";
import { Computers, Agents, Audit } from "./pages.jsx";
import Workspace from "./Workspace.jsx";

function useHashRoute() {
  const [hash, setHash] = useState(location.hash || "#/computers");
  useEffect(() => {
    const fn = () => setHash(location.hash || "#/computers");
    window.addEventListener("hashchange", fn);
    return () => window.removeEventListener("hashchange", fn);
  }, []);
  return hash;
}

function AuthScreen({ mode }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError("");
    try {
      await api("POST", mode === "setup" ? "/api/setup" : "/api/auth/login", { username, password });
      location.reload();
    } catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <h1>Agent Computers</h1>
        {mode === "setup" ? (
          <>
            <p className="muted">Welcome — create the owner account for this installation. This is the only account; setup closes after this step.</p>
          </>
        ) : (
          <p className="muted">Sign in to your computers.</p>
        )}
        <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {mode === "setup" && <p className="muted small">At least 10 characters.</p>}
        {error && <p className="error">{error}</p>}
        <button className="btn primary wide" disabled={busy}>{mode === "setup" ? "Create account" : "Sign in"}</button>
      </form>
    </div>
  );
}

export default function App() {
  const [boot, setBoot] = useState(null); // {needsSetup} | {user}
  const hash = useHashRoute();

  useEffect(() => {
    (async () => {
      try {
        const s = await api("GET", "/api/setup/status");
        if (s.needsSetup) return setBoot({ needsSetup: true });
        const me = await api("GET", "/api/auth/me");
        setBoot({ user: me.username });
      } catch {
        setBoot({ needsSetup: false, user: null });
      }
    })();
  }, []);

  if (!boot) return <div className="auth-wrap"><p className="muted">Loading…</p></div>;
  if (boot.needsSetup) return <AuthScreen mode="setup" />;
  if (!boot.user) return <AuthScreen mode="login" />;

  const navigate = (h) => { location.hash = h; };
  const logout = async () => {
    try { await api("POST", "/api/auth/logout", {}); } catch { /* ignore */ }
    location.reload();
  };

  let page;
  if (hash.startsWith("#/workspace/")) {
    page = <Workspace computerId={hash.slice("#/workspace/".length)} navigate={navigate} />;
  } else if (hash.startsWith("#/agents")) {
    page = <Agents />;
  } else if (hash.startsWith("#/audit")) {
    page = <Audit />;
  } else {
    page = <Computers navigate={navigate} />;
  }

  return (
    <div className="shell">
      <header>
        <strong className="logo" onClick={() => navigate("#/computers")}>Agent Computers</strong>
        <nav>
          <a className={hash.startsWith("#/computers") || hash.startsWith("#/workspace") ? "active" : ""} href="#/computers">Computers</a>
          <a className={hash.startsWith("#/agents") ? "active" : ""} href="#/agents">Connect an agent</a>
          <a className={hash.startsWith("#/audit") ? "active" : ""} href="#/audit">Audit</a>
        </nav>
        <span className="spacer" />
        <span className="muted">{boot.user}</span>
        <button className="btn ghost" onClick={logout}>Sign out</button>
      </header>
      <main>{page}</main>
    </div>
  );
}
