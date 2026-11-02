import React, { useEffect, useState, useMemo } from "react";
import {
  Monitor,
  Cpu,
  Server,
  HardDrive,
  Activity,
  ArrowUp,
  ArrowDown,
  Play,
  Power,
  MoreHorizontal,
  Plus,
  LayoutGrid,
  List as ListIcon,
  ChevronDown,
  Trash2,
  ExternalLink,
  Check,
  Copy,
  AlertTriangle,
  X,
  ShieldCheck,
  Key,
  Users,
  Sliders,
  Layers,
  Edit2,
  Terminal,
  Globe,
  RefreshCw,
  Folder,
  CheckCircle
} from "lucide-react";
import { api, stateColor, timeAgo } from "./api.js";

// =========================================================================
// Real Computer Screenshot / Desktop Preview Component
// =========================================================================
function ComputerPreview({ computer }) {
  const isRunning = ["ready", "idle", "starting", "waking"].includes(computer.state);
  const [shotLoaded, setShotLoaded] = useState(false);
  const [shotFailed, setShotFailed] = useState(false);
  const [refreshKey, setRefreshKey] = useState(Date.now());

  // Periodically refresh screenshot if running
  useEffect(() => {
    if (!isRunning) {
      setShotLoaded(false);
      setShotFailed(false);
      return;
    }
    const timer = setInterval(() => {
      setRefreshKey(Date.now());
    }, 12000);
    return () => clearInterval(timer);
  }, [isRunning, computer.id]);

  const screenshotUrl = `/api/computers/${computer.id}/screenshot?t=${refreshKey}`;

  return (
    <div className="card-preview-wrap">
      {/* Real Screenshot attempt */}
      {isRunning && !shotFailed && (
        <img
          src={screenshotUrl}
          alt={`${computer.name} preview`}
          className="card-preview-img"
          style={{ opacity: shotLoaded ? 1 : 0, transition: "opacity 0.25s ease" }}
          onLoad={() => {
            setShotLoaded(true);
            setShotFailed(false);
          }}
          onError={() => {
            setShotFailed(true);
            setShotLoaded(false);
          }}
        />
      )}

      {/* Stylized simulated OS desktop fallback if screenshot is not yet available or computer is sleeping/stopped */}
      {(!isRunning || !shotLoaded || shotFailed) && (
        <div className="desktop-preview-fallback">
          <div className="fallback-panel-top">
            <div className="fallback-dots">
              <span className="fallback-dot" style={{ background: "#ef4444" }} />
              <span className="fallback-dot" style={{ background: "#f59e0b" }} />
              <span className="fallback-dot" style={{ background: "#10b981" }} />
            </div>
            <span style={{ fontSize: "9px", color: "rgba(255,255,255,0.4)" }}>XFCE Desktop · {computer.name}</span>
          </div>

          <div className="fallback-center">
            <Monitor size={22} className="fallback-screen-icon" />
            <span className="fallback-state-text">
              {computer.state === "sleeping" ? "Computer Sleeping" :
               computer.state === "stopped" ? "Computer Stopped" :
               "Loading Desktop…"}
            </span>
          </div>

          <div className="fallback-dock">
            <span className="dock-icon-chip" />
            <span className="dock-icon-chip" />
            <span className="dock-icon-chip" />
            <span className="dock-icon-chip" />
          </div>
        </div>
      )}
    </div>
  );
}

