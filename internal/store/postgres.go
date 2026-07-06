package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/punchamoorthee/ledgerops/internal/domain"
)

var (
	ErrAccountNotFound  = errors.New("account not found")
	ErrConflict         = errors.New("conflict: request in progress")
	ErrKeyMismatch      = errors.New("idempotency key mismatch")
	ErrFunds            = errors.New("insufficient funds")
	ErrTransferNotFound = errors.New("transfer not found")
)

type LedgerStore struct {
	db *pgxpool.Pool
}

func NewLedgerStore(db *pgxpool.Pool) *LedgerStore {
	return &LedgerStore{db: db}
}

// ExecTransfer executes a double-entry transfer with strong consistency guarantees.
// 1. Enforces Idempotency (Exactly-Once)
// 2. Uses Deterministic Locking (Deadlock Prevention)
// 3. Enforces DB Invariants (Constraint Triggers)
func (s *LedgerStore) ExecTransfer(ctx context.Context, req domain.TransferRequest, idempotencyKey, reqHash string) (*domain.TransferResponse, bool, error) {
	// Start Tx with Repeatable Read isolation to ensure consistent snapshots
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback(ctx)

	// --- 1. IDEMPOTENCY CHECK ---
	var storedStatus string
	var storedBody json.RawMessage
	var storedHash string

	err = tx.QueryRow(ctx,
		"SELECT status, response_body, request_hash FROM idempotency_keys WHERE key = $1",
		idempotencyKey).Scan(&storedStatus, &storedBody, &storedHash)

	if err == nil {
		// Key exists
		if storedHash != reqHash {
			return nil, false, ErrKeyMismatch
		}
		if storedStatus == "in_progress" {
			return nil, false, ErrConflict
		}
		// Return cached response
		var resp domain.TransferResponse
		if err := json.Unmarshal(storedBody, &resp); err != nil {
			return nil, false, err
		}
		resp.Replayed = true
		return &resp, true, nil // Commit is not needed for read-only return
	} else if err != pgx.ErrNoRows {
		return nil, false, err
	}

	// Insert "in_progress" marker
	_, err = tx.Exec(ctx,
		"INSERT INTO idempotency_keys (key, request_hash, status) VALUES ($1, $2, 'in_progress')",
		idempotencyKey, reqHash)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" { // Unique violation
			return nil, false, ErrConflict
		}
		return nil, false, err
	}

	// --- 2. DETERMINISTIC LOCKING ---
	// Sort IDs to prevent circular wait conditions
	first, second := req.FromAccountID, req.ToAccountID
	if first > second {
		first, second = second, first
	}

	// Acquire locks in ascending order
	// Use NOWAIT to fail fast during extreme contention scenarios (Hot-Spot)
	for _, id := range []int64{first, second} {
		var b int64
		if err := tx.QueryRow(ctx, "SELECT balance FROM accounts WHERE id = $1 FOR UPDATE NOWAIT", id).Scan(&b); err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "55P03" { // Lock not available
				return nil, false, ErrConflict
			}
			return nil, false, ErrAccountNotFound
		}
	}

	// --- 3. BUSINESS LOGIC & EXECUTION ---
	var fromBalance int64
	if err := tx.QueryRow(ctx, "SELECT balance FROM accounts WHERE id = $1", req.FromAccountID).Scan(&fromBalance); err != nil {
		return nil, false, err
	}
	if fromBalance < req.Amount {
		return nil, false, ErrFunds
	}

	// Create Transfer Record
	var transferID int64
	err = tx.QueryRow(ctx,
		"INSERT INTO transfers (from_account_id, to_account_id, amount, status) VALUES ($1, $2, $3, 'completed') RETURNING id",
		req.FromAccountID, req.ToAccountID, req.Amount).Scan(&transferID)
	if err != nil {
		return nil, false, err
	}

	// Create Double-Entry Ledger Records (Debit and Credit)
	// The DB trigger `check_ledger_invariant` will verify SUM(delta) == 0 at COMMIT time.
	_, err = tx.Exec(ctx,
		"INSERT INTO ledger_entries (transfer_id, account_id, delta) VALUES ($1, $2, $3), ($1, $4, $5)",
		transferID, req.FromAccountID, -req.Amount, req.ToAccountID, req.Amount)
	if err != nil {
		return nil, false, fmt.Errorf("invariant violation: %v", err)
	}

	// Update Balances
	_, err = tx.Exec(ctx, "UPDATE accounts SET balance = balance - $1 WHERE id = $2", req.Amount, req.FromAccountID)
	if err != nil {
		return nil, false, err
	}
	_, err = tx.Exec(ctx, "UPDATE accounts SET balance = balance + $1 WHERE id = $2", req.Amount, req.ToAccountID)
	if err != nil {
		return nil, false, err
	}

	// --- 4. FINALIZE ---
	resp, err := s.getTransferTx(ctx, tx, transferID)
	if err != nil {
		return nil, false, err
	}

	respBytes, _ := json.Marshal(resp)
	_, err = tx.Exec(ctx,
		"UPDATE idempotency_keys SET status = 'completed', transfer_id = $1, response_status = 201, response_body = $2 WHERE key = $3",
		transferID, respBytes, idempotencyKey)
	if err != nil {
		return nil, false, err
	}

	return resp, false, tx.Commit(ctx)
}

