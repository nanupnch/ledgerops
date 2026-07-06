package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/mux"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/punchamoorthee/ledgerops/internal/domain"
	"github.com/punchamoorthee/ledgerops/internal/store"
)

// Prometheus Metrics
var (
	httpReqTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "ledger_http_requests_total",
		Help: "Total HTTP requests classified by status",
	}, []string{"method", "endpoint", "status"})

	httpLatency = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "ledger_http_request_duration_seconds",
		Help:    "Request latency distribution",
		Buckets: []float64{0.005, 0.01, 0.05, 0.1, 0.5, 1},
	}, []string{"method", "endpoint"})
)

type Handler struct {
	store *store.LedgerStore
	env   string
}

func NewHandler(s *store.LedgerStore, env string) *Handler {
	return &Handler{store: s, env: env}
}

func (h *Handler) CreateTransfer(w http.ResponseWriter, r *http.Request) {
	timer := prometheus.NewTimer(httpLatency.WithLabelValues("POST", "/transfers"))
	defer timer.ObserveDuration()

	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		h.respondError(w, http.StatusBadRequest, "Missing Idempotency-Key header", "POST", "/transfers")
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		h.respondError(w, http.StatusInternalServerError, "Failed to read body", "POST", "/transfers")
		return
	}

	reqHash := requestHash(body)

	// Re-populate body for decoder
	r.Body = io.NopCloser(bytes.NewBuffer(body))

	var req domain.TransferRequest
	if err := json.Unmarshal(body, &req); err != nil {
		h.respondError(w, http.StatusBadRequest, "Invalid JSON", "POST", "/transfers")
		return
	}

	if req.Amount <= 0 {
		h.respondError(w, http.StatusUnprocessableEntity, "Amount must be positive", "POST", "/transfers")
		return
	}
	if req.FromAccountID == req.ToAccountID {
		h.respondError(w, http.StatusUnprocessableEntity, "Cannot transfer to self", "POST", "/transfers")
		return
	}

	resp, replayed, err := h.store.ExecTransfer(r.Context(), req, idemKey, reqHash)
	if err != nil {
		h.respondTransferError(w, err, "POST", "/transfers")
		return
	}

	w.Header().Set("Location", fmt.Sprintf("/transfers/%d", resp.Transfer.ID))
	status := http.StatusCreated
	if replayed {
		status = http.StatusOK
	}
	h.respondJSON(w, status, resp, "POST", "/transfers")
}

func (h *Handler) CreateAccount(w http.ResponseWriter, r *http.Request) {
	type req struct {
		InitialBalance int64 `json:"initial_balance"`
	}
	var p req
	json.NewDecoder(r.Body).Decode(&p)

	id, err := h.store.CreateAccount(r.Context(), p.InitialBalance)
	if err != nil {
		h.respondError(w, http.StatusInternalServerError, err.Error(), "POST", "/accounts")
		return
	}
	h.respondJSON(w, http.StatusCreated, map[string]int64{"id": id}, "POST", "/accounts")
}

func (h *Handler) ListAccounts(w http.ResponseWriter, r *http.Request) {
	accounts, err := h.store.ListAccounts(r.Context())
	if err != nil {
		h.respondError(w, http.StatusInternalServerError, err.Error(), "GET", "/accounts")
		return
	}
	h.respondJSON(w, http.StatusOK, accounts, "GET", "/accounts")
}

func (h *Handler) GetAccount(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	id, _ := strconv.ParseInt(vars["id"], 10, 64)

	acc, err := h.store.GetAccount(r.Context(), id)
	if err != nil {
		if err == store.ErrAccountNotFound {
			h.respondError(w, http.StatusNotFound, "Account not found", "GET", "/accounts")
			return
		}
		h.respondError(w, http.StatusInternalServerError, err.Error(), "GET", "/accounts")
		return
	}
	h.respondJSON(w, http.StatusOK, acc, "GET", "/accounts")
}

