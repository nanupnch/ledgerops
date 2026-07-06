package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

// Config holds the benchmark settings
var (
	targetURL   string
	concurrency int
	duration    time.Duration
	workload    string
)

// Metrics
var (
	totalRequests uint64
	success200    uint64 // Idempotent replays
	success201    uint64 // Created
	fail409       uint64 // Conflicts (Aborts)
	failOther     uint64
)

func init() {
	flag.StringVar(&targetURL, "url", "http://localhost:8080", "API Base URL")
	flag.IntVar(&concurrency, "workers", 10, "Number of concurrent workers")
	flag.DurationVar(&duration, "duration", 30*time.Second, "Test duration")
	flag.StringVar(&workload, "workload", "uniform", "Workload type: uniform | hotspot")
}

func main() {
	flag.Parse()
	log.Printf("Starting Benchmark: %s | Workers: %d | Duration: %s", workload, concurrency, duration)

	start := time.Now()
	var wg sync.WaitGroup
	wg.Add(concurrency)

	for i := 0; i < concurrency; i++ {
		go worker(&wg, start)
	}

	wg.Wait()
	printResults(time.Since(start))
}

func worker(wg *sync.WaitGroup, start time.Time) {
	defer wg.Done()
	client := &http.Client{Timeout: 5 * time.Second}

	for time.Since(start) < duration {
		from, to := generateAccounts()
		amount := int64(100)
		// Generate a unique idempotency key for each benchmark request.
		key := fmt.Sprintf("bench-%d-%d-%d", from, to, time.Now().UnixNano())

		payload := map[string]interface{}{
			"from_account_id": from,
			"to_account_id":   to,
			"amount":          amount,
		}
		body, _ := json.Marshal(payload)

		req, _ := http.NewRequest("POST", targetURL+"/api/v1/transfers", bytes.NewBuffer(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", key)

		resp, err := client.Do(req)
		if err != nil {
			atomic.AddUint64(&failOther, 1)
			continue
		}

		atomic.AddUint64(&totalRequests, 1)
		switch resp.StatusCode {
		case 201:
			atomic.AddUint64(&success201, 1)
		case 200:
			atomic.AddUint64(&success200, 1)
		case 409:
			atomic.AddUint64(&fail409, 1)
		default:
			atomic.AddUint64(&failOther, 1)
		}
		resp.Body.Close()
	}
}

func generateAccounts() (int64, int64) {
	// Assumes 1000 accounts seeded (IDs 1-1000)
	totalAccounts := 1000

	if workload == "hotspot" {
		// Hotspot: 90% of traffic goes to Account 1 & 2
		if rand.Float32() < 0.90 {
			if rand.Float32() < 0.5 {
				return 1, 2
			}
			return 2, 1
		}
	}

	// Uniform Random
	a := rand.Intn(totalAccounts) + 1
	b := rand.Intn(totalAccounts) + 1
	for a == b {
		b = rand.Intn(totalAccounts) + 1
	}
	return int64(a), int64(b)
}

func printResults(d time.Duration) {
	total := atomic.LoadUint64(&totalRequests)
	s201 := atomic.LoadUint64(&success201)
	s200 := atomic.LoadUint64(&success200)
	f409 := atomic.LoadUint64(&fail409)
	fErr := atomic.LoadUint64(&failOther)

	tps := float64(total) / d.Seconds()
	abortRate := float64(f409) / float64(total) * 100

	results := map[string]interface{}{
		"workload":        workload,
		"duration_sec":    d.Seconds(),
		"total_requests":  total,
		"throughput_tps":  tps,
		"success_created": s201,
		"success_replay":  s200,
		"aborts_conflict": f409,
		"abort_rate_pct":  abortRate,
		"errors":          fErr,
	}

	// Print JSON for the python plotter to consume
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	enc.Encode(results)

	// Also save to file
	filename := fmt.Sprintf("results_%s.json", workload)
	file, _ := os.Create(filename)
	defer file.Close()
	json.NewEncoder(file).Encode(results)
}
