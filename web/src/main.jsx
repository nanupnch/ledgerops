import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const API_BASE = "/api/v1";

const SCENARIOS = [
  {
    id: "normal",
    label: "Normal transfer",
    short: "Normal",
    detail: "Create one balanced debit and credit.",
    icon: "M5 12h14M13 6l6 6-6 6",
    tone: "blue",
  },
  {
    id: "retry",
    label: "Retry after timeout",
    short: "Retry",
    detail: "Submit one key twice and watch replay.",
    icon: "M20 7v5h-5M4 17v-5h5M19 12a7 7 0 0 0-12-5M5 12a7 7 0 0 0 12 5",
    tone: "green",
  },
  {
    id: "race",
    label: "Opposite direction race",
    short: "Race",
    detail: "Run opposing transfers over shared locks.",
    icon: "M7 7h10l-3-3M17 17H7l3 3",
    tone: "amber",
  },
  {
    id: "hotspot",
    label: "Hot merchant contention",
    short: "Hotspot",
    detail: "Fire many requests into two hot accounts.",
    icon: "M12 3v18M5 8h14M5 16h14",
    tone: "red",
  },
  {
    id: "audit",
    label: "Invariant audit",
    short: "Audit",
    detail: "Check balances, entries, and transfer shape.",
    icon: "M5 13l4 4L19 7",
    tone: "violet",
  },
];

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(data?.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return { data, status: response.status };
}

function money(cents) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((Number(cents) || 0) / 100);
}

