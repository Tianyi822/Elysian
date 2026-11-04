package docker

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

var pullIdleError = errors.New("Docker 连续 120 秒未返回镜像拉取数据，请检查 Docker 服务与所选镜像源后重试")

// pullStream 在收到错误行时关闭 Engine 请求，不依赖上游主动结束响应。
// 活动计时使用原始数据块，去重后的进度不能作为网络仍活跃的依据。
func (s *dockerService) pullStream(ctx context.Context, fromImage string, onProgress func(imagePullProgress)) error {
	return s.pullStreamMode(ctx, fromImage, onProgress, false)
}

// Agent 等待完整错误响应正常结束；主动断流不能证明 Engine 已停止。
func (s *dockerService) pullStreamMode(ctx context.Context, fromImage string, onProgress func(imagePullProgress), confirmFailure bool) error {
	streamCtx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	watchdog := newPullIdleWatchdog(s.deps.pullIdleTimeout, cancel)
	defer watchdog.stop()
	decoder := newPullProgressDecoder(onProgress)
	received := false
	var engineFailure *pullEngineError
	var finishTimer *time.Timer
	defer func() {
		if finishTimer != nil {
			finishTimer.Stop()
		}
	}()
	response, err := s.deps.transport.Stream(streamCtx, seam.EngineRequest{
		Method: http.MethodPost, Path: "/images/create",
		Query: url.Values{"fromImage": {fromImage}}, Timeout: pullTimeout, MaxBytes: pullProgressMaxBytes,
	}, func(chunk []byte) {
		if len(chunk) == 0 || streamCtx.Err() != nil {
			return
		}
		received = true
		watchdog.touch()
		if engineFailure != nil {
			return
		}
		if decodeErr := decoder.feed(chunk); decodeErr != nil {
			if failure, ok := decodeErr.(*pullEngineError); confirmFailure && ok {
				engineFailure = failure
				finishTimer = time.AfterFunc(2*time.Second, func() { cancel(errors.New("Engine 失败响应未正常结束")) })
			} else {
				cancel(shared.InvalidRequest(decodeErr.Error()))
			}
		}
	})
	watchdog.stop()
	if cause := context.Cause(streamCtx); cause != nil {
		if errors.Is(cause, context.DeadlineExceeded) {
			return errors.New("镜像拉取请求超时，请刷新镜像列表核实结果")
		}
		if errors.Is(cause, context.Canceled) {
			return errors.New("拉取已取消")
		}
		return cause
	}
	if err != nil {
		return err
	}
	if response.Status != http.StatusOK {
		if confirmFailure && response.Status >= 400 && response.Status <= 599 {
			return confirmedPullError(errors.New("Engine 已完整返回拉取失败"))
		}
		value, _ := decodeOrderedJSON(response.Body)
		return fmt.Errorf("拉取镜像失败（HTTP %d）：%s", response.Status, engineErrorMessage(value, "Docker 未返回具体原因"))
	}
	if engineFailure != nil {
		return confirmedPullError(engineFailure)
	}
	// 没有分块回调的传输器仍按相同规则检查完整正文。
	if !received {
		if !confirmFailure {
			if err := readPullProgress(response.Body); err != nil {
				return shared.InvalidRequest(err.Error())
			}
		}
		if err := decoder.feed(response.Body); err != nil {
			if _, ok := err.(*pullEngineError); confirmFailure && ok {
				return confirmedPullError(err)
			}
			return shared.InvalidRequest(err.Error())
		}
	}
	if err := decoder.finish(); err != nil {
		if _, ok := err.(*pullEngineError); confirmFailure && ok {
			return confirmedPullError(err)
		}
		return shared.InvalidRequest(err.Error())
	}
	return nil
}

type pullIdleWatchdog struct {
	mu       sync.Mutex
	timer    *time.Timer
	lastData time.Time
	timeout  time.Duration
	stopped  bool
	cancel   context.CancelCauseFunc
}

func newPullIdleWatchdog(timeout time.Duration, cancel context.CancelCauseFunc) *pullIdleWatchdog {
	w := &pullIdleWatchdog{lastData: time.Now(), timeout: timeout, cancel: cancel}
	w.mu.Lock()
	w.timer = time.AfterFunc(timeout, w.expire)
	w.mu.Unlock()
	return w
}

func (w *pullIdleWatchdog) expire() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stopped {
		return
	}
	remaining := w.timeout - time.Since(w.lastData)
	if remaining > 0 {
		w.timer.Reset(remaining)
		return
	}
	w.cancel(pullIdleError)
}

func (w *pullIdleWatchdog) touch() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.lastData = time.Now()
}

func (w *pullIdleWatchdog) stop() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.stopped = true
	w.timer.Stop()
}
