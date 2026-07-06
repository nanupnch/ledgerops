# LedgerOps Workbench

LedgerOps Workbench is an interactive reliability lab for a Go/PostgreSQL ledger service. It shows how transfers behave under client retries, lock contention, and database-enforced accounting invariants.

The system is built around a simple money-movement contract: every accepted transfer must be idempotent, deadlock-resistant, balance-preserving, and auditable from database state.

---

## Core Guarantees

**Safe retries**
Each transfer request requires an `Idempotency-Key` header. The API hashes the full request payload and stores the completed response. A later request with the same key and same payload returns the original transfer with HTTP `200`. A later request with the same key and a different payload is rejected.

**Deterministic locking**
Transfers lock account rows in sorted account-ID order. Opposite-direction transfers, such as account 1 to account 2 and account 2 to account 1, acquire locks in the same order and avoid circular waits.

**Fast contention failure**
The transfer coordinator uses `SELECT FOR UPDATE NOWAIT`. When hot accounts are already locked, the request fails with HTTP `409` instead of waiting behind contention and consuming database connections.

**Database-enforced accounting integrity**
Ledger entries are double-entry records. A deferrable PostgreSQL constraint trigger rejects any transfer whose ledger-entry deltas do not sum to zero at commit time. Account balances also carry a database check constraint preventing negative balances.

---

## Workbench

The React/Vite app in `web/` is the primary interface for exercising the ledger service.

It supports five scenarios:

| Scenario | Behavior |
|---|---|
| Normal transfer | Creates one completed transfer and shows the debit and credit entries |
| Retry after timeout | Submits the same payload twice with the same idempotency key and shows the second request as a `200` replay |
| Opposite direction race | Fires transfers between the same two accounts in opposite directions |
| Hot merchant contention | Sends concurrent requests against hot accounts and surfaces `409` conflicts |
| Invariant audit | Reads database state and reports negative balances, malformed transfers, and unbalanced transfers |

The screen is organized as an operational workbench:

| Region | Purpose |
|---|---|
| Scenario rail | Starts transfer, replay, contention, and audit workflows |
| Transaction timeline | Shows request IDs, idempotency keys, statuses, account routes, amounts, and durations |
| Ledger truth panel | Shows account balances, selected transfer details, ledger entries, and invariant results |
| Counter strip | Summarizes successful transfers, replays, conflicts, errors, and abort rate |

---

## API

Base path: `/api/v1`

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/accounts` | Create an account |
| `GET` | `/accounts` | List accounts |
| `GET` | `/accounts/{id}` | Read one account |
| `POST` | `/transfers` | Execute an idempotent transfer |
| `GET` | `/transfers` | List recent transfers |
| `GET` | `/transfers/{id}` | Read one transfer with ledger entries |
| `GET` | `/integrity` | Run invariant checks against database state |
| `POST` | `/demo/reset` | Reset demo data in development/demo environments |
| `POST` | `/demo/seed` | Seed demo accounts in development/demo environments |
| `POST` | `/demo/scenarios/hotspot` | Run a concurrent hotspot scenario in development/demo environments |

Demo mutation endpoints are enabled only when `ENVIRONMENT` is `development` or `demo`.

---

## Running Locally

Requires Go 1.21+, PostgreSQL, and Node.js. The provided Docker Compose file can start PostgreSQL plus observability services.

```bash
# Start database and supporting services
docker compose up -d

# Run migrations
make migrate-up

# Start API on localhost:8080
make run
```

Start the Workbench in a second terminal:

```bash
cd web
npm install
npm run dev
```

Open `http://127.0.0.1:5173/`. Vite proxies `/api` requests to `http://127.0.0.1:8080`.

---

## Transfer Example

```bash
curl -i \
  -X POST http://localhost:8080/api/v1/transfers \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: transfer-001" \
  -d '{"from_account_id":1,"to_account_id":2,"amount":100}'
```

A new transfer returns HTTP `201`. Repeating the same command returns HTTP `200` with the stored response.

---

## Benchmarks

The benchmark harness in `cmd/benchmark` supports uniform and hotspot workloads.

```bash
make benchmark-uniform
make benchmark-hotspot
```

Representative results from the included JSON artifacts:

| Load profile | Throughput | Conflict abort rate | Integrity violations |
|---|---:|---:|---:|
| Uniform | 359 TPS | 0% | 0 |
| Hotspot | Contention-limited | 66% | 0 |

High abort rates under hotspot load are expected. They indicate that locked hot accounts reject excess concurrent work quickly while preserving ledger invariants.

---

## Architecture

```text
Client or Workbench
  |
  v
HTTP API (Go)
  |
  +-- Idempotency layer
  |     SHA-256(request body) + Idempotency-Key
  |     completed match -> stored response
  |     mismatched payload -> rejection
  |
  v
Transfer coordinator
  |
  +-- Sort account IDs for deterministic lock order
  +-- Lock account rows with SELECT FOR UPDATE NOWAIT
  +-- Insert transfer intent
  +-- Insert debit and credit ledger entries
  +-- Update account balances
  |
  v
PostgreSQL
  +-- balance >= 0 check constraint
  +-- deferrable ledger sum trigger
  +-- transaction commit or rollback
```

---

## Repository Structure

```text
cmd/api          HTTP API entry point
cmd/benchmark    Load generator for uniform and hotspot workloads
cmd/seeder       Account seeding utility
db/migrations    PostgreSQL schema and invariant trigger
internal/api     HTTP handlers, demo scenarios, and response mapping
internal/config  Environment configuration
internal/domain  Shared API and ledger models
internal/store   PostgreSQL transfer, query, demo, and integrity logic
web              React/Vite Workbench UI
analysis         Plotting utilities for benchmark artifacts
```

