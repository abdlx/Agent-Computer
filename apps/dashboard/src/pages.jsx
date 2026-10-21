import React, { useEffect, useState } from "react";
import { api, stateColor, timeAgo } from "./api.js";

export function Computers({ navigate }) {
  const [computers, setComputers] = useState([]);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [deleting, setDeleting] = useState(null);

  const load = async () => {
    try {
      const r = await api("GET", "/api/computers");
      setComputers(r.computers);
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, []);

  const act = async (id, action) => {
    try { await api("POST", `/api/computers/${id}/${action}`, {}); load(); }
    catch (e) { setError(e.message); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h2>Computers</h2>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setShowCreate(true)}>+ Add computer</button>
      </div>
      {error && <p className="error">{error}</p>}
      {computers.length === 0 && (
        <div className="empty">
          <p>No computers yet.</p>
          <p className="muted">Create one — it boots in seconds, and your agents can use it over MCP while you watch (or take over) here.</p>
        </div>
      )}
      <div className="grid">
        {computers.map((c) => (
          <div key={c.id} className="card">
            <div className="card-head">
              <strong>{c.name}</strong>
              <span className="badge" style={{ background: stateColor(c.state) }}>{c.state}</span>
            </div>
            <p className="muted small">
              {c.cpuMillis / 1000} CPU · {c.memoryMb} MB RAM · {c.diskGb} GB disk<br />
              created {timeAgo(c.createdAt)}
              {c.limitsEnforced === false && <><br /><span title="This host's kernel cannot apply cgroup CPU/RAM limits">⚠ limits not enforced on this host</span></>}
            </p>
            <div className="card-actions">
              <button className="btn primary" onClick={() => navigate(`#/workspace/${c.id}`)}>Open</button>
              {c.state === "sleeping"
                ? <button className="btn" onClick={() => act(c.id, "wake")}>Wake</button>
                : <button className="btn" onClick={() => act(c.id, "sleep")}>Sleep</button>}
              <button className="btn danger" onClick={() => setDeleting(c)}>Delete</button>
            </div>
          </div>
        ))}
      </div>
      {showCreate && <CreateModal close={() => setShowCreate(false)} done={() => { setShowCreate(false); load(); }} />}
      {deleting && <DeleteModal computer={deleting} close={() => setDeleting(null)} done={() => { setDeleting(null); load(); }} />}
    </div>
  );
}

function CreateModal({ close, done }) {
  const [name, setName] = useState("");
  const [cpuMillis, setCpu] = useState(1000);
  const [memoryMb, setMem] = useState(2048);
  const [diskGb, setDisk] = useState(20);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const r = await api("POST", "/api/computers", { name, cpuMillis: Number(cpuMillis), memoryMb: Number(memoryMb), diskGb: Number(diskGb) });
      if (r.limitsEnforced === false) {
        setNote("Created. Note: this host's kernel cannot enforce CPU/RAM limits, so they are recorded but not applied.");
        setTimeout(done, 1600);
      } else done();
    } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <div className="modal-bg" onClick={close}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Add a computer</h3>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Research Box" required autoFocus /></label>
        <label>CPU
          <select value={cpuMillis} onChange={(e) => setCpu(e.target.value)}>
            <option value={500}>0.5 cores</option><option value={1000}>1 core</option>
            <option value={2000}>2 cores</option><option value={4000}>4 cores</option>
          </select></label>
        <label>Memory
          <select value={memoryMb} onChange={(e) => setMem(e.target.value)}>
            <option value={1024}>1 GB</option><option value={2048}>2 GB</option>
            <option value={4096}>4 GB</option><option value={8192}>8 GB</option>
          </select></label>
        <label>Disk
          <select value={diskGb} onChange={(e) => setDisk(e.target.value)}>
            <option value={10}>10 GB</option><option value={20}>20 GB</option><option value={40}>40 GB</option>
          </select></label>
        {error && <p className="error">{error}</p>}
        {note && <p className="muted">{note}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? "Creating…" : "Create"}</button>
        </div>
      </form>
    </div>
  );
}

function DeleteModal({ computer, close, done }) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api("DELETE", `/api/computers/${computer.id}`, { confirmName: typed });
      done();
    } catch (err) { setError(err.message); }
  };
  return (
    <div className="modal-bg" onClick={close}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Delete {computer.name}?</h3>
        <p className="muted">This permanently deletes the computer and its home volume — files, browser profile, everything. Type the computer's name to confirm.</p>
        <label>Computer name<input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={computer.name} autoFocus /></label>
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button className="btn danger" disabled={typed !== computer.name}>Delete permanently</button>
        </div>
      </form>
    </div>
  );
}