func (h *Handler) ListTransfers(w http.ResponseWriter, r *http.Request) {
	transfers, err := h.store.ListTransfers(r.Context())
	if err != nil {
		h.respondError(w, http.StatusInternalServerError, err.Error(), "GET", "/transfers")
		return
	}
	h.respondJSON(w, http.StatusOK, transfers, "GET", "/transfers")
}

func (h *Handler) GetTransfer(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	id, _ := strconv.ParseInt(vars["id"], 10, 64)

	transfer, err := h.store.GetTransfer(r.Context(), id)
	if err != nil {
		if err == store.ErrTransferNotFound {
			h.respondError(w, http.StatusNotFound, "Transfer not found", "GET", "/transfers/{id}")
			return
		}
		h.respondError(w, http.StatusInternalServerError, err.Error(), "GET", "/transfers/{id}")
		return
	}
	h.respondJSON(w, http.StatusOK, transfer, "GET", "/transfers/{id}")
}

func (h *Handler) Integrity(w http.ResponseWriter, r *http.Request) {
	report, err := h.store.IntegrityReport(r.Context())
	if err != nil {
		h.respondError(w, http.StatusInternalServerError, err.Error(), "GET", "/integrity")
		return
	}
	h.respondJSON(w, http.StatusOK, report, "GET", "/integrity")
}

func (h *Handler) ResetDemo(w http.ResponseWriter, r *http.Request) {
	if !h.demoMutationAllowed() {
		h.respondError(w, http.StatusForbidden, "Demo mutation endpoints are only available in development or demo", "POST", "/demo/reset")
		return
	}
	if err := h.store.ResetDemo(r.Context()); err != nil {
		h.respondError(w, http.StatusInternalServerError, err.Error(), "POST", "/demo/reset")
		return
	}
	h.respondJSON(w, http.StatusOK, map[string]string{"status": "reset"}, "POST", "/demo/reset")
}

func (h *Handler) SeedDemo(w http.ResponseWriter, r *http.Request) {
	if !h.demoMutationAllowed() {
		h.respondError(w, http.StatusForbidden, "Demo mutation endpoints are only available in development or demo", "POST", "/demo/seed")
		return
	}
	accounts, err := h.store.SeedDemo(r.Context())
	if err != nil {
		h.respondError(w, http.StatusInternalServerError, err.Error(), "POST", "/demo/seed")
		return
	}
	h.respondJSON(w, http.StatusOK, map[string]interface{}{"status": "seeded", "accounts": accounts}, "POST", "/demo/seed")
}

type scenarioRequest struct {
	Count  int   `json:"count"`
	Amount int64 `json:"amount"`
}

type scenarioResult struct {
	RequestID      string `json:"request_id"`
	IdempotencyKey string `json:"idempotency_key"`
	Status         string `json:"status"`
	HTTPStatus     int    `json:"http_status"`
	TransferID     int64  `json:"transfer_id,omitempty"`
	FromAccountID  int64  `json:"from_account_id"`
	ToAccountID    int64  `json:"to_account_id"`
	Amount         int64  `json:"amount"`
	DurationMS     int64  `json:"duration_ms"`
	Error          string `json:"error,omitempty"`
}