function nowKey(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function Icon({ path }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

function App() {
  const [accounts, setAccounts] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [selectedTransfer, setSelectedTransfer] = useState(null);
  const [selectedTransferId, setSelectedTransferId] = useState(null);
  const [integrity, setIntegrity] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [activeScenario, setActiveScenario] = useState("normal");
  const [activeView, setActiveView] = useState("timeline");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("Ready");
  const [apiOnline, setApiOnline] = useState(false);
  const [form, setForm] = useState({ from: "", to: "", amount: 2500, key: nowKey("manual") });

  useEffect(() => {
    refreshAll();
    checkHealth();
  }, []);

  useEffect(() => {
    if (accounts.length >= 2 && (!form.from || !form.to)) {
      setForm((current) => ({ ...current, from: String(accounts[0].id), to: String(accounts[1].id) }));
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

  async function checkHealth() {
    try {
      const response = await fetch("/health");
      setApiOnline(response.ok);
    } catch {
      setApiOnline(false);
    }
  }

  async function refreshAll() {
    const [accountsResult, transfersResult, integrityResult] = await Promise.allSettled([
      api("/accounts"),
      api("/transfers"),
      api("/integrity"),
    ]);
    if (accountsResult.status === "fulfilled") setAccounts(accountsResult.value.data || []);
    if (transfersResult.status === "fulfilled") {
      const nextTransfers = transfersResult.value.data || [];
      setTransfers(nextTransfers);
      if (!selectedTransferId && nextTransfers.length > 0) setSelectedTransferId(nextTransfers[0].id);
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

  function appendTimeline(rows) {
    setTimeline((current) => [...rows, ...current].slice(0, 80));
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

  async function runScenario(id) {
    setActiveScenario(id);
    setActiveView(id === "audit" ? "audit" : "timeline");
    setBusy(true);
    try {
      const available = await ensureAccounts();
      if (id !== "audit" && available.length < 2) {
        setNotice("Seed accounts before running transfers.");
        return;
      }

      if (id === "normal") {
        await postTransfer({ from_account_id: available[0].id, to_account_id: available[1].id, amount: 2500 }, nowKey("normal"), "normal-01");
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
        const { data } = await api("/demo/scenarios/hotspot", { method: "POST", body: JSON.stringify({ count: 32, amount: 100 }) });
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
      await checkHealth();
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
    setActiveView("timeline");
    try {
      const payload = { from_account_id: Number(form.from), to_account_id: Number(form.to), amount: Number(form.amount) };
      await postTransfer(payload, form.key || nowKey("manual"), "manual-01");
      setForm((current) => ({ ...current, key: nowKey("manual") }));
      setNotice("Manual transfer submitted.");
      await refreshAll();
    } catch (error) {
      setNotice(error.message);
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
    return { ...base, abortRate: attempts ? Math.round(((base.conflict + base.failed) / attempts) * 100) : 0 };
  }, [timeline]);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-row">
          <div className="brand-mark">LO</div>
          <div>
            <h1>LedgerOps Workbench</h1>
            <p>Money movement reliability lab</p>
          </div>
        </div>
        <div className="header-status" aria-label="System status">
          <span className={`online-dot ${apiOnline ? "online" : "offline"}`} />
          <span>{apiOnline ? "API online" : "API offline"}</span>
          <span className="env-pill">demo</span>
        </div>
      </header>

      <section className="command-strip" aria-label="Scenario presets">
        {SCENARIOS.map((scenario) => (
          <ScenarioButton
            key={scenario.id}
            scenario={scenario}
            active={activeScenario === scenario.id}
            busy={busy}
            onClick={() => runScenario(scenario.id)}
          />
        ))}
      </section>

      <div className="workbench-grid">
        <aside className="scenario-rail" aria-label="Scenario presets">
          <div className="rail-head">
            <span>Scenarios</span>
            <button className="icon-button" type="button" onClick={refreshAll} aria-label="Refresh ledger state">Refresh</button>
          </div>
          <div className="scenario-list">
            {SCENARIOS.map((scenario) => (
              <ScenarioButton
                key={scenario.id}
                scenario={scenario}
                active={activeScenario === scenario.id}
                busy={busy}
                onClick={() => runScenario(scenario.id)}
              />
            ))}
          </div>
          <div className="rail-card">
            <span>API base</span>
            <strong>127.0.0.1:8080</strong>
            <small>{apiOnline ? "healthy" : "not responding"}</small>
          </div>
        </aside>

        <section className="primary-column">
          <section className="status-card">
            <div>
              <span className="section-kicker">Current lab state</span>
              <h2>{notice}</h2>
            </div>
            <div className="status-actions">
              <button className="secondary-button" type="button" onClick={seedDemo} disabled={busy}>Seed</button>
              <button className="ghost-button" type="button" onClick={resetDemo} disabled={busy}>Reset</button>
            </div>
          </section>

          <ManualTransfer accounts={accounts} form={form} setForm={setForm} busy={busy} onSubmit={submitManual} />

          <nav className="view-tabs" aria-label="Workbench views">
            {["timeline", "ledger", "audit"].map((view) => (
              <button key={view} type="button" className={activeView === view ? "active" : ""} onClick={() => setActiveView(view)}>
                {view}
              </button>
            ))}
          </nav>

          <Timeline
            activeView={activeView}
            rows={timeline}
            transfers={transfers}
            selectedTransferId={selectedTransferId}
            onSelect={(id) => {
              setSelectedTransferId(id);
              setActiveView("ledger");
            }}
          />
        </section>

        <LedgerTruth
          activeView={activeView}
          accounts={accounts}
          transfers={transfers}
          selectedTransfer={selectedTransfer}
          integrity={integrity}
          busy={busy}
          onAudit={() => runScenario("audit")}
          onSelectTransfer={(id) => {
            setSelectedTransferId(id);
            setActiveView("ledger");
          }}
        />
      </div>

      <CounterStrip counters={counters} />
    </main>
  );
}

function ScenarioButton({ scenario, active, busy, onClick }) {
  return (
    <button type="button" className={`scenario-button ${scenario.tone} ${active ? "active" : ""}`} onClick={onClick} disabled={busy}>
      <span className="scenario-icon"><Icon path={scenario.icon} /></span>
      <span>
        <strong>{scenario.label}</strong>
        <small>{scenario.detail}</small>
      </span>
    </button>
  );
}

function ManualTransfer({ accounts, form, setForm, busy, onSubmit }) {
  return (
    <section className="manual-panel">
      <div className="panel-title">
        <span className="section-kicker">Manual transfer</span>
        <h3>Send a controlled request</h3>
      </div>
      <form className="transfer-form" onSubmit={onSubmit}>
        <label>
          From account
          <select value={form.from} onChange={(event) => setForm({ ...form, from: event.target.value })}>
            {accounts.map((account) => <option key={account.id} value={account.id}>acct {account.id}</option>)}
          </select>
        </label>
        <label>
          To account
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
        <button className="primary-button" type="submit" disabled={busy || accounts.length < 2}>Send transfer</button>
      </form>
    </section>
  );
}

function Timeline({ activeView, rows, transfers, selectedTransferId, onSelect }) {
  const visibleRows = rows.length
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
    <section className={`timeline-panel mobile-pane ${activeView === "timeline" ? "active" : ""}`}>
      <div className="panel-heading">
        <div>
          <span className="section-kicker">Live timeline</span>
          <h3>Requests touching ledger state</h3>
        </div>
        <span>{visibleRows.length} visible</span>
      </div>

      {visibleRows.length === 0 ? (
        <div className="empty-state">Seed accounts or run a scenario to populate the lab.</div>
      ) : (
        <div className="timeline-list" aria-label="Transaction timeline">
          {visibleRows.map((row, index) => (
            <button
              key={`${row.request_id}-${index}`}
              type="button"
              className={`timeline-row ${selectedTransferId === row.transfer_id ? "selected" : ""}`}
              onClick={() => row.transfer_id && onSelect(row.transfer_id)}
              disabled={!row.transfer_id}
            >
              <span className="timeline-main">
                <span className="mono request-id">{row.request_id}</span>
                <span className="route">acct {row.from_account_id} <b>to</b> acct {row.to_account_id}</span>
              </span>
              <StatusPill status={row.status} code={row.http_status} />
              <span className="timeline-meta">
                <span className="truncate">{row.idempotency_key}</span>
                <span className="mono">{money(row.amount)} / {row.duration_ms || "-"} ms</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function LedgerTruth({ activeView, accounts, transfers, selectedTransfer, integrity, busy, onAudit, onSelectTransfer }) {
  return (
    <aside className={`truth-panel mobile-pane ${activeView === "ledger" || activeView === "audit" ? "active" : ""}`} aria-label="Ledger truth">
      <div className="panel-heading truth-heading">
        <div>
          <span className="section-kicker">Ledger truth</span>
          <h3>Database enforced state</h3>
        </div>
        <button className="secondary-button small" type="button" onClick={onAudit} disabled={busy}>Audit</button>
      </div>

      <section className="truth-section balances-section">
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
        <h4>Selected transfer</h4>
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

      <section className="truth-section audit-card">
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
  return <span className={`status-pill ${status}`}>{status}<em>{code}</em></span>;
}

function CounterStrip({ counters }) {
  const items = [
    ["successful", counters.created, "success"],
    ["replays", counters.replayed, "info"],
    ["conflicts", counters.conflict, "warn"],
    ["errors", counters.failed, "danger"],
    ["abort rate", `${counters.abortRate}%`, "neutral"],
  ];
  return (
    <footer className="counter-strip" aria-label="System counters">
      {items.map(([label, value, tone]) => (
        <div className={`counter ${tone}`} key={label}>
          <strong>{value}</strong>
          <span>{label}</span>
        </div>
      ))}
    </footer>
  );
}

createRoot(document.getElementById("root")).render(<App />);

