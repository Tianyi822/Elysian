package panel

import (
	"context"
	"elysian/server/internal/config"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestPreflightBudgetSharesOneAllowance(t *testing.T) {
	budget := preflightBudgetState{remaining: 3 * time.Minute}
	for index, elapsed := range []time.Duration{time.Minute, 90 * time.Second} {
		if !budget.consume(elapsed) {
			t.Fatalf("check %d exhausted the budget too early", index)
		}
	}
	if budget.remaining != 30*time.Second {
		t.Fatalf("checks did not share one allowance: %v", budget.remaining)
	}
	if budget.consume(30*time.Second) || budget.remaining != 0 || budget.consume(time.Millisecond) {
		t.Fatalf("an exhausted allowance must not be renewed: %v", budget.remaining)
	}
}

func TestPreflightBudgetExcludesTimeBetweenChecks(t *testing.T) {
	budget := preflightBudgetState{remaining: 60 * time.Millisecond}
	if !budget.consume(10 * time.Millisecond) {
		t.Fatal("first check unexpectedly exhausted the budget")
	}
	// A build may take longer than the remaining allowance without consuming it.
	time.Sleep(75 * time.Millisecond)
	calls := 0
	host := &lifecycleHost{preflight: func(ctx context.Context, _, _ config.PanelNetwork) error {
		calls++
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > 50*time.Millisecond || ctx.Err() != nil {
			t.Fatalf("next check did not receive the remaining allowance: %v", deadline)
		}
		return nil
	}}
	w := Worker{Host: host}
	if err := w.preflight(context.Background(), config.PanelNetwork{}, config.PanelNetwork{}, &budget); err != nil || calls != 1 {
		t.Fatalf("time outside preflight consumed the allowance: %v, calls=%d", err, calls)
	}
}

func TestPreflightBudgetExpiryStopsFurtherChecks(t *testing.T) {
	for _, ignoresCancellation := range []bool{false, true} {
		t.Run(map[bool]string{false: "context-error", true: "late-success"}[ignoresCancellation], func(t *testing.T) {
			budget := preflightBudgetState{remaining: 10 * time.Millisecond}
			calls := 0
			host := &lifecycleHost{preflight: func(ctx context.Context, _, _ config.PanelNetwork) error {
				calls++
				<-ctx.Done()
				if ignoresCancellation {
					return nil
				}
				return ctx.Err()
			}}
			w := Worker{Host: host}
			for attempt := 0; attempt < 2; attempt++ {
				err := w.preflight(context.Background(), config.PanelNetwork{}, config.PanelNetwork{}, &budget)
				if !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "累计总预算已耗尽") {
					t.Fatalf("exhaustion did not return an explicit deadline error: %v", err)
				}
			}
			if calls != 1 || budget.remaining != 0 {
				t.Fatalf("an exhausted budget dispatched another check: calls=%d, remaining=%v", calls, budget.remaining)
			}
		})
	}
}

func TestPreflightPreservesHostFailureAndParentCancellation(t *testing.T) {
	hostFailure := errors.New("host preflight failed")
	for _, expected := range []error{hostFailure, context.Canceled} {
		budget := preflightBudgetState{remaining: time.Minute}
		ctx, cancel := context.WithCancel(context.Background())
		if expected == context.Canceled {
			cancel()
		}
		host := &lifecycleHost{preflight: func(context.Context, config.PanelNetwork, config.PanelNetwork) error {
			return expected
		}}
		w := Worker{Host: host}
		err := w.preflight(ctx, config.PanelNetwork{}, config.PanelNetwork{}, &budget)
		cancel()
		if !errors.Is(err, expected) || budget.remaining <= 0 {
			t.Fatalf("host failure or cancellation was replaced by budget exhaustion: %v, remaining=%v", err, budget.remaining)
		}
	}
}