func (h *Handler) HotspotScenario(w http.ResponseWriter, r *http.Request) {
	if !h.demoMutationAllowed() {
		h.respondError(w, http.StatusForbidden, "Demo mutation endpoints are only available in development or demo", "POST", "/demo/scenarios/hotspot")
		return
	}

	var p scenarioRequest
	_ = json.NewDecoder(r.Body).Decode(&p)
	if p.Count <= 0 || p.Count > 80 {
		p.Count = 32
	}
	if p.Amount <= 0 {
		p.Amount = 100
	}

	accounts, err := h.store.ListAccounts(r.Context())
	if err != nil {
		h.respondError(w, http.StatusInternalServerError, err.Error(), "POST", "/demo/scenarios/hotspot")
		return
	}
	if len(accounts) < 2 {
		accounts, err = h.store.SeedDemo(r.Context())
		if err != nil {
			h.respondError(w, http.StatusInternalServerError, err.Error(), "POST", "/demo/scenarios/hotspot")
			return
		}
	}

	fromID := accounts[0].ID
	toID := accounts[1].ID
	results := make([]scenarioResult, p.Count)
	var wg sync.WaitGroup
	started := time.Now().UnixNano()

	for i := 0; i < p.Count; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			result := scenarioResult{
				RequestID:      fmt.Sprintf("hot-%02d", i+1),
				IdempotencyKey: fmt.Sprintf("demo-hotspot-%d-%02d", started, i+1),
				Status:         "created",
				HTTPStatus:     http.StatusCreated,
				FromAccountID:  fromID,
				ToAccountID:    toID,
				Amount:         p.Amount,
			}

			if i%2 == 1 {
				result.FromAccountID = toID
				result.ToAccountID = fromID
			}

			req := domain.TransferRequest{FromAccountID: result.FromAccountID, ToAccountID: result.ToAccountID, Amount: p.Amount}
			body, _ := json.Marshal(req)
			start := time.Now()
			resp, replayed, err := h.store.ExecTransfer(r.Context(), req, result.IdempotencyKey, requestHash(body))
			result.DurationMS = time.Since(start).Milliseconds()
			if replayed {
				result.Status = "replayed"
				result.HTTPStatus = http.StatusOK
			}
			if err != nil {
				result.Status, result.HTTPStatus = statusForTransferError(err)
				result.Error = err.Error()
			} else {
				result.TransferID = resp.Transfer.ID
			}
			results[i] = result
		}(i)
	}
	wg.Wait()

	counts := map[string]int{"created": 0, "replayed": 0, "conflict": 0, "failed": 0}
	for _, result := range results {
		counts[result.Status]++
	}

	h.respondJSON(w, http.StatusOK, map[string]interface{}{"results": results, "counts": counts}, "POST", "/demo/scenarios/hotspot")
}

func (h *Handler) demoMutationAllowed() bool {
	return h.env == "development" || h.env == "demo"
}

func requestHash(body []byte) string {
	hash := sha256.Sum256(body)
	return hex.EncodeToString(hash[:])
}

func (h *Handler) respondTransferError(w http.ResponseWriter, err error, method, endpoint string) {
	label, status := statusForTransferError(err)
	switch {
	case errors.Is(err, store.ErrConflict):
		h.respondError(w, status, "Request in progress or lock contention", method, endpoint)
	case errors.Is(err, store.ErrAccountNotFound):
		h.respondError(w, status, "Account not found", method, endpoint)
	case errors.Is(err, store.ErrKeyMismatch):
		h.respondError(w, status, "Idempotency key reused with different payload", method, endpoint)
	case errors.Is(err, store.ErrFunds):
		h.respondError(w, status, "Insufficient funds", method, endpoint)
	default:
		if label == "failed" {
			h.respondError(w, status, err.Error(), method, endpoint)
			return
		}
		h.respondError(w, http.StatusInternalServerError, err.Error(), method, endpoint)
	}
}

func statusForTransferError(err error) (string, int) {
	switch {
	case errors.Is(err, store.ErrConflict):
		return "conflict", http.StatusConflict
	case errors.Is(err, store.ErrAccountNotFound):
		return "failed", http.StatusNotFound
	case errors.Is(err, store.ErrKeyMismatch), errors.Is(err, store.ErrFunds):
		return "failed", http.StatusUnprocessableEntity
	default:
		return "failed", http.StatusInternalServerError
	}
}

func (h *Handler) respondJSON(w http.ResponseWriter, code int, payload interface{}, method, endpoint string) {
	httpReqTotal.WithLabelValues(method, endpoint, strconv.Itoa(code)).Inc()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(payload)
}

func (h *Handler) respondError(w http.ResponseWriter, code int, msg, method, endpoint string) {
	h.respondJSON(w, code, map[string]string{"error": msg}, method, endpoint)
}
