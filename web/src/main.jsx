import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const API_BASE = "/api/v1";

const scenarios = [
  {
    id: "normal",
    label: "Normal transfer",
    detail: "One clean debit and credit pair.",
    icon: "M5 12h14M13 6l6 6-6 6",
  },
  {
    id: "retry",
    label: "Retry after timeout",
    detail: "Same key, same payload, second call replays.",
    icon: "M20 7v5h-5M4 17v-5h5M19 12a7 7 0 0 0-12-5M5 12a7 7 0 0 0 12 5",
  },
  {
    id: "race",
    label: "Opposite direction race",
    detail: "A to B and B to A under shared locks.",
    icon: "M7 7h10l-3-3M17 17H7l3 3",
  },
  {
    id: "hotspot",
    label: "Hot merchant contention",
    detail: "Many requests hit the same accounts.",
    icon: "M12 3v18M5 8h14M5 16h14",
  },
  {
    id: "audit",
    label: "Invariant audit",
    detail: "Ask Postgres what is true now.",
    icon: "M5 13l4 4L19 7",
  },
];

function Icon({ path }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="icon">
      <path d={path} />
    </svg>
  );
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = data?.error || `HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return { data, status: response.status };
}

function money(cents) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format((cents || 0) / 100);
}

function nowKey(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function App() {
  const [accounts, setAccounts] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [selectedTransfer, setSelectedTransfer] = useState(null);
  const [selectedTransferId, setSelectedTransferId] = useState(null);
  const [integrity, setIntegrity] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [activeScenario, setActiveScenario] = useState("normal");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("Ready");
  const [form, setForm] = useState({ from: "", to: "", amount: 2500, key: nowKey("manual") });

  useEffect(() => {
    refreshAll();
  }, []);

  useEffect(() => {
    if (accounts.length >= 2 && (!form.from || !form.to)) {
      setForm((current) => ({ ...current, from: accounts[0].id, to: accounts[1].id }));
    }
  }, [accounts, form.from, form.to]);

  useEffect(() => {
    if (!selectedTransferId) {
      setSelectedTransfer(null);
      return;
    }
    api(`/transfers/${selectedTransferId}`)
      .then(({ data }) => setSelectedTransfer(data))
      .catch(() => setSelectedTransfer(null));
  }, [selectedTransferId]);

  async function refreshAll() {
    const [accountsResult, transfersResult, integrityResult] = await Promise.allSettled([
      api("/accounts"),
      api("/transfers"),
      api("/integrity"),
    ]);
    if (accountsResult.status === "fulfilled") setAccounts(accountsResult.value.data);
    if (transfersResult.status === "fulfilled") {
      setTransfers(transfersResult.value.data);
      if (!selectedTransferId && transfersResult.value.data.length > 0) {
        setSelectedTransferId(transfersResult.value.data[0].id);
      }
    }
    if (integrityResult.status === "fulfilled") setIntegrity(integrityResult.value.data);
  }

  async function seedDemo() {
    setBusy(true);
    try {
      const { data } = await api("/demo/seed", { method: "POST", body: "{}" });
      setAccounts(data.accounts || []);
      setTransfers([]);
      setSelectedTransfer(null);
      setSelectedTransferId(null);
      setTimeline([]);
      setNotice("Demo ledger seeded with four accounts.");
      await refreshAll();
      return data.accounts || [];
    } catch (error) {
      setNotice(error.message);
      return accounts;
    } finally {
      setBusy(false);
    }
  }

  async function resetDemo() {
    setBusy(true);
    try {
      await api("/demo/reset", { method: "POST", body: "{}" });
      setAccounts([]);
      setTransfers([]);
      setSelectedTransfer(null);
      setSelectedTransferId(null);
      setTimeline([]);
      setIntegrity(null);
      setNotice("Demo ledger reset.");
      await refreshAll();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function ensureAccounts() {
    if (accounts.length >= 2) return accounts;
    return seedDemo();
  }

  async function postTransfer(payload, idempotencyKey, requestId) {
    const started = performance.now();
    try {
      const { data, status } = await api("/transfers", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(payload),
      });
      const row = {
        request_id: requestId,
        idempotency_key: idempotencyKey,
        status: status === 200 || data.replayed ? "replayed" : "created",
        http_status: status,
        transfer_id: data.transfer?.id,
        from_account_id: payload.from_account_id,
        to_account_id: payload.to_account_id,
        amount: payload.amount,
        duration_ms: Math.max(1, Math.round(performance.now() - started)),
      };
      appendTimeline([row]);
      setSelectedTransferId(data.transfer?.id || null);
      return row;
    } catch (error) {
      const row = {
        request_id: requestId,
        idempotency_key: idempotencyKey,
        status: error.status === 409 ? "conflict" : "failed",
        http_status: error.status || 500,
        from_account_id: payload.from_account_id,
        to_account_id: payload.to_account_id,
        amount: payload.amount,
        duration_ms: Math.max(1, Math.round(performance.now() - started)),
        error: error.message,
      };
      appendTimeline([row]);
      return row;
    }
  }

  function appendTimeline(rows) {
    setTimeline((current) => [...rows, ...current].slice(0, 80));
  }

  async function runScenario(id) {
    setActiveScenario(id);
    setBusy(true);
    try {
      const available = await ensureAccounts();
      if (id !== "audit" && available.length < 2) {
        setNotice("Seed accounts before running transfers.");
        return;
      }

      if (id === "normal") {
        const payload = { from_account_id: available[0].id, to_account_id: available[1].id, amount: 2500 };
        await postTransfer(payload, nowKey("normal"), "normal-01");
        setNotice("Normal transfer created.");
      }

      if (id === "retry") {
        const payload = { from_account_id: available[0].id, to_account_id: available[1].id, amount: 1900 };
        const key = nowKey("retry");
        await postTransfer(payload, key, "retry-01");
        await postTransfer(payload, key, "retry-02");
        setNotice("Second retry returned 200 replay.");
      }

      if (id === "race") {
        const requests = Array.from({ length: 12 }, (_, index) => {
          const forward = index % 2 === 0;
          const payload = {
            from_account_id: forward ? available[0].id : available[1].id,
            to_account_id: forward ? available[1].id : available[0].id,
            amount: 450,
          };
          return postTransfer(payload, nowKey("race"), `race-${String(index + 1).padStart(2, "0")}`);
        });
        await Promise.allSettled(requests);
        setNotice("Opposite direction race completed.");
      }

      if (id === "hotspot") {
        const { data } = await api("/demo/scenarios/hotspot", {
          method: "POST",
          body: JSON.stringify({ count: 32, amount: 100 }),
        });
        appendTimeline(data.results || []);
        const firstTransfer = (data.results || []).find((row) => row.transfer_id);
        if (firstTransfer) setSelectedTransferId(firstTransfer.transfer_id);
        setNotice("Hotspot scenario fired 32 concurrent requests.");
      }

      if (id === "audit") {
        const { data } = await api("/integrity");
        setIntegrity(data);
        setNotice(data.ok ? "Invariant audit passed." : "Invariant audit found issues.");
      }

      await refreshAll();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitManual(event) {
    event.preventDefault();
    if (!form.from || !form.to) return;
    setBusy(true);
    try {
      const payload = {
        from_account_id: Number(form.from),
        to_account_id: Number(form.to),
        amount: Number(form.amount),
      };
      await postTransfer(payload, form.key || nowKey("manual"), "manual-01");
      setForm((current) => ({ ...current, key: nowKey("manual") }));
      setNotice("Manual transfer submitted.");
      await refreshAll();
    } finally {
      setBusy(false);
    }
  }

  const counters = useMemo(() => {
    const base = { created: 0, replayed: 0, conflict: 0, failed: 0 };
    for (const row of timeline) {
      if (base[row.status] !== undefined) base[row.status] += 1;
    }
    const attempts = base.created + base.replayed + base.conflict + base.failed;
    const abortRate = attempts ? Math.round(((base.conflict + base.failed) / attempts) * 100) : 0;
    return { ...base, abortRate };
  }, [timeline]);

  return (
    <main className="app-shell">
      <aside className="scenario-rail" aria-label="Scenario presets">
        <div className="brand-block">
          <div className="brand-mark">LO</div>
          <div>
            <h1>LedgerOps Workbench</h1>
            <p>Transaction reliability lab</p>
          </div>
        </div>

        <div className="rail-actions">
          <button className="secondary-button" type="button" onClick={seedDemo} disabled={busy}>Seed</button>
          <button className="ghost-button" type="button" onClick={resetDemo} disabled={busy}>Reset</button>
        </div>

        <nav className="scenario-list">
          {scenarios.map((scenario) => (
            <button
              key={scenario.id}
              type="button"
              className={`scenario-button ${activeScenario === scenario.id ? "active" : ""}`}
              onClick={() => runScenario(scenario.id)}
              disabled={busy}
            >
              <Icon path={scenario.icon} />
              <span>
                <strong>{scenario.label}</strong>
                <small>{scenario.detail}</small>
              </span>
            </button>
          ))}
        </nav>
      </aside>

      <section className="workbench-core">
        <header className="topbar">
          <div>
            <p className="eyeline">Current lab state</p>
            <h2>{notice}</h2>
          </div>
          <form className="transfer-form" onSubmit={submitManual}>
            <label>
              From
              <select value={form.from} onChange={(event) => setForm({ ...form, from: event.target.value })}>
                {accounts.map((account) => <option key={account.id} value={account.id}>acct {account.id}</option>)}
              </select>
            </label>
            <label>
              To
              <select value={form.to} onChange={(event) => setForm({ ...form, to: event.target.value })}>
                {accounts.map((account) => <option key={account.id} value={account.id}>acct {account.id}</option>)}
              </select>
            </label>
            <label>
              Amount
              <input type="number" min="1" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} />
            </label>
            <label className="key-field">
              Idempotency key
              <input value={form.key} onChange={(event) => setForm({ ...form, key: event.target.value })} />
            </label>
            <button className="primary-button" type="submit" disabled={busy || accounts.length < 2}>Run</button>
          </form>
        </header>

        <Timeline rows={timeline} transfers={transfers} onSelect={setSelectedTransferId} selectedTransferId={selectedTransferId} />
      </section>

      <LedgerTruth
        accounts={accounts}
        transfers={transfers}
        selectedTransfer={selectedTransfer}
        integrity={integrity}
        onAudit={() => runScenario("audit")}
        onSelectTransfer={setSelectedTransferId}
        busy={busy}
      />

      <footer className="counter-strip" aria-label="System counters">
        <Counter label="successful transfers" value={counters.created} tone="success" />
        <Counter label="replays" value={counters.replayed} tone="info" />
        <Counter label="conflicts" value={counters.conflict} tone="warn" />
        <Counter label="other errors" value={counters.failed} tone="danger" />
        <Counter label="abort rate" value={`${counters.abortRate}%`} tone="neutral" />
      </footer>
    </main>
  );
}

function Timeline({ rows, transfers, onSelect, selectedTransferId }) {
  const fallbackRows = rows.length
    ? rows
    : transfers.slice(0, 18).map((transfer) => ({
        request_id: `db-${transfer.id}`,
        idempotency_key: "persisted transfer",
        status: "created",
        http_status: 201,
        transfer_id: transfer.id,
        from_account_id: transfer.from_account_id,
        to_account_id: transfer.to_account_id,
        amount: transfer.amount,
        duration_ms: 0,
      }));

  return (
    <section className="timeline-panel">
      <div className="panel-heading">
        <div>
          <p className="eyeline">Live transaction timeline</p>
          <h3>Requests touching ledger state</h3>
        </div>
        <span>{fallbackRows.length} visible</span>
      </div>

      <div className="timeline-table" role="table" aria-label="Transaction timeline">
        <div className="timeline-head" role="row">
          <span>request id</span>
          <span>idempotency key</span>
          <span>status</span>
          <span>route</span>
          <span>amount</span>
          <span>duration</span>
        </div>
        <div className="timeline-body">
          {fallbackRows.length === 0 ? (
            <div className="empty-state">Seed demo accounts or run a scenario to populate the lab.</div>
          ) : fallbackRows.map((row, index) => (
            <button
              key={`${row.request_id}-${index}`}
              type="button"
              className={`timeline-row ${selectedTransferId === row.transfer_id ? "selected" : ""}`}
              onClick={() => row.transfer_id && onSelect(row.transfer_id)}
              disabled={!row.transfer_id}
            >
              <span className="mono">{row.request_id}</span>
              <span className="truncate">{row.idempotency_key}</span>
              <StatusPill status={row.status} code={row.http_status} />
              <span className="route">acct {row.from_account_id} <b>to</b> acct {row.to_account_id}</span>
              <span className="mono">{money(row.amount)}</span>
              <span className="mono">{row.duration_ms || "-"} ms</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function LedgerTruth({ accounts, transfers, selectedTransfer, integrity, onAudit, onSelectTransfer, busy }) {
  return (
    <aside className="truth-panel" aria-label="Ledger truth">
      <div className="panel-heading compact">
        <div>
          <p className="eyeline">Ledger truth</p>
          <h3>Database enforced state</h3>
        </div>
        <button className="secondary-button small" type="button" onClick={onAudit} disabled={busy}>Audit</button>
      </div>

      <section className="truth-section">
        <h4>Account balances</h4>
        <div className="balance-list">
          {accounts.length === 0 ? <p className="muted">No accounts loaded.</p> : accounts.map((account) => (
            <div className="balance-row" key={account.id}>
              <span>acct {account.id}</span>
              <strong>{money(account.balance)}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="truth-section">
        <h4>Transfer record</h4>
        {selectedTransfer ? (
          <dl className="record-grid">
            <dt>ID</dt><dd className="mono">{selectedTransfer.transfer.id}</dd>
            <dt>Status</dt><dd>{selectedTransfer.transfer.status}</dd>
            <dt>Route</dt><dd>acct {selectedTransfer.transfer.from_account_id} to acct {selectedTransfer.transfer.to_account_id}</dd>
            <dt>Amount</dt><dd className="mono">{money(selectedTransfer.transfer.amount)}</dd>
          </dl>
        ) : <p className="muted">Select a successful request.</p>}
      </section>

      <section className="truth-section">
        <h4>Ledger entries</h4>
        <div className="entry-list">
          {selectedTransfer?.entries?.length ? selectedTransfer.entries.map((entry) => (
            <div className="entry-row" key={entry.id}>
              <span>acct {entry.account_id}</span>
              <strong className={entry.delta < 0 ? "negative" : "positive"}>{entry.delta < 0 ? "-" : "+"}{money(Math.abs(entry.delta))}</strong>
            </div>
          )) : <p className="muted">No entries selected.</p>}
        </div>
      </section>

      <section className="truth-section audit-section">
        <h4>Invariant result</h4>
        {integrity ? (
          <div className={`audit-result ${integrity.ok ? "pass" : "fail"}`}>
            <strong>{integrity.ok ? "PASS" : "FAIL"}</strong>
            <span>{integrity.negative_balances} negative balances</span>
            <span>{integrity.unbalanced_transfers?.length || 0} unbalanced transfers</span>
            <span>{integrity.malformed_transfers?.length || 0} malformed transfers</span>
          </div>
        ) : <p className="muted">Run audit to verify invariants.</p>}
      </section>

      <section className="truth-section recent-section">
        <h4>Recent transfers</h4>
        <div className="mini-transfer-list">
          {transfers.slice(0, 8).map((transfer) => (
            <button key={transfer.id} type="button" onClick={() => onSelectTransfer(transfer.id)} className="mini-row">
              <span className="mono">#{transfer.id}</span>
              <span>acct {transfer.from_account_id} to {transfer.to_account_id}</span>
              <strong>{money(transfer.amount)}</strong>
            </button>
          ))}
          {transfers.length === 0 && <p className="muted">No completed transfers.</p>}
        </div>
      </section>
    </aside>
  );
}

function StatusPill({ status, code }) {
  return <span className={`status-pill ${status}`}>{status} <em>{code}</em></span>;
}

function Counter({ label, value, tone }) {
  return (
    <div className={`counter ${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);


