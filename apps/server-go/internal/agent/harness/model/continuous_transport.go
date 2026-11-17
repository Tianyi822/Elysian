package model

import (
	"context"
	"io"
	"net"
	"net/http"
	"sync"
	"time"
)

// A request has a bounded total lifetime and an independent raw-data idle timer.
// Repeated bytes count as activity; a slow but active response is not truncated.
func (c *httpClient) continuousClient() *httpClient {
	c.continuousOnce.Do(func() {
		client := *c.client
		client.Timeout = 30 * time.Minute
		transport := client.Transport
		if transport == nil {
			transport = http.DefaultTransport
		}
		if t, ok := transport.(*http.Transport); ok {
			copy := t.Clone()
			copy.DialContext = (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext
			copy.TLSHandshakeTimeout = 30 * time.Second
			copy.ResponseHeaderTimeout = 120 * time.Second
			transport = copy
		}
		client.Transport = idleTransport{base: transport, timeout: 120 * time.Second}
		c.continuous = &httpClient{client: &client}
	})
	return c.continuous
}

type idleTransport struct {
	base    http.RoundTripper
	timeout time.Duration
}

func (t idleTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	ctx, cancel := context.WithCancel(req.Context())
	body := &idleBody{cancel: cancel, timeout: t.timeout}
	body.timer = time.AfterFunc(t.timeout, cancel)
	response, err := t.base.RoundTrip(req.Clone(ctx))
	if err != nil {
		body.Close()
		return nil, err
	}
	body.body = response.Body
	response.Body = body
	return response, nil
}

type idleBody struct {
	mu      sync.Mutex
	body    io.ReadCloser
	timer   *time.Timer
	cancel  context.CancelFunc
	timeout time.Duration
	closed  bool
}

func (b *idleBody) Read(p []byte) (int, error) {
	n, err := b.body.Read(p)
	b.mu.Lock()
	if n > 0 && !b.closed {
		b.timer.Reset(b.timeout)
	}
	b.mu.Unlock()
	return n, err
}
func (b *idleBody) Close() error {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return nil
	}
	b.closed = true
	b.timer.Stop()
	b.cancel()
	body := b.body
	b.mu.Unlock()
	if body != nil {
		return body.Close()
	}
	return nil
}
