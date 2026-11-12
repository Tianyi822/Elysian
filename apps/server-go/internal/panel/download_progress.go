package panel

import (
	"context"
	"io"
	"time"
)

type downloadProgressKey struct{}
type downloadReporter func(DownloadProgress) error

// 回调由下载器同步调用；worker 独占执行锁，进度与事务字段共用同一份记录。
func withDownloadProgress(ctx context.Context, report downloadReporter) context.Context {
	return context.WithValue(ctx, downloadProgressKey{}, report)
}

type releaseProgressWriter struct {
	writer        io.Writer
	report        downloadReporter
	value         DownloadProgress
	started, last time.Time
}

func (p *releaseProgressWriter) publish(status string, force bool) error {
	now := time.Now()
	if !force && now.Sub(p.last) < time.Second {
		return nil
	}
	p.value.Status = status
	p.value.UpdatedAt = now.UTC()
	if elapsed := now.Sub(p.started).Seconds(); elapsed > 0 {
		p.value.BytesPerSecond = int64(float64(p.value.CompletedBytes) / elapsed)
	}
	if status != "downloading" {
		p.value.BytesPerSecond = 0
	}
	p.last = now
	if p.report != nil {
		return p.report(p.value)
	}
	return nil
}

func (p *releaseProgressWriter) Write(data []byte) (int, error) {
	n, err := p.writer.Write(data)
	p.value.CompletedBytes += int64(n)
	if p.value.CompletedBytes > p.value.TotalBytes {
		p.value.CompletedBytes = p.value.TotalBytes
	}
	if err == nil {
		err = p.publish("downloading", false)
	}
	return n, err
}

type downloadActivityReader struct {
	io.Reader
	timer *time.Timer
}

func (r downloadActivityReader) Read(data []byte) (int, error) {
	n, err := r.Reader.Read(data)
	if n > 0 {
		r.timer.Reset(releaseDownloadIdleTimeout)
	}
	return n, err
}
