package harness

import (
	"context"
)

// Receipt settlement is evidenced by the atomic call/finished event, including
// legacy receipts with an empty body. Restart interruption emits no such event.
func operationReceiptSettled(ctx context.Context, q rowReader, runID, callID string) (bool, error) {
	var settled bool
	err := readView(ctx, q).OperationReceiptSettled(ctx, runID, callID, &settled)
	return settled, err
}
