import React, { useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc/lib/rfb.js";
import { api, stateColor } from "./api.js";

function resolveRFB(raw) {
  let ctor = raw;
  while (ctor && typeof ctor !== "function" && ctor.default) {
    ctor = ctor.default;
  }
  return ctor;
}

// The workspace: live desktop via the authenticated noVNC proxy, plus
// lifecycle controls and live stats. The WebSocket connection itself
// wakes the computer and holds the owner's presence lease server-side,
// so opening this page is all it takes to bring a computer up.
export default function Workspace({ computerId, navigate }) {
  const [computer, setComputer] = useState(null);
  const [stats, setStats] = useState(null);
  const [connState, setConnState] = useState("connecting");
  const [error, setError] = useState("");
  const screenRef = useRef(null);
  const rfbRef = useRef(null);
  const wakeOnOpenRef = useRef(true);

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

  useEffect(() => { load(); }, [computerId]);

  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const s = await api("GET", `/api/computers/${computerId}/stats`);
        setStats(s);
        load();
      } catch { /* transient */ }
    }, 5000);
    return () => clearInterval(t);
  }, [computerId]);

  const connect = () => {
    if (!screenRef.current || rfbRef.current) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/api/computers/${computerId}/vnc`;
    setConnState("connecting");
    const RFBConstructor = resolveRFB(RFB);
    const rfb = new RFBConstructor(screenRef.current, url, {});
    rfb.scaleViewport = true;
    rfb.background = "#000";
    rfb.addEventListener("connect", () => setConnState("connected"));
    rfb.addEventListener("disconnect", (e) => {
      rfbRef.current = null;
      setConnState(e.detail.clean ? "disconnected" : "failed");
    });
    rfbRef.current = rfb;
  };

  useEffect(() => {
    if (!computer) return;
    if (!["sleeping", "stopped"].includes(computer.state)) { wakeOnOpenRef.current = false; connect(); }
    else if (wakeOnOpenRef.current) {
      wakeOnOpenRef.current = false;
      api("POST", `/api/computers/${computerId}/wake`, {}).then(load).catch((e) => setError(e.message));
    }
  }, [computer?.state]);

  useEffect(() => () => { try { rfbRef.current?.disconnect(); } catch { /* noop */ } }, []);

  const act = async (action) => {
    setError("");
    try {
      if (action === "sleep") { try { rfbRef.current?.disconnect(); } catch { /* noop */ } rfbRef.current = null; }
      await api("POST", `/api/computers/${computerId}/${action}`, {});
      await load();
    } catch (e) { setError(e.message); }
  };

  if (!computer) return <div className="page"><p className="muted">Loading…</p>{error && <p className="error">{error}</p>}</div>;

  return (
    <div className="page workspace">
      <div className="ws-head">
        <button className="btn ghost" onClick={() => navigate("#/computers")}>← Computers</button>
        <h2>{computer.name}</h2>
        <span className="badge" style={{ background: stateColor(computer.state) }}>{computer.state}</span>
        <span className="muted">{computer.cpuMillis / 1000} CPU · {computer.memoryMb} MB RAM · persistent disk (no hard quota)</span>
        <span className="spacer" />
        {stats?.stats && (
          <span className="muted">
            live: CPU {stats.stats.cpuPercent}% · RAM {stats.stats.memoryUsageMb}/{stats.stats.memoryLimitMb || "∞"} MB · net ↓{stats.stats.networkRxMb} MB ↑{stats.stats.networkTxMb} MB
          </span>
        )}
        {["sleeping", "stopped"].includes(computer.state)
          ? <button className="btn primary" onClick={() => act("wake")}>Wake</button>
          : <button className="btn" onClick={() => act("sleep")}>Sleep</button>}
        <button className="btn" onClick={() => screenRef.current?.requestFullscreen?.()}>Fullscreen</button>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="screen-wrap">
        {connState !== "connected" && (
          <div className="screen-overlay">
            {["sleeping", "stopped"].includes(computer.state) || connState === "connecting"
              ? "Waking the computer and connecting to its desktop…"
              : connState === "failed"
                ? "Desktop connection dropped."
                : "Desktop disconnected."}
            {(connState === "failed" || connState === "disconnected") && (
              <button className="btn primary" onClick={() => { setConnState("connecting"); connect(); }}>Reconnect</button>
            )}
          </div>
        )}
        <div ref={screenRef} className="screen" />
      </div>
      <p className="muted small">
        You and your agents share this exact desktop and cursor. If an agent is working here,
        moving your mouse takes control back instantly — the agent is paused until you stop.
      </p>
    </div>
  );
}
