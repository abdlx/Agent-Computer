import React, { useEffect, useState, useRef } from "react";
import {
  Monitor,
  Share2,
  ShieldCheck,
  LogOut,
  Search,
  Moon,
  Sun,
  ChevronRight,
  Server,
  X,
  Cpu,
  HardDrive
} from "lucide-react";
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
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("POST", mode === "setup" ? "/api/setup" : "/api/auth/login", { username, password });
      location.reload();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrapper">
      <form className="auth-card-box" onSubmit={submit}>
        <div className="auth-brand-center">
          <div className="brand-icon-box">
            <Monitor size={24} strokeWidth={2.2} />
          </div>
          <h1>Agent Computer</h1>
          {mode === "setup" ? (
            <p>Welcome — create the owner account for this installation. Setup closes after this step.</p>
          ) : (
            <p>Sign in to your private computers.</p>
          )}
        </div>

        {error && <div className="alert-error">{error}</div>}

        <div className="form-group">
          <label>Username</label>
          <input
            className="form-input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoFocus
            placeholder="Username"
          />
        </div>

        <div className="form-group">
          <label>Password</label>
          <input
            className="form-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            placeholder="Password"
          />
          {mode === "setup" && <span style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "4px", display: "block" }}>At least 10 characters.</span>}
        </div>

        <button className="btn-modal-primary" style={{ width: "100%", padding: "12px", marginTop: "10px", fontSize: "14px" }} disabled={busy}>
          {busy ? "Signing in…" : (mode === "setup" ? "Create owner account" : "Sign in")}
        </button>
      </form>
    </div>
  );
}

