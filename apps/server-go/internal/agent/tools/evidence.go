package tools

// ExecutionEvidence is host-owned evidence, never a claim inferred from an
// error string or an external tool's isError flag. Empty fields mean unknown.
type ExecutionEvidence struct {
	Execution  string `json:"execution,omitempty"` // not-started | finished | unknown
	Changes    string `json:"changes,omitempty"`   // none | confirmed | unknown
	Recovery   string `json:"recovery,omitempty"`  // correct | retry | verify | stop
	Stage      string `json:"stage,omitempty"`
	Suggestion string `json:"suggestion,omitempty"`
}

// TaskVerification binds a read-only verification to the original dispatch.
// A verifier may durably fence an unaccepted request, but may never replay it.
type TaskVerification struct {
	OperationID   string
	DispatchID    string
	Task          TaskReference
	Tool          string
	ArgumentsJSON string
}