export function Agents() {
  const [tokens, setTokens] = useState([]);
  const [computers, setComputers] = useState([]);
  const [created, setCreated] = useState(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", scopes: ["read", "write", "browser", "files"], computerId: "" });

  const load = async () => {
    try {
      const [t, c] = await Promise.all([api("GET", "/api/tokens"), api("GET", "/api/computers")]);
      setTokens(t.tokens); setComputers(c.computers);
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const toggleScope = (s) =>
    setForm((f) => ({ ...f, scopes: f.scopes.includes(s) ? f.scopes.filter((x) => x !== s) : [...f.scopes, s] }));

  const create = async (e) => {
    e.preventDefault(); setError("");
    try {
      const r = await api("POST", "/api/tokens", {
        name: form.name, scopes: form.scopes,
        computerId: form.computerId || null,
      });
      setCreated(r);
      load();
    } catch (err) { setError(err.message); }
  };

  const revoke = async (id) => {
    try { await api("DELETE", `/api/tokens/${id}`); load(); }
    catch (e) { setError(e.message); }
  };

  const mcpUrl = `${location.origin}/mcp`;
  const snippet = created ? JSON.stringify({
    mcpServers: {
      "agent-computer": { url: mcpUrl, headers: { Authorization: `Bearer ${created.token}` } },
    },
  }, null, 2) : "";

  return (
    <div className="page">
      <h2>Connect an agent</h2>
      <p className="muted">
        Agents (Hermes and other MCP clients) connect to <code>{mcpUrl}</code> with a token.
        Tokens are scoped — give each agent only what it needs, optionally bound to one computer.
        Every tool call is audit-logged and wakes the computer it touches.
      </p>
      {error && <p className="error">{error}</p>}
      <form className="panel" onSubmit={create}>
        <h3>New token</h3>
        <label>Agent name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Hermes" required /></label>
        <div className="scopes">
          {["read", "write", "browser", "files", "admin"].map((s) => (
            <label key={s} className="check">
              <input type="checkbox" checked={form.scopes.includes(s)} onChange={() => toggleScope(s)} /> {s}
              <span className="muted small">
                {s === "read" && " — observe: list, status, screenshot"}
                {s === "write" && " — desktop input, terminal, wake/sleep"}
                {s === "browser" && " — drive the browser"}
                {s === "files" && " — read/write files in the home directory"}
                {s === "admin" && " — everything, incl. creating/deleting computers"}
              </span>
            </label>
          ))}
        </div>
        <label>Bind to computer
          <select value={form.computerId} onChange={(e) => setForm({ ...form, computerId: e.target.value })}>
            <option value="">Any computer</option>
            {computers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></label>
        <button className="btn primary">Create token</button>
      </form>

      {created && (
        <div className="panel highlight">
          <h3>Token created — copy it now, it won't be shown again</h3>
          <code className="token">{created.token}</code>
          <p className="muted small">MCP client configuration:</p>
          <pre className="snippet">{snippet}</pre>
          <p className="muted small">
            For Hermes: add this server under its MCP configuration (remote server, Streamable HTTP
            transport) with the same URL and Authorization header.
          </p>
          <button className="btn" onClick={() => navigator.clipboard?.writeText(snippet)}>Copy config</button>
        </div>
      )}

      <div className="panel">
        <h3>Tokens</h3>
        {tokens.length === 0 && <p className="muted">No tokens yet.</p>}
        {tokens.map((t) => (
          <div key={t.id} className="token-row">
            <strong>{t.name}</strong>
            <span className="muted small">{(Array.isArray(t.scopes) ? t.scopes : []).join(", ")}</span>
            <span className="muted small">{t.computer_id ? `bound to ${computers.find((c) => c.id === t.computer_id)?.name ?? t.computer_id}` : "any computer"}</span>
            <span className="muted small">{t.last_used_at ? `last used ${timeAgo(t.last_used_at)}` : "never used"}</span>
            {t.revoked ? <span className="badge" style={{ background: "#f85149" }}>revoked</span>
              : <button className="btn danger small" onClick={() => revoke(t.id)}>Revoke</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Audit() {
  const [entries, setEntries] = useState([]);
  useEffect(() => {
    api("GET", "/api/audit").then((r) => setEntries(r.entries)).catch(() => {});
    const t = setInterval(() => api("GET", "/api/audit").then((r) => setEntries(r.entries)).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="page">
      <h2>Audit log</h2>
      <table className="audit">
        <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Computer</th><th>Detail</th></tr></thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="muted">{timeAgo(e.ts)}</td><td>{e.actor}</td><td>{e.action}</td>
              <td className="muted">{e.computerId ?? "—"}</td>
              <td className="muted small">{e.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
