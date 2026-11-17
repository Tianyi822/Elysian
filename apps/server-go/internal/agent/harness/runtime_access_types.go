package harness

import (
	"context"
)

const AuthorizationOnDemand = "on-demand"

type runtimeAccessContextKey struct{}

func runtimeAccessEnabled(ctx context.Context) bool {
	enabled, _ := ctx.Value(runtimeAccessContextKey{}).(bool)
	return enabled
}
