import React, { useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc/lib/rfb.js";
import {
  ArrowLeft,
  Maximize2,
  Power,
  Play,
  RefreshCw,
  Cpu,
  Server,
  Activity,
  AlertCircle
} from "lucide-react";
import { api, stateColor } from "./api.js";

function resolveRFB(raw) {
  let ctor = raw;
  while (ctor && typeof ctor !== "function" && ctor.default) {
    ctor = ctor.default;
  }
  return ctor;
}

export default function Workspace({ computerId, navigate }) {
  const [computer, setComputer] = useState(null);
  const [stats, setStats] = useState(null);
  const [connState, setConnState] = useState("connecting");
  const [error, setError] = useState("");
  const screenRef = useRef(null);
  const rfbRef = useRef(null);
  const wakeOnOpenRef = useRef(true);
  const intentionalCloseRef = useRef(false);
  const isConnectedRef = useRef(false);
  const isConnectingRef = useRef(false);
  const connectRetryCount = useRef(0);
  const connectTimeoutRef = useRef(null);
  const computerRef = useRef(null);
  const prevRunningRef = useRef(false);

  // Keep computerRef up to date for closures
  computerRef.current = computer;

  const load = async () => {
    try {
      const r = await api("GET", `/api/computers/${computerId}`);
      setComputer(r.computer);
      return r.computer;
    } catch (e) {
      setError(e.message);
      return null;
    }
  };

  useEffect(() => {
    load();
  }, [computerId]);

  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const s = await api("GET", `/api/computers/${computerId}/stats`);
        setStats(s);
        load();
      } catch {
        /* transient */
      }
    }, 5000);
    return () => clearInterval(t);
  }, [computerId]);

  const connect = (force = false) => {
    if (!screenRef.current) return;

    // Do not tear down an active or connecting stream unless force-requested
    if (!force && (isConnectedRef.current || isConnectingRef.current) && rfbRef.current) {
      return;
    }

    clearTimeout(connectTimeoutRef.current);
    connectTimeoutRef.current = null;

    if (rfbRef.current) {
      intentionalCloseRef.current = true;
      try {
        rfbRef.current.disconnect();
      } catch {
        /* noop */
      }
      rfbRef.current = null;
    }

    // Clean previous canvases from screen DOM
    if (screenRef.current) {
      screenRef.current.innerHTML = "";
    }

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/api/computers/${computerId}/vnc`;

    intentionalCloseRef.current = false;
    isConnectingRef.current = true;
    isConnectedRef.current = false;
    setConnState("connecting");

    try {
      const RFBConstructor = resolveRFB(RFB);
      const rfb = new RFBConstructor(screenRef.current, url, {
        wsProtocols: ["binary"],
      });
      rfb.scaleViewport = true;
      rfb.background = "#000";

      rfb.addEventListener("connect", () => {
        isConnectingRef.current = false;
        isConnectedRef.current = true;
        setConnState("connected");
        setError("");
        connectRetryCount.current = 0;
      });

      rfb.addEventListener("disconnect", (e) => {
        rfbRef.current = null;
        isConnectingRef.current = false;
        isConnectedRef.current = false;

        if (intentionalCloseRef.current) {
          intentionalCloseRef.current = false;
          return;
        }

        console.warn("RFB disconnect event:", e.detail);

        const currentComp = computerRef.current;
        const shouldStayConnected = currentComp && !["sleeping", "stopped"].includes(currentComp.state);

        // Auto-reconnect persistently as long as the computer is running (never give up unless stopped/sleeping)
        if (shouldStayConnected) {
          connectRetryCount.current += 1;
          setConnState("connecting");
          // Smooth backoff capped at 2s
          const delay = Math.min(500 * Math.pow(1.5, Math.min(connectRetryCount.current - 1, 4)), 2000);
          clearTimeout(connectTimeoutRef.current);
          connectTimeoutRef.current = setTimeout(() => {
            connect(true);
          }, delay);
        } else {
          setConnState(e.detail?.clean ? "disconnected" : "failed");
        }
      });

      rfbRef.current = rfb;
    } catch (err) {
      console.error("Failed to initialize RFB:", err);
      isConnectingRef.current = false;
      isConnectedRef.current = false;
      setConnState("failed");
      setError(err.message);
    }
  };

  useEffect(() => {
    if (!computer) return;
    const isRunning = !["sleeping", "stopped"].includes(computer.state);

    if (isRunning) {
      // Connect if computer just transitioned into running, or if not yet connected
      if (!prevRunningRef.current || (!isConnectedRef.current && !isConnectingRef.current && !rfbRef.current)) {
        prevRunningRef.current = true;
        wakeOnOpenRef.current = false;
        connect();
      }
    } else {
      prevRunningRef.current = false;
      if (wakeOnOpenRef.current) {
        wakeOnOpenRef.current = false;
        api("POST", `/api/computers/${computerId}/wake`, {}).then(load).catch((e) => setError(e.message));
      }
    }
  }, [computer?.state]);

  useEffect(() => () => {
    intentionalCloseRef.current = true;
    clearTimeout(connectTimeoutRef.current);
    connectTimeoutRef.current = null;
    isConnectingRef.current = false;
    isConnectedRef.current = false;
    try {
      rfbRef.current?.disconnect();
    } catch {
      /* noop */
    }
    rfbRef.current = null;
  }, []);

  const act = async (action) => {
    setError("");
    try {
      if (action === "sleep" || action === "stop") {
        intentionalCloseRef.current = true;
        clearTimeout(connectTimeoutRef.current);
        connectTimeoutRef.current = null;
        isConnectingRef.current = false;
        isConnectedRef.current = false;
        prevRunningRef.current = false;
        try {
          rfbRef.current?.disconnect();
        } catch {
          /* noop */
        }
        rfbRef.current = null;
        setConnState("disconnected");
      }
      await api("POST", `/api/computers/${computerId}/${action}`, {});
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  if (!computer) {
    return (
      <div className="page-container">
        <div style={{ color: "var(--text-secondary)", padding: "40px 0" }}>Loading computer workspace…</div>
        {error && <div className="alert-error">{error}</div>}
      </div>
    );
  }

  const isSleeping = ["sleeping", "stopped"].includes(computer.state);

  return (
    <div className="page-container workspace-container">
      {/* Workspace Header */}
      <div className="workspace-header">
        <button className="btn-back" onClick={() => navigate("#/computers")}>
          <ArrowLeft size={16} /> Back to Computers
        </button>

        <div className="workspace-title-box">
          <h2>{computer.name}</h2>
          <span
            className="pill-badge"
            style={{
              background: stateColor(computer.state),
              color: "#fff",
              padding: "3px 10px",
              fontSize: "12px",
              textTransform: "capitalize",
            }}
          >
            {computer.state}
          </span>
          <span style={{ fontSize: "12.5px", color: "var(--text-muted)" }}>
            {computer.cpuMillis / 1000} CPU · {computer.memoryMb} MB RAM · Debian 13 (XFCE)
          </span>
        </div>

        <div style={{ flex: 1 }} />

        {/* Live stats pills */}
        {stats?.stats && (
          <div className="workspace-stats-pill">
            <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <Cpu size={14} color="#3b82f6" /> CPU {stats.stats.cpuPercent}%
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <Server size={14} color="#8b5cf6" /> RAM {stats.stats.memoryUsageMb} MB
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <Activity size={14} color="#10b981" /> ↓{stats.stats.networkRxMb}MB ↑{stats.stats.networkTxMb}MB
            </span>
          </div>
        )}

        {/* Lifecycle actions */}
        {isSleeping ? (
          <button className="btn-modal-primary" style={{ display: "flex", alignItems: "center", gap: "6px" }} onClick={() => act("wake")}>
            <Play size={14} /> Wake Computer
          </button>
        ) : (
          <button className="btn-modal-cancel" style={{ display: "flex", alignItems: "center", gap: "6px" }} onClick={() => act("sleep")}>
            <Power size={14} /> Sleep
          </button>
        )}

        <button className="btn-icon-square" onClick={() => screenRef.current?.requestFullscreen?.()} title="Fullscreen">
          <Maximize2 size={16} />
        </button>
      </div>

      {error && <div className="alert-error" style={{ marginTop: "12px" }}>{error}</div>}

      {/* Screen Canvas Container */}
      <div className="screen-container">
        {connState !== "connected" && (
          <div className="screen-overlay-box">
            {isSleeping || connState === "connecting" ? (
              <>
                <RefreshCw size={26} className="badge-pulse-indicator pulse" style={{ width: "24px", height: "24px", background: "transparent", color: "#38bdf8" }} />
                <div>Waking the computer and connecting to its live desktop…</div>
              </>
            ) : connState === "failed" ? (
              <>
                <AlertCircle size={28} color="#f87171" />
                <div>Desktop connection dropped.</div>
                <button
                  className="btn-modal-primary"
                  onClick={() => {
                    connectRetryCount.current = 0;
                    connect(true);
                  }}
                >
                  Reconnect
                </button>
              </>
            ) : (
              <>
                <div>Desktop disconnected.</div>
                <button
                  className="btn-modal-primary"
                  onClick={() => {
                    connectRetryCount.current = 0;
                    connect(true);
                  }}
                >
                  Reconnect
                </button>
              </>
            )}
          </div>
        )}
        <div ref={screenRef} className="screen-view" />
      </div>

      <div style={{ marginTop: "10px", fontSize: "12px", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: "8px" }}>
        <span>💡</span>
        <span>
          You and your AI agents share this exact desktop and cursor. If an agent is interacting here, moving your mouse takes control back instantly.
        </span>
      </div>
    </div>
  );
}