export default function App() {
  const [boot, setBoot] = useState(null); // {needsSetup} | {user}
  const [searchQuery, setSearchQuery] = useState("");
  const [theme, setTheme] = useState(() => localStorage.getItem("acp_theme") || "light");
  const [showHostModal, setShowHostModal] = useState(false);
  const [hostResources, setHostResources] = useState(null);
  const [userDropdown, setUserDropdown] = useState(false);
  const searchInputRef = useRef(null);
  const hash = useHashRoute();

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("acp_theme", theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((t) => (t === "light" ? "dark" : "light"));
  };

  // Keyboard shortcut Ctrl+K / Cmd+K to focus search
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Boot check and resource poll
  useEffect(() => {
    (async () => {
      try {
        const s = await api("GET", "/api/setup/status");
        if (s.needsSetup) return setBoot({ needsSetup: true });
        const me = await api("GET", "/api/auth/me");
        setBoot({ user: me.username });
        try {
          const res = await api("GET", "/api/resources");
          setHostResources(res);
        } catch { /* transient */ }
      } catch {
        setBoot({ needsSetup: false, user: null });
      }
    })();
  }, []);

  // Poll resources periodically for host status
  useEffect(() => {
    if (!boot?.user) return;
    const interval = setInterval(async () => {
      try {
        const res = await api("GET", "/api/resources");
        setHostResources(res);
      } catch { /* transient */ }
    }, 6000);
    return () => clearInterval(interval);
  }, [boot?.user]);

  if (!boot) {
    return (
      <div className="auth-wrapper">
        <div style={{ color: "var(--text-secondary)", fontSize: "14px", display: "flex", alignItems: "center", gap: "8px" }}>
          <div className="host-pulse-dot" /> Loading Agent Computer…
        </div>
      </div>
    );
  }

  if (boot.needsSetup) return <AuthScreen mode="setup" />;
  if (!boot.user) return <AuthScreen mode="login" />;

  const navigate = (h) => {
    location.hash = h;
  };

  const logout = async () => {
    try {
      await api("POST", "/api/auth/logout", {});
    } catch {
      /* ignore */
    }
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
    page = <Computers navigate={navigate} searchQuery={searchQuery} onResourcesLoaded={setHostResources} />;
  }

  const isComputersActive = hash.startsWith("#/computers") || hash.startsWith("#/workspace");
  const isConnectActive = hash.startsWith("#/agents");
  const isAuditActive = hash.startsWith("#/audit");

  const isHostOperational = hostResources ? hostResources.allowed !== false : true;

  return (
    <div className="app-shell">
      {/* Sidebar - strictly restricted to Computers, Connect, Audit, Sign Out */}
      <aside className="sidebar">
        <div className="sidebar-top">
          {/* Brand Logo */}
          <div className="brand-logo" onClick={() => navigate("#/computers")}>
            <div className="brand-icon-box">
              <Monitor size={20} strokeWidth={2.3} />
            </div>
            <span className="brand-title">Agent Computer</span>
          </div>

          {/* Navigation Items (Only computers, connect, audit, signout) */}
          <nav className="sidebar-nav">
            <button
              className={`nav-item ${isComputersActive ? "active" : ""}`}
              onClick={() => navigate("#/computers")}
              id="nav-computers"
            >
              <div className="nav-icon">
                <Monitor size={18} strokeWidth={isComputersActive ? 2.3 : 1.9} />
              </div>
              <span>Computers</span>
            </button>

            <button
              className={`nav-item ${isConnectActive ? "active" : ""}`}
              onClick={() => navigate("#/agents")}
              id="nav-connect"
            >
              <div className="nav-icon">
                <Share2 size={18} strokeWidth={isConnectActive ? 2.3 : 1.9} />
              </div>
              <span>Connect</span>
            </button>

            <button
              className={`nav-item ${isAuditActive ? "active" : ""}`}
              onClick={() => navigate("#/audit")}
              id="nav-audit"
            >
              <div className="nav-icon">
                <ShieldCheck size={18} strokeWidth={isAuditActive ? 2.3 : 1.9} />
              </div>
              <span>Audit</span>
            </button>

            <button
              className="nav-item"
              onClick={logout}
              id="nav-signout"
              style={{ marginTop: "4px" }}
            >
              <div className="nav-icon">
                <LogOut size={18} strokeWidth={1.9} />
              </div>
              <span>Sign out</span>
            </button>
          </nav>
        </div>

        {/* Sidebar Bottom: Host Status Card */}
        <div className="host-status-card" onClick={() => setShowHostModal(true)} title="Click to view host details">
          <div
            className="host-pulse-dot"
            style={{
              background: isHostOperational ? "#10b981" : "#ef4444",
            }}
          />
          <div className="host-status-info">
            <div className="host-status-title">Host Online</div>
            <div className="host-status-sub">
              {isHostOperational ? "All systems operational" : "Capacity warning"}
            </div>
          </div>
          <div className="host-status-chevron">
            <ChevronRight size={14} />
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="main-wrapper">
        {/* Top Header Bar */}
        <header className="topbar">
          {/* Search Bar */}
          <div className="search-pill">
            <Search size={16} color="var(--text-muted)" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search computers..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              id="search-computers-input"
            />
            <span className="search-kbd">⌘K</span>
          </div>

          {/* Theme Toggle Button */}
          <button
            className="icon-btn-circle"
            onClick={toggleTheme}
            title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
            id="theme-toggle-btn"
          >
            {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
          </button>

          {/* User Profile Avatar */}
          <div style={{ position: "relative" }}>
            <button
              className="user-avatar-btn"
              onClick={() => setUserDropdown(!userDropdown)}
              title={boot.user}
              id="user-profile-btn"
            >
              {boot.user ? boot.user[0].toUpperCase() : "A"}
            </button>

            {userDropdown && (
              <div className="dropdown-menu" style={{ top: "48px", right: 0 }}>
                <div style={{ padding: "8px 12px 6px", borderBottom: "1px solid var(--border-subtle)" }}>
                  <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>Signed in as</div>
                  <div style={{ fontSize: "13.5px", fontWeight: 700, color: "var(--text-primary)" }}>{boot.user}</div>
                </div>
                <button
                  className="dropdown-item danger"
                  onClick={() => {
                    setUserDropdown(false);
                    logout();
                  }}
                >
                  <LogOut size={14} /> Sign out
                </button>
              </div>
            )}
          </div>
        </header>

        {/* Page Content */}
        <main>{page}</main>
      </div>

      {/* Host Status Modal */}
      {showHostModal && hostResources && (
        <div className="modal-backdrop" onClick={() => setShowHostModal(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <div className="host-pulse-dot" />
                <h3>Host Resource Status</h3>
              </div>
              <button className="modal-close-btn" onClick={() => setShowHostModal(false)}>
                <X size={18} />
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "14px", fontSize: "13.5px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px", padding: "12px", background: "var(--bg-app)", borderRadius: "12px" }}>
                <Server size={22} color="var(--accent-blue)" />
                <div>
                  <div style={{ fontWeight: 600 }}>Docker Supervisor Host</div>
                  <div style={{ color: "var(--text-muted)", fontSize: "12px" }}>
                    Status: {hostResources.allowed ? "Healthy & Accepting Workloads" : hostResources.reason || "Constrained"}
                  </div>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <div style={{ padding: "12px", border: "1px solid var(--border-subtle)", borderRadius: "10px" }}>
                  <div style={{ fontSize: "11.5px", color: "var(--text-secondary)" }}>Total Host RAM</div>
                  <div style={{ fontSize: "16px", fontWeight: 700, marginTop: "2px" }}>
                    {Math.round(hostResources.capacity?.totalMemoryMb || 0)} MB
                  </div>
                </div>
                <div style={{ padding: "12px", border: "1px solid var(--border-subtle)", borderRadius: "10px" }}>
                  <div style={{ fontSize: "11.5px", color: "var(--text-secondary)" }}>Available Memory</div>
                  <div style={{ fontSize: "16px", fontWeight: 700, marginTop: "2px", color: "#10b981" }}>
                    {Math.round(hostResources.capacity?.availableMemoryMb || 0)} MB
                  </div>
                </div>
                <div style={{ padding: "12px", border: "1px solid var(--border-subtle)", borderRadius: "10px" }}>
                  <div style={{ fontSize: "11.5px", color: "var(--text-secondary)" }}>CPU Capacity</div>
                  <div style={{ fontSize: "16px", fontWeight: 700, marginTop: "2px" }}>
                    {(hostResources.capacity?.cpuMillis || 0) / 1000} Cores
                  </div>
                </div>
                <div style={{ padding: "12px", border: "1px solid var(--border-subtle)", borderRadius: "10px" }}>
                  <div style={{ fontSize: "11.5px", color: "var(--text-secondary)" }}>Free Disk Space</div>
                  <div style={{ fontSize: "16px", fontWeight: 700, marginTop: "2px" }}>
                    {(hostResources.capacity?.freeDiskGb || 0).toFixed(1)} GB
                  </div>
                </div>
              </div>

              <div style={{ padding: "12px", background: "var(--bg-app)", borderRadius: "10px", fontSize: "12.5px", color: "var(--text-secondary)" }}>
                <div>• Running Computers: <strong>{hostResources.runningCount || 0}</strong></div>
                <div>• Committed Memory: <strong>{hostResources.memoryCommittedMb || 0} MB</strong></div>
                <div>• Policy Reserve RAM: <strong>{hostResources.policy?.reserveMemoryMb || 0} MB</strong></div>
              </div>
            </div>

            <div className="modal-actions-row">
              <button className="btn-modal-cancel" onClick={() => setShowHostModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