func (s *LedgerStore) CreateAccount(ctx context.Context, initialBalance int64) (int64, error) {
	var id int64
	err := s.db.QueryRow(ctx, "INSERT INTO accounts (balance) VALUES ($1) RETURNING id", initialBalance).Scan(&id)
	return id, err
}

func (s *LedgerStore) GetAccount(ctx context.Context, id int64) (*domain.Account, error) {
	var acc domain.Account
	err := s.db.QueryRow(ctx, "SELECT id, balance, created_at FROM accounts WHERE id = $1", id).Scan(&acc.ID, &acc.Balance, &acc.CreatedAt)
	if err == pgx.ErrNoRows {
		return nil, ErrAccountNotFound
	}
	return &acc, err
}

func (s *LedgerStore) ListAccounts(ctx context.Context) ([]domain.Account, error) {
	rows, err := s.db.Query(ctx, "SELECT id, balance, created_at FROM accounts ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	accounts := []domain.Account{}
	for rows.Next() {
		var acc domain.Account
		if err := rows.Scan(&acc.ID, &acc.Balance, &acc.CreatedAt); err != nil {
			return nil, err
		}
		accounts = append(accounts, acc)
	}
	return accounts, rows.Err()
}

func (s *LedgerStore) ListTransfers(ctx context.Context) ([]domain.Transfer, error) {
	rows, err := s.db.Query(ctx, "SELECT id, from_account_id, to_account_id, amount, status, created_at FROM transfers ORDER BY id DESC LIMIT 100")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	transfers := []domain.Transfer{}
	for rows.Next() {
		var t domain.Transfer
		if err := rows.Scan(&t.ID, &t.FromAccountID, &t.ToAccountID, &t.Amount, &t.Status, &t.CreatedAt); err != nil {
			return nil, err
		}
		transfers = append(transfers, t)
	}
	return transfers, rows.Err()
}

func (s *LedgerStore) GetTransfer(ctx context.Context, id int64) (*domain.TransferResponse, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	resp, err := s.getTransferTx(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	return resp, tx.Commit(ctx)
}

func (s *LedgerStore) getTransferTx(ctx context.Context, tx pgx.Tx, id int64) (*domain.TransferResponse, error) {
	var t domain.Transfer
	err := tx.QueryRow(ctx, "SELECT id, from_account_id, to_account_id, amount, status, created_at FROM transfers WHERE id = $1", id).
		Scan(&t.ID, &t.FromAccountID, &t.ToAccountID, &t.Amount, &t.Status, &t.CreatedAt)
	if err == pgx.ErrNoRows {
		return nil, ErrTransferNotFound
	}
	if err != nil {
		return nil, err
	}

	rows, err := tx.Query(ctx, "SELECT id, transfer_id, account_id, delta, created_at FROM ledger_entries WHERE transfer_id = $1 ORDER BY id", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	entries := []domain.LedgerEntry{}
	for rows.Next() {
		var entry domain.LedgerEntry
		if err := rows.Scan(&entry.ID, &entry.TransferID, &entry.AccountID, &entry.Delta, &entry.CreatedAt); err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return &domain.TransferResponse{Transfer: t, Entries: entries}, nil
}

func (s *LedgerStore) IntegrityReport(ctx context.Context) (*domain.IntegrityReport, error) {
	report := &domain.IntegrityReport{CheckedAt: time.Now().UTC()}

	if err := s.db.QueryRow(ctx, "SELECT COUNT(*) FROM accounts WHERE balance < 0").Scan(&report.NegativeBalances); err != nil {
		return nil, err
	}

	unbalanced, err := s.integrityIssues(ctx, "HAVING COALESCE(SUM(le.delta), 0) <> 0")
	if err != nil {
		return nil, err
	}
	report.UnbalancedTransfers = unbalanced

	malformed, err := s.integrityIssues(ctx, "HAVING COUNT(le.id) <> 2")
	if err != nil {
		return nil, err
	}
	report.MalformedTransfers = malformed

	report.OK = report.NegativeBalances == 0 && len(report.UnbalancedTransfers) == 0 && len(report.MalformedTransfers) == 0
	return report, nil
}

func (s *LedgerStore) integrityIssues(ctx context.Context, having string) ([]domain.TransferIntegrityIssue, error) {
	query := `
		SELECT t.id, COUNT(le.id), COALESCE(SUM(le.delta), 0)
		FROM transfers t
		LEFT JOIN ledger_entries le ON le.transfer_id = t.id
		GROUP BY t.id
		` + having + `
		ORDER BY t.id
		LIMIT 50`

	rows, err := s.db.Query(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	issues := []domain.TransferIntegrityIssue{}
	for rows.Next() {
		var issue domain.TransferIntegrityIssue
		if err := rows.Scan(&issue.TransferID, &issue.EntryCount, &issue.SumDelta); err != nil {
			return nil, err
		}
		issues = append(issues, issue)
	}
	return issues, rows.Err()
}

func (s *LedgerStore) ResetDemo(ctx context.Context) error {
	_, err := s.db.Exec(ctx, "TRUNCATE TABLE idempotency_keys, ledger_entries, transfers, accounts RESTART IDENTITY")
	return err
}

func (s *LedgerStore) SeedDemo(ctx context.Context) ([]domain.Account, error) {
	if err := s.ResetDemo(ctx); err != nil {
		return nil, err
	}

	balances := []int64{125000, 88000, 42000, 250000}
	for _, balance := range balances {
		if _, err := s.CreateAccount(ctx, balance); err != nil {
			return nil, err
		}
	}
	return s.ListAccounts(ctx)
}