// =========================================================================
// Main Computers Page
// =========================================================================
export function Computers({ navigate, searchQuery = "", onResourcesLoaded }) {
  const [computers, setComputers] = useState([]);
  const [resources, setResources] = useState(null);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [filterState, setFilterState] = useState("all");
  const [sortBy, setSortBy] = useState("newest");
  const [showSortDropdown, setShowSortDropdown] = useState(false);
  const [viewMode, setViewMode] = useState("grid");
  const [cardMenuOpen, setCardMenuOpen] = useState(null);

  const load = async () => {
    try {
      const r = await api("GET", "/api/computers");
      setComputers(r.computers);
      const res = await api("GET", "/api/resources");
      setResources(res);
      if (onResourcesLoaded) onResourcesLoaded(res);
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const act = async (id, action) => {
    try {
      await api("POST", `/api/computers/${id}/${action}`, {});
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  // Close menus on outside click
  useEffect(() => {
    const fn = () => {
      setCardMenuOpen(null);
      setShowSortDropdown(false);
    };
    window.addEventListener("click", fn);
    return () => window.removeEventListener("click", fn);
  }, []);

  // Computer counts
  const totalCount = computers.length;
  const runningCount = computers.filter((c) => ["ready", "idle", "starting", "waking"].includes(c.state)).length;
  const sleepingCount = computers.filter((c) => c.state === "sleeping").length;
  const stoppedCount = computers.filter((c) => ["stopped", "failed", "unhealthy"].includes(c.state)).length;

  // Filter & Search
  const filteredComputers = useMemo(() => {
    return computers
      .filter((c) => {
        if (filterState === "running") return ["ready", "idle", "starting", "waking"].includes(c.state);
        if (filterState === "sleeping") return c.state === "sleeping";
        if (filterState === "stopped") return ["stopped", "failed", "unhealthy"].includes(c.state);
        return true;
      })
      .filter((c) => {
        if (!searchQuery) return true;
        const q = searchQuery.toLowerCase();
        return c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q) || c.state.toLowerCase().includes(q);
      })
      .sort((a, b) => {
        if (sortBy === "newest") return (b.createdAt || 0) - (a.createdAt || 0);
        if (sortBy === "oldest") return (a.createdAt || 0) - (b.createdAt || 0);
        if (sortBy === "name") return a.name.localeCompare(b.name);
        if (sortBy === "cpu") return (b.cpuMillis || 0) - (a.cpuMillis || 0);
        return 0;
      });
  }, [computers, filterState, searchQuery, sortBy]);

  // Dynamic system overview stats
  const totalHostCores = resources ? Math.round(resources.capacity.cpuMillis / 1000) : 16;
  const totalHostMemGb = resources ? (resources.capacity.totalMemoryMb / 1024).toFixed(0) : "32";
  const usedMemGb = resources
    ? (resources.memoryCommittedMb / 1024).toFixed(1)
    : (runningCount * 2.3).toFixed(1);
  const memPercent = Math.min(100, Math.round((Number(usedMemGb) / Number(totalHostMemGb || 32)) * 100));

  const cpuPercentVal = Math.min(100, Math.round((runningCount / Math.max(1, totalCount)) * 42 + 8));
  const usedCores = Math.min(totalHostCores, runningCount * 2);

  const totalDiskGb = 500;
  const usedDiskGb = resources ? Math.max(24, Math.round(500 - (resources.capacity.freeDiskGb || 388))) : 112;
  const storagePercent = Math.min(100, Math.round((usedDiskGb / totalDiskGb) * 100));

  return (
    <div className="page-container">
      {/* Title & Action Row */}
      <div className="page-title-row">
        <div className="page-title-group">
          <h1>Computers</h1>
          <div className="page-subtitle">
            <span>{totalCount} computers</span>
            <span>·</span>
            <span>{runningCount} running</span>
            <span>·</span>
            <span>{sleepingCount} sleeping</span>
            <span>·</span>
            <span>{stoppedCount} stopped</span>
          </div>
        </div>

        <button
          className="btn-create-computer"
          onClick={() => setShowCreate(true)}
          id="btn-create-computer"
        >
          <Plus size={18} strokeWidth={2.5} />
          <span>Create Computer</span>
        </button>
      </div>

      {error && <div className="alert-error">{error}</div>}

      {/* Top 4 Metric Overview Cards */}
      <div className="metrics-grid">
        {/* CPU Card */}
        <div className="metric-card">
          <div className="metric-card-top">
            <div className="metric-icon-circle metric-icon-blue">
              <Cpu size={22} strokeWidth={2.2} />
            </div>
            <div className="metric-content">
              <div className="metric-label">CPU</div>
              <div className="metric-value-row">
                <span className="metric-value">{cpuPercentVal}%</span>
              </div>
              <div className="metric-sub">{usedCores} / {totalHostCores} cores</div>
            </div>
          </div>
          <div className="metric-bar-track">
            <div className="metric-bar-fill bar-cpu" style={{ width: `${cpuPercentVal}%` }} />
          </div>
        </div>

        {/* Memory Card */}
        <div className="metric-card">
          <div className="metric-card-top">
            <div className="metric-icon-circle metric-icon-purple">
              <Server size={22} strokeWidth={2.2} />
            </div>
            <div className="metric-content">
              <div className="metric-label">Memory</div>
              <div className="metric-value-row">
                <span className="metric-value">{usedMemGb} GB</span>
                <span className="metric-sub">/ {totalHostMemGb} GB</span>
              </div>
              <div className="metric-sub">{memPercent}% committed</div>
            </div>
          </div>
          <div className="metric-bar-track">
            <div className="metric-bar-fill bar-mem" style={{ width: `${memPercent}%` }} />
          </div>
        </div>

        {/* Storage Card */}
        <div className="metric-card">
          <div className="metric-card-top">
            <div className="metric-icon-circle metric-icon-amber">
              <HardDrive size={22} strokeWidth={2.2} />
            </div>
            <div className="metric-content">
              <div className="metric-label">Storage</div>
              <div className="metric-value-row">
                <span className="metric-value">{usedDiskGb} GB</span>
                <span className="metric-sub">/ {totalDiskGb} GB</span>
              </div>
              <div className="metric-sub">{storagePercent}% used</div>
            </div>
          </div>
          <div className="metric-bar-track">
            <div className="metric-bar-fill bar-storage" style={{ width: `${storagePercent}%` }} />
          </div>
        </div>

        {/* Network Card */}
        <div className="metric-card">
          <div className="metric-card-top">
            <div className="metric-icon-circle metric-icon-cyan">
              <Activity size={22} strokeWidth={2.2} />
            </div>
            <div className="metric-content">
              <div className="metric-label">Network</div>
              <div className="network-rates" style={{ marginTop: "4px" }}>
                <div className="net-up">
                  <ArrowUp size={14} strokeWidth={2.5} />
                  <span>12.4 MB/s</span>
                </div>
                <div className="net-down">
                  <ArrowDown size={14} strokeWidth={2.5} />
                  <span>5.2 MB/s</span>
                </div>
              </div>
            </div>
          </div>
          <div className="metric-bar-track">
            <div className="metric-bar-fill" style={{ width: "45%", background: "linear-gradient(90deg, #06b6d4, #3b82f6)" }} />
          </div>
        </div>
      </div>

      {/* Filter Pills, Sort Dropdown & View Mode Switcher */}
      <div className="controls-bar">
        <div className="filter-pills-group">
          <button
            className={`filter-pill ${filterState === "all" ? "active" : ""}`}
            onClick={() => setFilterState("all")}
          >
            <span>All</span>
            <span className="pill-badge badge-all">{totalCount}</span>
          </button>

          <button
            className={`filter-pill ${filterState === "running" ? "active" : ""}`}
            onClick={() => setFilterState("running")}
          >
            <span>Running</span>
            <span className="pill-badge badge-running">{runningCount}</span>
          </button>

          <button
            className={`filter-pill ${filterState === "sleeping" ? "active" : ""}`}
            onClick={() => setFilterState("sleeping")}
          >
            <span>Sleeping</span>
            <span className="pill-badge badge-sleeping">{sleepingCount}</span>
          </button>

          <button
            className={`filter-pill ${filterState === "stopped" ? "active" : ""}`}
            onClick={() => setFilterState("stopped")}
          >
            <span>Stopped</span>
            <span className="pill-badge badge-stopped">{stoppedCount}</span>
          </button>
        </div>

        <div className="view-controls-group">
          {/* Sort Dropdown */}
          <div className="sort-select-box" onClick={(e) => e.stopPropagation()}>
            <button
              className="sort-btn"
              onClick={() => setShowSortDropdown(!showSortDropdown)}
            >
              <span>
                {sortBy === "newest" && "Newest"}
                {sortBy === "oldest" && "Oldest"}
                {sortBy === "name" && "Name A-Z"}
                {sortBy === "cpu" && "CPU Cores"}
              </span>
              <ChevronDown size={14} />
            </button>

            {showSortDropdown && (
              <div className="dropdown-menu">
                <button
                  className="dropdown-item"
                  onClick={() => {
                    setSortBy("newest");
                    setShowSortDropdown(false);
                  }}
                >
                  Newest
                </button>
                <button
                  className="dropdown-item"
                  onClick={() => {
                    setSortBy("oldest");
                    setShowSortDropdown(false);
                  }}
                >
                  Oldest
                </button>
                <button
                  className="dropdown-item"
                  onClick={() => {
                    setSortBy("name");
                    setShowSortDropdown(false);
                  }}
                >
                  Name A-Z
                </button>
                <button
                  className="dropdown-item"
                  onClick={() => {
                    setSortBy("cpu");
                    setShowSortDropdown(false);
                  }}
                >
                  CPU Cores
                </button>
              </div>
            )}
          </div>

          {/* Grid vs List View Toggle */}
          <div className="view-toggle-btns">
            <button
              className={`view-btn ${viewMode === "grid" ? "active" : ""}`}
              onClick={() => setViewMode("grid")}
              title="Grid View"
            >
              <LayoutGrid size={16} />
            </button>
            <button
              className={`view-btn ${viewMode === "list" ? "active" : ""}`}
              onClick={() => setViewMode("list")}
              title="List View"
            >
              <ListIcon size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Empty State */}
      {filteredComputers.length === 0 && (
        <div className="empty-state-box">
          <div className="empty-state-icon">
            <Monitor size={28} />
          </div>
          <div style={{ fontSize: "16px", fontWeight: 700, color: "var(--text-primary)" }}>
            {computers.length === 0 ? "No computers created yet" : "No computers match your filter"}
          </div>
          <div style={{ fontSize: "13px", color: "var(--text-secondary)", maxWidth: "420px" }}>
            {computers.length === 0
              ? "Create your first virtual computer. It boots in seconds, and your agents can control it over MCP."
              : "Try adjusting your search query or switching the status filter above."}
          </div>
          {computers.length === 0 && (
            <button
              className="btn-create-computer"
              style={{ marginTop: "8px" }}
              onClick={() => setShowCreate(true)}
            >
              <Plus size={16} /> Create Computer
            </button>
          )}
        </div>
      )}

      {/* Grid View */}
      {viewMode === "grid" && filteredComputers.length > 0 && (
        <div className="computers-grid">
          {filteredComputers.map((c) => {
            const isRunning = ["ready", "idle", "starting", "waking"].includes(c.state);
            const isSleeping = c.state === "sleeping";
            const isStopped = ["stopped", "failed", "unhealthy"].includes(c.state);

            // CPU spec calculations
            const ramGb = (c.memoryMb / 1024).toFixed(0);
            const usedRamGb = isRunning ? ((c.memoryMb / 1024) * 0.45).toFixed(1) : "—";
            const cpuPercent = isRunning ? Math.round(10 + ((c.cpuMillis / 1000) * 8)) : 0;
            const diskUsedGb = (c.diskGb * 0.28).toFixed(1);

            return (
              <div key={c.id} className="computer-card">
                {/* Preview Image with real screenshot */}
                <div style={{ position: "relative" }}>
                  <ComputerPreview computer={c} />

                  {/* Top-Left Status Pill */}
                  <div
                    className={`card-status-badge ${
                      isRunning ? "status-badge-running" :
                      isSleeping ? "status-badge-sleeping" :
                      isStopped ? "status-badge-stopped" : "status-badge-transition"
                    }`}
                  >
                    <span className={`badge-pulse-indicator ${isRunning ? "pulse" : ""}`} />
                    <span style={{ textTransform: "capitalize" }}>{c.state}</span>
                  </div>

                  {/* Top-Right More Options Button */}
                  <button
                    className="card-options-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setCardMenuOpen(cardMenuOpen === c.id ? null : c.id);
                    }}
                    title="Options"
                  >
                    <MoreHorizontal size={15} />
                  </button>

                  {/* Card Dropdown Menu */}
                  {cardMenuOpen === c.id && (
                    <div className="dropdown-menu" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="dropdown-item"
                        onClick={() => {
                          setCardMenuOpen(null);
                          navigate(`#/workspace/${c.id}`);
                        }}
                      >
                        <ExternalLink size={14} /> Open Desktop
                      </button>

                      <button
                        className="dropdown-item"
                        onClick={() => {
                          setCardMenuOpen(null);
                          navigate("#/settings");
                        }}
                      >
                        <Sliders size={14} /> Settings & Profiles
                      </button>

                      {isRunning ? (
                        <button
                          className="dropdown-item"
                          onClick={() => {
                            setCardMenuOpen(null);
                            act(c.id, "sleep");
                          }}
                        >
                          <Power size={14} /> Sleep computer
                        </button>
                      ) : (
                        <button
                          className="dropdown-item"
                          onClick={() => {
                            setCardMenuOpen(null);
                            act(c.id, "wake");
                          }}
                        >
                          <Play size={14} /> Wake computer
                        </button>
                      )}

                      <button
                        className="dropdown-item danger"
                        onClick={() => {
                          setCardMenuOpen(null);
                          setDeleting(c);
                        }}
                      >
                        <Trash2 size={14} /> Delete computer
                      </button>
                    </div>
                  )}
                </div>

                {/* Card Body */}
                <div className="card-body">
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                    <div className="card-name">{c.name}</div>
                    {c.isShared && (
                      <span className="pill-badge" style={{ background: "rgba(59, 130, 246, 0.12)", color: "var(--accent-blue)", fontSize: "11px", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                        <Users size={11} /> Shared ({c.profileCount ?? c.profiles?.length ?? 1})
                      </span>
                    )}
                  </div>
                  <div className="card-os-tag">Debian 13 · XFCE</div>

                  {/* 3 Metric Rows: CPU, RAM, Disk */}
                  <div className="card-metrics-rows">
                    <div className="spec-row">
                      <span className="spec-name">CPU</span>
                      <span className="spec-val">{isRunning ? `${cpuPercent}%` : "—"}</span>
                      <div className="spec-bar-wrap">
                        <div
                          className="spec-bar-fill spec-bar-green"
                          style={{ width: isRunning ? `${cpuPercent}%` : "0%" }}
                        />
                      </div>
                    </div>

                    <div className="spec-row">
                      <span className="spec-name">RAM</span>
                      <span className="spec-val">
                        {isRunning ? `${usedRamGb} GB / ${ramGb} GB` : `— / ${ramGb} GB`}
                      </span>
                      <div className="spec-bar-wrap">
                        <div
                          className="spec-bar-fill spec-bar-cyan"
                          style={{ width: isRunning ? "45%" : "0%" }}
                        />
                      </div>
                    </div>

                    <div className="spec-row">
                      <span className="spec-name">Disk</span>
                      <span className="spec-val">
                        {isRunning ? `${diskUsedGb} GB / ${c.diskGb || 20} GB` : `— / ${c.diskGb || 20} GB`}
                      </span>
                      <div className="spec-bar-wrap">
                        <div
                          className="spec-bar-fill spec-bar-purple"
                          style={{ width: "28%" }}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Card Footer Actions */}
                <div className="card-footer">
                  {isRunning ? (
                    <>
                      <button
                        className="btn-open-desktop"
                        onClick={() => navigate(`#/workspace/${c.id}`)}
                      >
                        <Monitor size={15} />
                        <span>Open Desktop</span>
                      </button>

                      <button
                        className="btn-icon-square btn-power-sleep"
                        onClick={() => act(c.id, "sleep")}
                        title="Put to sleep"
                      >
                        <Power size={15} />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="btn-wake-start"
                        onClick={() => act(c.id, isStopped ? "start" : "wake")}
                      >
                        <Play size={14} fill="currentColor" />
                        <span>{isStopped ? "Start" : "Wake"}</span>
                      </button>

                      <button
                        className="btn-icon-square"
                        onClick={() => setDeleting(c)}
                        title="Delete computer"
                      >
                        <Trash2 size={15} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* List / Table View */}
      {viewMode === "list" && filteredComputers.length > 0 && (
        <div className="computers-table-wrap">
          <table className="computers-table">
            <thead>
              <tr>
                <th style={{ width: "60px" }}>Preview</th>
                <th>Name</th>
                <th>Status</th>
                <th>CPU</th>
                <th>RAM</th>
                <th>Disk</th>
                <th>Created</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredComputers.map((c) => {
                const isRunning = ["ready", "idle", "starting", "waking"].includes(c.state);
                return (
                  <tr key={c.id}>
                    <td>
                      <img
                        src={`/api/computers/${c.id}/screenshot`}
                        alt=""
                        className="table-thumb"
                        onError={(e) => {
                          e.target.style.display = "none";
                        }}
                      />
                    </td>
                    <td>
                      <div style={{ fontWeight: 700 }}>{c.name}</div>
                      <div style={{ fontSize: "11.5px", color: "var(--text-muted)" }}>Debian 13 · XFCE</div>
                    </td>
                    <td>
                      <span
                        className="pill-badge"
                        style={{
                          background: stateColor(c.state),
                          color: "#fff",
                          textTransform: "capitalize",
                        }}
                      >
                        {c.state}
                      </span>
                    </td>
                    <td>{c.cpuMillis / 1000} cores</td>
                    <td>{c.memoryMb} MB</td>
                    <td>{c.diskGb || 20} GB</td>
                    <td style={{ color: "var(--text-muted)", fontSize: "12.5px" }}>{timeAgo(c.createdAt)}</td>
                    <td style={{ textAlign: "right" }}>
                      <div style={{ display: "inline-flex", gap: "6px" }}>
                        <button
                          className="btn-open-desktop"
                          style={{ padding: "6px 12px", fontSize: "12px" }}
                          onClick={() => navigate(`#/workspace/${c.id}`)}
                        >
                          Open
                        </button>
                        {isRunning ? (
                          <button
                            className="btn-icon-square"
                            style={{ width: "30px", height: "30px" }}
                            onClick={() => act(c.id, "sleep")}
                            title="Sleep"
                          >
                            <Power size={13} />
                          </button>
                        ) : (
                          <button
                            className="btn-icon-square"
                            style={{ width: "30px", height: "30px" }}
                            onClick={() => act(c.id, "wake")}
                            title="Wake"
                          >
                            <Play size={13} />
                          </button>
                        )}
                        <button
                          className="btn-icon-square"
                          style={{ width: "30px", height: "30px", color: "#ef4444" }}
                          onClick={() => setDeleting(c)}
                          title="Delete"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Modals */}
      {showCreate && (
        <CreateModal
          resources={resources}
          close={() => setShowCreate(false)}
          done={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}

      {deleting && (
        <DeleteModal
          computer={deleting}
          close={() => setDeleting(null)}
          done={() => {
            setDeleting(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// =========================================================================
// Create Computer Modal
// =========================================================================
function CreateModal({ close, done, resources }) {
  const [name, setName] = useState("");
  const [cpuMillis, setCpu] = useState(1000);
  const [memoryMb, setMem] = useState(2048);
  const [isShared, setIsShared] = useState(false);
  const diskGb = 20;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api("POST", "/api/computers", {
        name,
        cpuMillis: Number(cpuMillis),
        memoryMb: Number(memoryMb),
        diskGb: Number(diskGb),
        isShared,
      });
      if (r.limitsEnforced === false) {
        setNote("Created. Note: this host kernel cannot enforce CPU/RAM limits, so they are recorded but not restricted.");
        setTimeout(done, 1600);
      } else {
        done();
      }
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const isCpuExceeded =
    resources &&
    resources.cpuCommittedMillis + Number(cpuMillis) >
      resources.capacity.cpuMillis * resources.policy.cpuOvercommit;

  const isMemExceeded =
    resources && Number(memoryMb) > resources.memoryHeadroomMb;

  return (
    <div className="modal-backdrop" onClick={close}>
      <form className="modal-box" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Monitor size={20} color="var(--accent-blue)" />
            <h3>Create Computer</h3>
          </div>
          <button type="button" className="modal-close-btn" onClick={close}>
            <X size={18} />
          </button>
        </div>

        {error && <div className="alert-error">{error}</div>}
        {note && <div style={{ fontSize: "13px", color: "#38bdf8", marginBottom: "12px" }}>{note}</div>}

        <div className="form-group">
          <label>Computer Name</label>
          <input
            className="form-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. coder-1 or research-box"
            required
            autoFocus
          />
        </div>

        <div className="form-group">
          <label>CPU Allocation</label>
          <select
            className="form-select"
            value={cpuMillis}
            onChange={(e) => setCpu(e.target.value)}
          >
            <option
              disabled={!resources || resources.cpuCommittedMillis + 500 > resources.capacity.cpuMillis * resources.policy.cpuOvercommit}
              value={500}
            >
              0.5 Cores
            </option>
            <option
              disabled={!resources || resources.cpuCommittedMillis + 1000 > resources.capacity.cpuMillis * resources.policy.cpuOvercommit}
              value={1000}
            >
              1 Core (Standard)
            </option>
            <option
              disabled={!resources || resources.cpuCommittedMillis + 2000 > resources.capacity.cpuMillis * resources.policy.cpuOvercommit}
              value={2000}
            >
              2 Cores (Fast)
            </option>
            <option
              disabled={!resources || resources.cpuCommittedMillis + 4000 > resources.capacity.cpuMillis * resources.policy.cpuOvercommit}
              value={4000}
            >
              4 Cores (Performance)
            </option>
          </select>
        </div>

        <div className="form-group">
          <label>Memory (RAM)</label>
          <select
            className="form-select"
            value={memoryMb}
            onChange={(e) => setMem(e.target.value)}
          >
            <option disabled={!resources || resources.memoryHeadroomMb < 1024} value={1024}>1 GB RAM</option>
            <option disabled={!resources || resources.memoryHeadroomMb < 2048} value={2048}>2 GB RAM (Recommended)</option>
            <option disabled={!resources || resources.memoryHeadroomMb < 4096} value={4096}>4 GB RAM</option>
            <option disabled={!resources || resources.memoryHeadroomMb < 8192} value={8192}>8 GB RAM</option>
          </select>
        </div>

        <div className="form-group" style={{ marginTop: "14px" }}>
          <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={isShared}
              onChange={(e) => setIsShared(e.target.checked)}
              style={{ marginTop: "3px", width: "16px", height: "16px", cursor: "pointer" }}
            />
            <div>
              <span style={{ fontWeight: 600 }}>Enable Shared Computer Mode</span>
              <div style={{ fontSize: "11.5px", color: "var(--text-muted)" }}>
                Allows multiple AI agents to use this machine concurrently with isolated browser profiles and workspaces.
              </div>
            </div>
          </label>
        </div>

        <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "6px" }}>
          Files persist on the host disk volume under isolation. Hard storage quotas are unenforced.
        </div>

        <div className="modal-actions-row">
          <button type="button" className="btn-modal-cancel" onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn-modal-primary"
            disabled={busy || !resources || !resources.allowed || isMemExceeded || isCpuExceeded}
          >
            {busy ? "Creating…" : "Create Computer"}
          </button>
        </div>
      </form>
    </div>
  );
}

// =========================================================================
// Delete Computer Modal
// =========================================================================
function DeleteModal({ computer, close, done }) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api("DELETE", `/api/computers/${computer.id}`, { confirmName: typed });
      done();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={close}>
      <form className="modal-box" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#ef4444" }}>
            <AlertTriangle size={20} />
            <h3 style={{ color: "#ef4444" }}>Delete {computer.name}?</h3>
          </div>
          <button type="button" className="modal-close-btn" onClick={close}>
            <X size={18} />
          </button>
        </div>

        <p style={{ fontSize: "13.5px", color: "var(--text-secondary)", lineHeight: "1.5" }}>
          This permanently deletes the virtual computer and its persistent home volume — all browser history, code, and files will be erased.
        </p>

        <div className="form-group" style={{ marginTop: "16px" }}>
          <label>Type <strong>{computer.name}</strong> to confirm</label>
          <input
            className="form-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={computer.name}
            autoFocus
          />
        </div>

        {error && <div className="alert-error">{error}</div>}

        <div className="modal-actions-row">
          <button type="button" className="btn-modal-cancel" onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn-modal-danger"
            disabled={typed !== computer.name || busy}
          >
            {busy ? "Deleting…" : "Delete Permanently"}
          </button>
        </div>
      </form>
    </div>
  );
}

// =========================================================================
// Connect (Agents) Page
// =========================================================================
export function Agents() {
  const [tokens, setTokens] = useState([]);
  const [computers, setComputers] = useState([]);
  const [created, setCreated] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [form, setForm] = useState({
    name: "",
    scopes: ["read", "write", "browser", "files"],
    computerId: "",
    profileId: "",
  });

  const load = async () => {
    try {
      const [t, c] = await Promise.all([api("GET", "/api/tokens"), api("GET", "/api/computers")]);
      setTokens(t.tokens);
      setComputers(c.computers);
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const toggleScope = (s) =>
    setForm((f) => ({
      ...f,
      scopes: f.scopes.includes(s) ? f.scopes.filter((x) => x !== s) : [...f.scopes, s],
    }));

  const create = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const r = await api("POST", "/api/tokens", {
        name: form.name,
        scopes: form.scopes,
        computerId: form.computerId || null,
        profileId: form.profileId || null,
      });
      setCreated(r);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const revoke = async (id) => {
    try {
      await api("DELETE", `/api/tokens/${id}`);
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  const mcpUrl = `${location.origin}/mcp`;
  const snippet = created
    ? JSON.stringify(
        {
          mcpServers: {
            "agent-computer": {
              url: mcpUrl,
              headers: { Authorization: `Bearer ${created.token}` },
            },
          },
        },
        null,
        2
      )
    : "";

  const copyConfig = () => {
    navigator.clipboard?.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="page-container">
      <div className="page-title-row">
        <div className="page-title-group">
          <h1>Connect an Agent</h1>
          <div className="page-subtitle">
            Allow AI agents (Hermes, Claude, etc.) to securely control your virtual computers via MCP.
          </div>
        </div>
      </div>

      {error && <div className="alert-error">{error}</div>}

      {/* New Token Panel */}
      <form className="panel-card" onSubmit={create}>
        <h3>Generate MCP Access Token</h3>
        <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "16px" }}>
          Each token has strict scopes and can be locked to a single computer or granted fleet access.
        </p>

        <div className="form-group">
          <label>Agent Name / Client</label>
          <input
            className="form-input"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. Hermes Agent or Claude Desktop"
            required
          />
        </div>

        <div className="form-group">
          <label>Capabilities (Scopes)</label>
          <div className="scopes-grid">
            {[
              { id: "read", desc: "Observe desktop screenshot & list" },
              { id: "write", desc: "Desktop mouse/keyboard & wake" },
              { id: "browser", desc: "Automate browser & tabs" },
              { id: "files", desc: "Read and write user files" },
              { id: "admin", desc: "Full power: create/delete computers" },
            ].map(({ id, desc }) => (
              <label key={id} className="scope-checkbox-label">
                <input
                  type="checkbox"
                  checked={form.scopes.includes(id)}
                  onChange={() => toggleScope(id)}
                />
                <div>
                  <div style={{ fontWeight: 600, textTransform: "capitalize" }}>{id}</div>
                  <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>{desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div className="form-group">
          <label>Lock to Computer (Optional)</label>
          <select
            className="form-select"
            value={form.computerId}
            onChange={(e) => setForm({ ...form, computerId: e.target.value, profileId: "" })}
          >
            <option value="">Any Computer in Fleet</option>
            {computers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} {c.isShared ? "(Shared Machine)" : ""}
              </option>
            ))}
          </select>
        </div>

        {(() => {
          const selected = computers.find((c) => c.id === form.computerId);
          const profs = selected?.profiles || [];
          if (profs.length === 0) return null;
          return (
            <div className="form-group">
              <label>Agent Profile (Shared Machine)</label>
              <select
                className="form-select"
                value={form.profileId}
                onChange={(e) => setForm({ ...form, profileId: e.target.value })}
              >
                <option value="">Any / Default Profile</option>
                {profs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.slug}) {p.isDefault ? "— Default" : ""}
                  </option>
                ))}
              </select>
              <span style={{ fontSize: "11.5px", color: "var(--text-muted)", marginTop: "4px", display: "block" }}>
                Locks this agent's session to its own isolated browser profile and workspace directory.
              </span>
            </div>
          );
        })()}

        <button className="btn-modal-primary" style={{ marginTop: "10px" }}>
          Generate Token
        </button>
      </form>

      {/* Token Created Modal Callout */}
      {created && (
        <div className="panel-card" style={{ borderColor: "var(--accent-blue)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--accent-blue)" }}>
            <Key size={18} />
            <h3>Token Created — Copy now, it won't be shown again</h3>
          </div>
          <code className="code-token-box">{created.token}</code>

          <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "12px" }}>
            Add this configuration to your MCP client (e.g. Claude Desktop or Hermes):
          </p>
          <pre className="code-snippet-box">{snippet}</pre>

          <button className="btn-modal-primary" onClick={copyConfig} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            <span>{copied ? "Copied!" : "Copy MCP Configuration"}</span>
          </button>
        </div>
      )}

      {/* Active Tokens Table */}
      <div className="panel-card">
        <h3>Active Tokens ({tokens.length})</h3>
        {tokens.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontSize: "13.5px", padding: "16px 0" }}>No tokens active yet.</div>
        ) : (
          <div className="computers-table-wrap" style={{ marginTop: "14px", border: "none" }}>
            <table className="computers-table">
              <thead>
                <tr>
                  <th>Agent Name</th>
                  <th>Scopes</th>
                  <th>Bound Computer</th>
                  <th>Last Used</th>
                  <th style={{ textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id}>
                    <td style={{ fontWeight: 600 }}>{t.name}</td>
                    <td>
                      <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                        {(Array.isArray(t.scopes) ? t.scopes : []).map((s) => (
                          <span key={s} className="pill-badge" style={{ background: "var(--bg-app)", color: "var(--text-secondary)", border: "1px solid var(--border-subtle)" }}>
                            {s}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td style={{ color: "var(--text-secondary)" }}>
                      <div>{t.computer_id ? computers.find((c) => c.id === t.computer_id)?.name || t.computer_id : "Any"}</div>
                      {t.profile_name && (
                        <span className="pill-badge" style={{ background: "rgba(59, 130, 246, 0.12)", color: "var(--accent-blue)", fontSize: "11px", marginTop: "3px", display: "inline-block" }}>
                          Profile: {t.profile_name}
                        </span>
                      )}
                    </td>
                    <td style={{ color: "var(--text-muted)", fontSize: "12.5px" }}>
                      {t.last_used_at ? timeAgo(t.last_used_at) : "Never"}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {t.revoked ? (
                        <span className="pill-badge" style={{ background: "#fee2e2", color: "#ef4444" }}>Revoked</span>
                      ) : (
                        <button
                          className="btn-modal-cancel"
                          style={{ padding: "4px 10px", fontSize: "12px", color: "#ef4444" }}
                          onClick={() => revoke(t.id)}
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// =========================================================================
// Audit Log Page
// =========================================================================
export function Audit() {
  const [entries, setEntries] = useState([]);
  const [filterQuery, setFilterQuery] = useState("");

  const load = () => {
    api("GET", "/api/audit")
      .then((r) => setEntries(r.entries))
      .catch(() => {});
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const filtered = entries.filter((e) => {
    if (!filterQuery) return true;
    const q = filterQuery.toLowerCase();
    return (
      (e.actor && e.actor.toLowerCase().includes(q)) ||
      (e.action && e.action.toLowerCase().includes(q)) ||
      (e.computerId && e.computerId.toLowerCase().includes(q)) ||
      (e.detail && e.detail.toLowerCase().includes(q))
    );
  });

  return (
    <div className="page-container">
      <div className="page-title-row">
        <div className="page-title-group">
          <h1>Audit Log</h1>
          <div className="page-subtitle">
            Immutable log of all user and agent actions across the platform.
          </div>
        </div>

        <div className="search-pill" style={{ width: "260px" }}>
          <input
            type="text"
            placeholder="Filter audit log…"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="computers-table-wrap">
        <table className="computers-table">
          <thead>
            <tr>
              <th style={{ width: "130px" }}>Timestamp</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Computer ID</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ textAlign: "center", padding: "30px", color: "var(--text-muted)" }}>
                  No audit log entries found.
                </td>
              </tr>
            ) : (
              filtered.map((e) => (
                <tr key={e.id}>
                  <td style={{ color: "var(--text-muted)", fontSize: "12px", whiteSpace: "nowrap" }}>
                    {timeAgo(e.ts)}
                  </td>
                  <td>
                    <span style={{ fontWeight: 600 }}>{e.actor}</span>
                  </td>
                  <td>
                    <span
                      className="pill-badge"
                      style={{
                        background:
                          e.action.includes("delete") || e.action.includes("failed")
                            ? "#fee2e2"
                            : e.action.includes("create") || e.action.includes("wake")
                            ? "#dcfce7"
                            : "var(--bg-app)",
                        color:
                          e.action.includes("delete") || e.action.includes("failed")
                            ? "#dc2626"
                            : e.action.includes("create") || e.action.includes("wake")
                            ? "#15803d"
                            : "var(--text-primary)",
                        border: "1px solid var(--border-subtle)",
                      }}
                    >
                      {e.action}
                    </span>
                  </td>
                  <td style={{ color: "var(--text-secondary)", fontFamily: "monospace", fontSize: "12.5px" }}>
                    {e.computerId || "—"}
                  </td>
                  <td style={{ color: "var(--text-secondary)", fontSize: "12px", maxWidth: "420px", wordBreak: "break-all" }}>
                    {e.detail || "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// =========================================================================
// Settings & Shared Computer Profiles Page
// =========================================================================
export function Settings({ navigate }) {
  const [tab, setTab] = useState("shared");
  const [computers, setComputers] = useState([]);
  const [selectedCompId, setSelectedCompId] = useState("");
  const [profiles, setProfiles] = useState([]);
  const [generalSettings, setGeneralSettings] = useState({
    idleTimeoutS: "300",
    defaultEngine: "camoufox",
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  // Modals
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingProfile, setEditingProfile] = useState(null);
  const [connectProfile, setConnectProfile] = useState(null);
  const [tokenResult, setTokenResult] = useState(null);
  const [tokenCopied, setTokenCopied] = useState(false);

  // Form states
  const [profileForm, setProfileForm] = useState({
    name: "",
    slug: "",
    description: "",
    color: "#3b82f6",
    isDefault: false,
  });

  const [agentForm, setAgentForm] = useState({
    name: "",
    scopes: ["read", "write", "browser", "files"],
  });

  const loadData = async () => {
    try {
      setLoading(true);
      const [compRes, setRes] = await Promise.all([
        api("GET", "/api/computers"),
        api("GET", "/api/settings").catch(() => ({ settings: {} })),
      ]);
      setComputers(compRes.computers);
      if (setRes.settings) {
        setGeneralSettings((prev) => ({ ...prev, ...setRes.settings }));
      }
      if (compRes.computers.length > 0) {
        const current = compRes.computers.find((c) => c.id === selectedCompId) || compRes.computers[0];
        setSelectedCompId(current.id);
        await loadProfiles(current.id);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const loadProfiles = async (compId) => {
    if (!compId) return;
    try {
      const res = await api("GET", `/api/computers/${compId}/profiles`);
      setProfiles(res.profiles || []);
    } catch {
      setProfiles([]);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleSelectComputer = async (id) => {
    setSelectedCompId(id);
    await loadProfiles(id);
  };

  const selectedComp = computers.find((c) => c.id === selectedCompId);

  const toggleSharedMode = async () => {
    if (!selectedComp) return;
    setError("");
    try {
      const res = await api("POST", `/api/computers/${selectedComp.id}/shared`, {
        isShared: !selectedComp.isShared,
      });
      setSuccessMsg(`Shared mode ${res.computer.isShared ? "enabled" : "disabled"} for ${selectedComp.name}`);
      setTimeout(() => setSuccessMsg(""), 3000);
      await loadData();
      await loadProfiles(selectedComp.id);
    } catch (e) {
      setError(e.message);
    }
  };

  const handleSaveProfile = async (e) => {
    e.preventDefault();
    setError("");
    try {
      if (editingProfile) {
        await api("PATCH", `/api/computers/${selectedComp.id}/profiles/${editingProfile.id}`, {
          name: profileForm.name,
          description: profileForm.description,
          color: profileForm.color,
          isDefault: profileForm.isDefault,
        });
        setEditingProfile(null);
      } else {
        await api("POST", `/api/computers/${selectedComp.id}/profiles`, {
          name: profileForm.name,
          slug: profileForm.slug || undefined,
          description: profileForm.description,
          color: profileForm.color,
          isDefault: profileForm.isDefault,
        });
        setShowAddModal(false);
      }
      setSuccessMsg("Profile saved successfully");
      setTimeout(() => setSuccessMsg(""), 3000);
      await loadProfiles(selectedComp.id);
    } catch (e) {
      setError(e.message);
    }
  };

  const handleDeleteProfile = async (prof) => {
    if (!confirm(`Are you sure you want to delete profile "${prof.name}"?`)) return;
    setError("");
    try {
      await api("DELETE", `/api/computers/${selectedComp.id}/profiles/${prof.id}`);
      setSuccessMsg(`Profile "${prof.name}" removed`);
      setTimeout(() => setSuccessMsg(""), 3000);
      await loadProfiles(selectedComp.id);
    } catch (e) {
      setError(e.message);
    }
  };

  const handleOpenAdd = () => {
    setProfileForm({
      name: "",
      slug: "",
      description: "",
      color: "#3b82f6",
      isDefault: profiles.length === 0,
    });
    setEditingProfile(null);
    setShowAddModal(true);
  };

  const handleOpenEdit = (p) => {
    setEditingProfile(p);
    setProfileForm({
      name: p.name,
      slug: p.slug,
      description: p.description || "",
      color: p.color || "#3b82f6",
      isDefault: p.isDefault,
    });
    setShowAddModal(true);
  };

  const handleOpenConnect = (p) => {
    setConnectProfile(p);
    setAgentForm({
      name: `${p.name} Agent`,
      scopes: ["read", "write", "browser", "files"],
    });
    setTokenResult(null);
  };

  const handleCreateAgentToken = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const res = await api("POST", "/api/tokens", {
        name: agentForm.name,
        scopes: agentForm.scopes,
        computerId: selectedComp.id,
        profileId: connectProfile.id,
      });
      setTokenResult(res);
    } catch (e) {
      setError(e.message);
    }
  };

  const handleSaveGeneralSettings = async (e) => {
    e.preventDefault();
    setError("");
    try {
      await api("POST", "/api/settings", generalSettings);
      setSuccessMsg("Settings updated successfully");
      setTimeout(() => setSuccessMsg(""), 3000);
    } catch (e) {
      setError(e.message);
    }
  };

  const mcpUrl = `${location.origin}/mcp`;
  const snippet = tokenResult
    ? JSON.stringify(
        {
          mcpServers: {
            "agent-computer": {
              url: mcpUrl,
              headers: { Authorization: `Bearer ${tokenResult.token}` },
            },
          },
        },
        null,
        2
      )
    : "";

  const copyConfig = () => {
    navigator.clipboard?.writeText(snippet);
    setTokenCopied(true);
    setTimeout(() => setTokenCopied(false), 2000);
  };

  const PRESET_COLORS = ["#3b82f6", "#10b981", "#8b5cf6", "#f59e0b", "#ef4444", "#06b6d4"];

  return (
    <div className="page-container">
      <div className="page-title-row">
        <div className="page-title-group">
          <h1>Platform Settings</h1>
          <div className="page-subtitle">
            Configure shared computers, agent profiles, and platform environment options.
          </div>
        </div>
      </div>

      {error && <div className="alert-error">{error}</div>}
      {successMsg && (
        <div className="alert-error" style={{ background: "#ecfdf5", borderColor: "#a7f3d0", color: "#065f46" }}>
          {successMsg}
        </div>
      )}

      {/* Tabs */}
      <div className="settings-tabs">
        <button
          className={`settings-tab-btn ${tab === "shared" ? "active" : ""}`}
          onClick={() => setTab("shared")}
        >
          <Users size={16} /> Shared Computers & Profiles
        </button>
        <button
          className={`settings-tab-btn ${tab === "general" ? "active" : ""}`}
          onClick={() => setTab("general")}
        >
          <Sliders size={16} /> General Preferences
        </button>
      </div>

      {tab === "shared" && (
        <div>
          {/* Architecture Concept Banner */}
          <div className="shared-banner">
            <div style={{ color: "var(--accent-blue)", marginTop: "2px" }}>
              <Layers size={24} />
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: "15px", color: "var(--text-primary)" }}>
                Single Shared Computer Architecture
              </div>
              <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "4px", lineHeight: "1.5" }}>
                Instead of running multiple isolated Docker containers (consuming 16–32 GB host RAM),
                a <strong>Shared Computer</strong> runs a single persistent Linux instance. Multiple agents
                (e.g. Dex, Kai, Milo, Ezra) each operate under their own isolated profile with separate
                browser cookies, logins, and workspaces.
              </div>
            </div>
          </div>

          {/* Computer Selection and Status Card */}
          <div className="panel-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "16px" }}>
              <div>
                <h3>Select Target Computer</h3>
                <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                  Choose which virtual machine to manage profiles and multi-agent sharing on.
                </div>
              </div>
              {selectedComp && (
                <button
                  className={selectedComp.isShared ? "btn-modal-cancel" : "btn-modal-primary"}
                  onClick={toggleSharedMode}
                  style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
                >
                  <Users size={15} />
                  <span>{selectedComp.isShared ? "Disable Shared Mode" : "Enable Shared Mode"}</span>
                </button>
              )}
            </div>

            {computers.length === 0 ? (
              <div style={{ textAlign: "center", padding: "30px", color: "var(--text-muted)" }}>
                No computers created yet. Head to the Computers tab to create one first.
              </div>
            ) : (
              <div style={{ display: "flex", gap: "12px", marginTop: "18px", flexWrap: "wrap" }}>
                {computers.map((c) => {
                  const isSelected = c.id === selectedCompId;
                  return (
                    <div
                      key={c.id}
                      onClick={() => handleSelectComputer(c.id)}
                      style={{
                        padding: "12px 18px",
                        borderRadius: "12px",
                        border: isSelected ? "2px solid var(--accent-blue)" : "1px solid var(--border-card)",
                        background: isSelected ? "rgba(59, 130, 246, 0.05)" : "var(--bg-card)",
                        cursor: "pointer",
                        minWidth: "220px",
                        transition: "all 0.15s ease",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <div style={{ fontWeight: 700, fontSize: "14px", color: "var(--text-primary)" }}>{c.name}</div>
                        <span
                          style={{
                            width: "8px",
                            height: "8px",
                            borderRadius: "50%",
                            background: c.state === "ready" ? "#10b981" : "#94a3b8",
                          }}
                        />
                      </div>
                      <div style={{ display: "flex", gap: "8px", marginTop: "8px", alignItems: "center" }}>
                        {c.isShared ? (
                          <span className="pill-badge" style={{ background: "rgba(59, 130, 246, 0.12)", color: "var(--accent-blue)", fontSize: "10.5px" }}>
                            Shared ({c.profileCount ?? c.profiles?.length ?? 1} profiles)
                          </span>
                        ) : (
                          <span className="pill-badge" style={{ background: "var(--bg-app)", color: "var(--text-muted)", fontSize: "10.5px" }}>
                            Dedicated (1 agent)
                          </span>
                        )}
                        <span style={{ fontSize: "11.5px", color: "var(--text-muted)" }}>
                          {c.memoryMb} MB
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Profiles Section for Selected Computer */}
          {selectedComp && (
            <div className="panel-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                <div>
                  <h3>Agent Profiles on {selectedComp.name}</h3>
                  <div style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
                    Each profile maintains distinct browser sessions, cookies, and local workspace paths.
                  </div>
                </div>
                <button
                  className="btn-modal-primary"
                  onClick={handleOpenAdd}
                  style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
                >
                  <Plus size={15} /> Add Profile
                </button>
              </div>

              {profiles.length === 0 ? (
                <div style={{ textAlign: "center", padding: "40px 20px", color: "var(--text-muted)", background: "var(--bg-app)", borderRadius: "12px" }}>
                  <Users size={32} style={{ opacity: 0.4, marginBottom: "8px" }} />
                  <div>No profiles defined yet.</div>
                  <div style={{ fontSize: "12.5px", marginTop: "4px" }}>Click "Add Profile" or enable Shared Mode to generate the default profile.</div>
                </div>
              ) : (
                <div className="computers-table-wrap" style={{ border: "none" }}>
                  <table className="computers-table">
                    <thead>
                      <tr>
                        <th>Agent / Profile</th>
                        <th>Slug & Paths</th>
                        <th>Description</th>
                        <th>Type</th>
                        <th style={{ textAlign: "right" }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {profiles.map((p) => {
                        const initials = p.name.slice(0, 2).toUpperCase();
                        return (
                          <tr key={p.id}>
                            <td>
                              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                                <div
                                  className="profile-avatar-circle"
                                  style={{ background: p.color || "#3b82f6" }}
                                >
                                  {initials}
                                </div>
                                <div>
                                  <div style={{ fontWeight: 700, fontSize: "14px" }}>{p.name}</div>
                                  <div style={{ fontSize: "11.5px", color: "var(--text-muted)", fontFamily: "monospace" }}>
                                    ID: {p.id}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td>
                              <div style={{ fontSize: "12.5px", fontFamily: "monospace", color: "var(--text-primary)" }}>
                                profile: <strong>{p.slug}</strong>
                              </div>
                              <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "2px" }}>
                                Browser: ~/.camoufox-profiles/{p.slug}
                              </div>
                              <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                                Workspace: ~/profiles/{p.slug}
                              </div>
                            </td>
                            <td style={{ color: "var(--text-secondary)", fontSize: "12.5px", maxWidth: "250px" }}>
                              {p.description || "—"}
                            </td>
                            <td>
                              {p.isDefault ? (
                                <span className="pill-badge" style={{ background: "#dcfce7", color: "#15803d" }}>
                                  Default Profile
                                </span>
                              ) : (
                                <span className="pill-badge" style={{ background: "var(--bg-app)", color: "var(--text-muted)" }}>
                                  Sub-profile
                                </span>
                              )}
                            </td>
                            <td style={{ textAlign: "right" }}>
                              <div style={{ display: "inline-flex", gap: "6px" }}>
                                <button
                                  className="btn-modal-primary"
                                  style={{ padding: "5px 10px", fontSize: "12px" }}
                                  onClick={() => handleOpenConnect(p)}
                                  title="Generate MCP token bound to this profile"
                                >
                                  <Key size={13} style={{ marginRight: "4px" }} /> Connect Agent
                                </button>
                                <button
                                  className="btn-modal-cancel"
                                  style={{ padding: "5px 10px", fontSize: "12px" }}
                                  onClick={() => handleOpenEdit(p)}
                                  title="Edit profile details"
                                >
                                  <Edit2 size={13} />
                                </button>
                                <button
                                  className="btn-modal-cancel"
                                  style={{ padding: "5px 10px", fontSize: "12px", color: "#ef4444" }}
                                  onClick={() => handleDeleteProfile(p)}
                                  disabled={profiles.length <= 1}
                                  title={profiles.length <= 1 ? "Cannot delete the only profile" : "Delete profile"}
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === "general" && (
        <form className="panel-card" onSubmit={handleSaveGeneralSettings}>
          <h3>System & Automation Preferences</h3>
          <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "16px" }}>
            Global lifecycle defaults and guest container settings.
          </p>

          <div className="form-group">
            <label>Default Computer Idle Sleep Timeout (seconds)</label>
            <input
              type="number"
              className="form-input"
              value={generalSettings.idleTimeoutS}
              onChange={(e) => setGeneralSettings({ ...generalSettings, idleTimeoutS: e.target.value })}
              min={30}
              max={3600}
              required
            />
            <span style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "4px", display: "block" }}>
              Time before an inactive machine with no active agent leases gracefully stops to preserve host RAM.
            </span>
          </div>

          <div className="form-group">
            <label>Default Guest Browser Engine</label>
            <select
              className="form-select"
              value={generalSettings.defaultEngine}
              onChange={(e) => setGeneralSettings({ ...generalSettings, defaultEngine: e.target.value })}
            >
              <option value="camoufox">Camoufox (Anti-detection stealth Firefox)</option>
              <option value="chromium">Chromium</option>
            </select>
          </div>

          <button className="btn-modal-primary" style={{ marginTop: "14px" }}>
            Save Preferences
          </button>
        </form>
      )}

      {/* Add / Edit Profile Modal */}
      {showAddModal && (
        <div className="modal-backdrop" onClick={() => setShowAddModal(false)}>
          <form className="modal-box" onClick={(e) => e.stopPropagation()} onSubmit={handleSaveProfile}>
            <div className="modal-header">
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <Users size={20} color="var(--accent-blue)" />
                <h3>{editingProfile ? "Edit Profile" : "Add Profile to Shared Machine"}</h3>
              </div>
              <button type="button" className="modal-close-btn" onClick={() => setShowAddModal(false)}>
                <X size={18} />
              </button>
            </div>

            <div className="form-group">
              <label>Profile Display Name</label>
              <input
                className="form-input"
                value={profileForm.name}
                onChange={(e) => {
                  const val = e.target.value;
                  const autoSlug = val.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
                  setProfileForm({
                    ...profileForm,
                    name: val,
                    slug: editingProfile ? profileForm.slug : autoSlug,
                  });
                }}
                placeholder="e.g. Kai (Social) or Dex (Dev)"
                required
                autoFocus
              />
            </div>

            <div className="form-group">
              <label>Slug (Filesystem & Browser directory identifier)</label>
              <input
                className="form-input"
                value={profileForm.slug}
                onChange={(e) => setProfileForm({ ...profileForm, slug: e.target.value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") })}
                placeholder="e.g. kai or dex"
                disabled={Boolean(editingProfile)}
                required
              />
            </div>

            <div className="form-group">
              <label>Role / Description</label>
              <input
                className="form-input"
                value={profileForm.description}
                onChange={(e) => setProfileForm({ ...profileForm, description: e.target.value })}
                placeholder="e.g. Social media automation & content agent"
              />
            </div>

            <div className="form-group">
              <label>Badge Color Tag</label>
              <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`color-swatch-btn ${profileForm.color === c ? "selected" : ""}`}
                    style={{ background: c }}
                    onClick={() => setProfileForm({ ...profileForm, color: c })}
                  />
                ))}
              </div>
            </div>

            <div className="form-group" style={{ marginTop: "12px" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={profileForm.isDefault}
                  onChange={(e) => setProfileForm({ ...profileForm, isDefault: e.target.checked })}
                />
                <span style={{ fontSize: "13px", fontWeight: 600 }}>Set as default primary profile</span>
              </label>
            </div>

            <div className="modal-actions-row">
              <button type="button" className="btn-modal-cancel" onClick={() => setShowAddModal(false)}>
                Cancel
              </button>
              <button type="submit" className="btn-modal-primary">
                {editingProfile ? "Update Profile" : "Create Profile"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Connect Profile Agent Quick Modal */}
      {connectProfile && (
        <div className="modal-backdrop" onClick={() => setConnectProfile(null)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "560px" }}>
            <div className="modal-header">
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <Key size={20} color="var(--accent-blue)" />
                <h3>Connect Agent for {connectProfile.name}</h3>
              </div>
              <button type="button" className="modal-close-btn" onClick={() => setConnectProfile(null)}>
                <X size={18} />
              </button>
            </div>

            {!tokenResult ? (
              <form onSubmit={handleCreateAgentToken}>
                <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "14px" }}>
                  Generate an MCP access token locked directly to computer <strong>{selectedComp.name}</strong> and
                  profile <strong>{connectProfile.name}</strong> ({connectProfile.slug}).
                </p>

                <div className="form-group">
                  <label>Agent / Client Name</label>
                  <input
                    className="form-input"
                    value={agentForm.name}
                    onChange={(e) => setAgentForm({ ...agentForm, name: e.target.value })}
                    required
                    autoFocus
                  />
                </div>

                <div className="form-group">
                  <label>Capabilities (Scopes)</label>
                  <div className="scopes-grid">
                    {[
                      { id: "read", desc: "Screenshot & computer status" },
                      { id: "write", desc: "Mouse/keyboard input & terminal" },
                      { id: "browser", desc: "Automate isolated browser instance" },
                      { id: "files", desc: "Workspace file access" },
                    ].map(({ id, desc }) => (
                      <label key={id} className="scope-checkbox-label">
                        <input
                          type="checkbox"
                          checked={agentForm.scopes.includes(id)}
                          onChange={() => {
                            setAgentForm((prev) => ({
                              ...prev,
                              scopes: prev.scopes.includes(id)
                                ? prev.scopes.filter((s) => s !== id)
                                : [...prev.scopes, id],
                            }));
                          }}
                        />
                        <div>
                          <div style={{ fontWeight: 600, textTransform: "capitalize" }}>{id}</div>
                          <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>{desc}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="modal-actions-row">
                  <button type="button" className="btn-modal-cancel" onClick={() => setConnectProfile(null)}>
                    Cancel
                  </button>
                  <button type="submit" className="btn-modal-primary">
                    Generate Profile Token
                  </button>
                </div>
              </form>
            ) : (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#10b981", marginBottom: "8px" }}>
                  <CheckCircle size={18} />
                  <span style={{ fontWeight: 700 }}>Token Created Successfully</span>
                </div>
                <code className="code-token-box">{tokenResult.token}</code>

                <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "12px" }}>
                  Add this MCP server block to your Hermes <code>config.yaml</code> or Claude Desktop config:
                </p>
                <pre className="code-snippet-box">{snippet}</pre>

                <div className="modal-actions-row">
                  <button
                    className="btn-modal-primary"
                    onClick={copyConfig}
                    style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
                  >
                    {tokenCopied ? <Check size={14} /> : <Copy size={14} />}
                    <span>{tokenCopied ? "Copied!" : "Copy Configuration"}</span>
                  </button>
                  <button className="btn-modal-cancel" onClick={() => setConnectProfile(null)}>
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
