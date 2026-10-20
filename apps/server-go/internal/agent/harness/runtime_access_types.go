package harness

import (
	"context"
	execconfig "elysian/server/internal/agent/execution/config"
)

// FileRootIdentity is supplied by the injected file-domain seam and rechecked at dispatch.
type FileRootIdentity struct {
	Path     string `json:"path"`
	Writable bool   `json:"writable"`
	Device   uint64 `json:"device"`
	Inode    uint64 `json:"inode"`
}

const AuthorizationOnDemand = "on-demand"

type runtimeAccessContextKey struct{}

func runtimeAccessEnabled(ctx context.Context) bool {
	enabled, _ := ctx.Value(runtimeAccessContextKey{}).(bool)
	return enabled
}

// AccessRequest is a proposal owned by the harness, never authority supplied by a model.
type AccessRequest struct {
	Revision       int                          `json:"revision"`
	Digest         string                       `json:"digest"`
	ScopeKey       string                       `json:"scopeKey"`
	Kind           string                       `json:"kind"`
	Directories    []execconfig.Directory       `json:"directories"`
	Network        []execconfig.NetworkEndpoint `json:"network"`
	PrivateCIDRs   []string                     `json:"privateCidrs"`
	Resources      []execconfig.Resource        `json:"resources"`
	Runtime        *AccessRuntime               `json:"runtime,omitempty"`
	SessionAllowed bool                         `json:"sessionAllowed"`
	Reason         string                       `json:"reason,omitempty"`
}
type AccessRuntime struct {
	Name             string `json:"name"`
	Image            string `json:"image"`
	Platform         string `json:"platform"`
	RequiresDownload bool   `json:"requiresDownload"`
}
type AccessDecision struct {
	RequestID        string `json:"requestId"`
	ExpectedRevision int    `json:"expectedRevision"`
	ExpectedDigest   string `json:"expectedDigest"`
	Decision         string `json:"decision"`
}
type OperationAuthorization struct {
	ID                     string `json:"id"`
	Digest                 string `json:"digest"`
	Decision               string `json:"decision"`
	SessionAuthorizationID string `json:"sessionAuthorizationId,omitempty"`
	CreatedAt              string `json:"createdAt"`
}
type SessionAuthorization struct {
	ExecutionProfile *execconfig.Profile `json:"executionProfile,omitempty"`
	ID               string              `json:"id"`
	SessionID        string              `json:"sessionId"`
	Revision         int                 `json:"revision"`
	Status           string              `json:"status"`
	CreatedAt        string              `json:"createdAt"`
	RevokedAt        string              `json:"revokedAt,omitempty"`
	RevokeRequestID  string              `json:"revokeRequestId,omitempty"`
	Tool             string              `json:"tool"`
	Access           AccessRequest       `json:"access"`
}
type RevokeAuthorizationInput struct {
	RequestID        string `json:"requestId"`
	ExpectedRevision int    `json:"expectedRevision"`
}

const sessionAuthorizationSchema = `CREATE TABLE session_authorizations (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 scope_key TEXT NOT NULL, state TEXT NOT NULL, document TEXT NOT NULL);
 CREATE INDEX session_authorization_scope ON session_authorizations(session_id,scope_key,state);`
