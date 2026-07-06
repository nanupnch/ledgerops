package domain

import (
	"encoding/json"
	"time"
)

// Account represents a user's balance in the ledger.
type Account struct {
	ID        int64     `json:"id"`
	Balance   int64     `json:"balance"`
	CreatedAt time.Time `json:"created_at"`
}

// TransferRequest is the DTO for incoming HTTP requests.
type TransferRequest struct {
	FromAccountID int64 `json:"from_account_id"`
	ToAccountID   int64 `json:"to_account_id"`
	Amount        int64 `json:"amount"`
}

// Transfer represents the intent to move money.
type Transfer struct {
	ID            int64     `json:"id"`
	FromAccountID int64     `json:"from_account_id"`
	ToAccountID   int64     `json:"to_account_id"`
	Amount        int64     `json:"amount"`
	Status        string    `json:"status"`
	CreatedAt     time.Time `json:"created_at"`
}

// LedgerEntry represents one leg of a double-entry transaction.
// The sum of Deltas for a given TransferID must always equal 0.
type LedgerEntry struct {
	ID         int64     `json:"id"`
	TransferID int64     `json:"transfer_id"`
	AccountID  int64     `json:"account_id"`
	Delta      int64     `json:"delta"`
	CreatedAt  time.Time `json:"created_at"`
}

// TransferResponse is the canonical response structure for 201/200 OK.
type TransferResponse struct {
	Transfer Transfer      `json:"transfer"`
	Entries  []LedgerEntry `json:"entries"`
	Replayed bool          `json:"replayed"`
}

// IdempotencyPayload stores the response state for exact-once delivery.
type IdempotencyPayload struct {
	Status         string          `json:"status"`
	ResponseBody   json.RawMessage `json:"response_body,omitempty"`
	ResponseStatus int             `json:"response_status,omitempty"`
}

type TransferIntegrityIssue struct {
	TransferID int64 `json:"transfer_id"`
	EntryCount int64 `json:"entry_count"`
	SumDelta   int64 `json:"sum_delta"`
}

type IntegrityReport struct {
	OK                  bool                     `json:"ok"`
	NegativeBalances    int64                    `json:"negative_balances"`
	UnbalancedTransfers []TransferIntegrityIssue `json:"unbalanced_transfers"`
	MalformedTransfers  []TransferIntegrityIssue `json:"malformed_transfers"`
	CheckedAt           time.Time                `json:"checked_at"`
}
