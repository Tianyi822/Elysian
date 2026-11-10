package seam

import "context"

// AgentServiceContainerInput describes a container, not a domain operation.
type AgentServiceContainerInput struct {
	Name         string   `json:"name"`
	Image        string   `json:"image"`
	RequestID    string   `json:"requestId"`
	ResourceTier string   `json:"resourceTier"`
	NetworkScope string   `json:"networkScope"`
	Port         int      `json:"port"`
	HostPort     int      `json:"hostPort"`
	Credentials  []string `json:"credentials"`
	Env          []string `json:"env"`
	Volumes      []string `json:"volumes"`
}

type AgentDatabaseChange struct {
	Action           string `json:"action"`
	Name             string `json:"name"`
	ExpectedRevision string `json:"expectedRevision"`
	Charset          string `json:"charset,omitempty"`
}

type AgentDatabaseInspection struct {
	ID       string `json:"id"`
	Metadata bool   `json:"metadata,omitempty"`
	Metrics  bool   `json:"metrics,omitempty"`
}

// AgentDatabaseContainers is injected by app. Preparation has no effects;
// returned functions execute only after the caller persists its task identity.
// No credentials cross this boundary.
type AgentDatabaseContainers interface {
	PrepareCreate(context.Context, AgentServiceContainerInput, string) (func(context.Context) (any, error), bool, error)
	PrepareChange(context.Context, string, string, AgentDatabaseChange) (func(context.Context) (any, error), error)
	Inspect(context.Context, string, *AgentDatabaseInspection) (any, error)
	Lifecycle(context.Context, string, string) (bool, error)
	Registered(context.Context, string) (bool, error)
}

// ContainerOperationGuard checks pending and unknown operations before a domain
// mutation. Only the accepted worker may exclude its own immutable request ID.
type ContainerOperationGuard func(ctx context.Context, containerID, containerName, ownRequestID string) error

// AgentContainerError carries only reviewed local error text across domains.
type AgentContainerError struct {
	Code          string
	Message       string
	NotDispatched bool
	// NoBusinessEffect means an accepted task failed before its first mutation.
	NoBusinessEffect bool
}

func (e *AgentContainerError) Error() string { return e.Message }
