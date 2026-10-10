package mcp

import (
	"context"
	"strconv"
)

type scopeContextKey struct{}

// WithScope gives one harness operation its own stdio connection generation.
// It does not change the server identity used for grants or revocation.
func WithScope(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, scopeContextKey{}, id)
}

// Scope identifies the execution container when opening a stdio transport.
// Harness operations and administrator probes both use a durable unique scope.
func Scope(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	id, _ := ctx.Value(scopeContextKey{}).(string)
	return id
}

func scopedConnectionKey(ctx context.Context, id string, revision int) string {
	key := id + ":" + strconv.Itoa(revision)
	if scope := Scope(ctx); scope != "" {
		key += ":scope:" + scope
	}
	return key
}

func connectionKey(ctx context.Context, s Server) string {
	if s.Stdio != nil {
		return scopedConnectionKey(ctx, s.ID, s.Revision)
	}
	return s.ID + ":" + strconv.Itoa(s.Revision)
}

// StdioIdentity returns only the observed container identity for this scope.
// The durable scope also identifies startup failures before a pipe is returned.
func (c *Client) StdioIdentity(ctx context.Context, server string, revision int) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if conn := c.connections[scopedConnectionKey(ctx, server, revision)]; conn != nil && conn.server.Stdio != nil {
		return conn.id
	}
	return ""
}
