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

// AgentDatabaseContainers is injected by app. The database logical-DB protocol
// surface has been retired; the bridge only routes managed database container
// lifecycle (start/stop/restart/remove) and exec interception. No credentials
// cross this boundary.
type AgentDatabaseContainers interface {
	Lifecycle(context.Context, string, string) (bool, error)
	Registered(context.Context, string) (bool, error)
}

// AgentWebsiteContainers is injected by app. The websites package owns registry
// verification and in-progress mutual exclusion; Lifecycle reports whether the
// container belongs to a registered website project and runs the action.
type AgentWebsiteContainers interface {
	Lifecycle(context.Context, string, string) (bool, error)
	Registered(context.Context, string) (bool, error)
}

// ContainerOperationGuard checks pending and unknown operations before a domain
// mutation. Only the accepted worker may exclude its own immutable request ID.
type ContainerOperationGuard func(ctx context.Context, containerID, containerName, ownRequestID string) error

// ContainerMutationLease reserves a canonical target until its caller completes the mutation.
type ContainerMutationLease func(ctx context.Context, containerID, containerName string) (release func(), err error)

// AgentContainerError carries only reviewed local error text across domains.
type AgentContainerError struct {
	Code          string
	Message       string
	NotDispatched bool
	// NoBusinessEffect means the accepted task left no business change: it either
	// failed before its first mutation or rolled back and the rollback was verified.
	NoBusinessEffect bool
}

func (e *AgentContainerError) Error() string { return e.Message }
