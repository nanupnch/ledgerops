package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gorilla/mux"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/punchamoorthee/ledgerops/internal/api"
	"github.com/punchamoorthee/ledgerops/internal/config"
	"github.com/punchamoorthee/ledgerops/internal/store"
)

func main() {
	// 1. Load Config
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// 2. Connect Database
	dbPool, err := pgxpool.New(context.Background(), cfg.DBSource)
	if err != nil {
		log.Fatalf("Unable to connect to database: %v", err)
	}
	defer dbPool.Close()

	if err := dbPool.Ping(context.Background()); err != nil {
		log.Fatalf("Database ping failed: %v", err)
	}
	log.Println("Connected to Database")

	// 3. Initialize Layers
	ledgerStore := store.NewLedgerStore(dbPool)
	handler := api.NewHandler(ledgerStore, cfg.Env)

	// 4. Setup Router
	r := mux.NewRouter()
	r.Use(loggingMiddleware)

	// Observability
	r.Handle("/metrics", promhttp.Handler())
	r.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	})

	// API V1
	v1 := r.PathPrefix("/api/v1").Subrouter()
	v1.HandleFunc("/accounts", handler.ListAccounts).Methods("GET")
	v1.HandleFunc("/accounts", handler.CreateAccount).Methods("POST")
	v1.HandleFunc("/accounts/{id}", handler.GetAccount).Methods("GET")
	v1.HandleFunc("/transfers", handler.ListTransfers).Methods("GET")
	v1.HandleFunc("/transfers", handler.CreateTransfer).Methods("POST")
	v1.HandleFunc("/transfers/{id}", handler.GetTransfer).Methods("GET")
	v1.HandleFunc("/integrity", handler.Integrity).Methods("GET")
	v1.HandleFunc("/demo/reset", handler.ResetDemo).Methods("POST")
	v1.HandleFunc("/demo/seed", handler.SeedDemo).Methods("POST")
	v1.HandleFunc("/demo/scenarios/hotspot", handler.HotspotScenario).Methods("POST")

	// 5. Start Server
	srv := &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: r,
	}

	go func() {
		log.Printf("Server starting on port %s", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Listen: %s\n", err)
		}
	}()

	// 6. Graceful Shutdown
	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt, syscall.SIGTERM)
	<-c

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	log.Println("Shutting down server...")
	srv.Shutdown(ctx)
}

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %v", r.Method, r.URL.Path, time.Since(start))
	})
}
