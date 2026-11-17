package harness

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"elysian/server/internal/agent/harness/sessionstore"
)

func TestSessionStoreErrorsAtHarnessBoundary(t *testing.T) {
	for _, test := range []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"missing", fmt.Errorf("读取失败：%w", sessionstore.ErrNotFound), 404, "not-found"},
		{"cancelled", context.Canceled, 408, "request-cancelled"},
		{"deadline", context.DeadlineExceeded, 408, "request-cancelled"},
		{"commit-unknown", &sessionstore.Fault{Kind: sessionstore.UnconfirmedCommit, Cause: context.Canceled}, 503, "storage-commit-unconfirmed"},
		{"read-unavailable", &sessionstore.Fault{Kind: sessionstore.ReadUnavailable, Cause: errors.New("存储读取失败"), Transient: true}, 503, "storage-unavailable"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var public *Error
			if err := storageFailure(test.err); !errors.As(err, &public) || public.Status != test.status || public.Code != test.code {
				t.Fatalf("错误映射=%+v，期望 %d %s", err, test.status, test.code)
			}
			if test.status == 404 && !isNotFound(test.err) {
				t.Fatal("未识别持久化端口的缺失记录语义")
			}
		})
	}
	public := bad("invalid-cursor", "原有校验响应")
	if storageFailure(public) != public {
		t.Fatal("改变了原有业务错误")
	}
}
