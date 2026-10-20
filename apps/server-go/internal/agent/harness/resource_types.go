package harness

// ResourceClaim 的资源身份不包含规则修订；同一资源在配置更新后仍相互冲突。
type ResourceClaim struct {
	Kind      string `json:"kind"`
	Authority string `json:"authority"`
	Key       string `json:"key"`
	Access    string `json:"access"`
	Subtree   bool   `json:"subtree,omitempty"`
}

type ResourceSelector struct {
	Source        string      `json:"source"`
	Ref           RevisionRef `json:"ref"`
	OriginalName  string      `json:"originalName,omitempty"`
	CatalogDigest string      `json:"catalogDigest,omitempty"`
}

type ResourceMapping struct {
	Kind      string  `json:"kind"`
	Authority string  `json:"authority"`
	Access    string  `json:"access"`
	Subtree   bool    `json:"subtree,omitempty"`
	Literal   *string `json:"literal,omitempty"`
	Pointer   *string `json:"pointer,omitempty"`
}

type ResourceRuleInput struct {
	Name     string            `json:"name"`
	Enabled  bool              `json:"enabled"`
	Complete bool              `json:"complete"`
	Selector ResourceSelector  `json:"selector"`
	Mappings []ResourceMapping `json:"mappings"`
}

type ResourceRule struct {
	ResourceRuleInput
	ID        string `json:"id"`
	Revision  int    `json:"revision"`
	Digest    string `json:"digest"`
	CreatedAt string `json:"createdAt"`
}

type ResourceLease struct {
	Probe          *ProbeAccessRequest `json:"probe,omitempty"`
	Source         string              `json:"source,omitempty"`
	ServerID       string              `json:"serverId,omitempty"`
	ServerRevision int                 `json:"serverRevision,omitempty"`
	ContainerID    string              `json:"containerId,omitempty"`
	ID             string              `json:"id"`
	RunID          string              `json:"runId,omitempty"`
	OperationID    string              `json:"operationId,omitempty"`
	ScopeID        string              `json:"scopeId"`
	State          string              `json:"state"`
	Claims         []ResourceClaim     `json:"claims"`
	CreatedAt      string              `json:"createdAt"`
	EndedAt        string              `json:"endedAt,omitempty"`
	Evidence       string              `json:"evidence,omitempty"`
	Decision       string              `json:"decision,omitempty"`
}

const resourceSchema = `
CREATE TABLE IF NOT EXISTS resource_rules (
 id TEXT NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL,
 PRIMARY KEY(id,revision)
);
CREATE TABLE IF NOT EXISTS resource_leases (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 run_id TEXT NOT NULL DEFAULT '', operation_id TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL, document TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS resource_leases_state ON resource_leases(state,sequence);
CREATE INDEX IF NOT EXISTS resource_leases_run ON resource_leases(run_id);
`
