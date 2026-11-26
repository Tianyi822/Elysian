package seam

import (
	"context"

	"elysian/server/internal/contract"
)

type ContainerFirewall interface {
	Allow(ctx context.Context, binding contract.DockerPublishedPort) (state, detail string)
	Reconcile(ctx context.Context) error
	Transfer(oldID, nextID string, bindings []contract.DockerPublishedPort) error
}
