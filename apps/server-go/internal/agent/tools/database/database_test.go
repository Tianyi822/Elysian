package database

import (
	"errors"
	"testing"

	"elysian/server/internal/agent/tools"
	domain "elysian/server/internal/database"
)

// lifecycleBusinessError 的映射契约：预检拒绝声明未派发、执行中失败不声明、
// 组合错误原样上抛不洗白。
func TestLifecycleBusinessErrorMapping(t *testing.T) {
	rejected := lifecycleBusinessError(&domain.AgentLifecycleRejectedError{Message: "仅允许操作面板受管数据库"})
	business, ok := rejected.(*tools.BusinessError)
	if !ok || business.Code != "database-lifecycle-rejected" || business.Message != "仅允许操作面板受管数据库" || !business.NotDispatched {
		t.Fatalf("预检拒绝应映射为未派发业务错误：%v", rejected)
	}
	failed := lifecycleBusinessError(&domain.AgentLifecycleError{Code: "database-lifecycle-failed", Message: "数据库持久卷身份核对失败"})
	business, ok = failed.(*tools.BusinessError)
	if !ok || business.Code != "database-lifecycle-failed" || business.Message != "数据库持久卷身份核对失败" || business.NotDispatched {
		t.Fatalf("执行失败不得声明未派发：%v", failed)
	}
	plain := errors.New("SECRET_INTERNAL")
	if mapped := lifecycleBusinessError(plain); !errors.Is(mapped, plain) {
		t.Fatalf("未知错误必须原样上抛：%v", mapped)
	}
	joined := errors.Join(&domain.AgentLifecycleError{Code: "database-lifecycle-failed", Message: "固定文案"}, errors.New("清理失败"))
	if _, ok := lifecycleBusinessError(joined).(*tools.BusinessError); ok {
		t.Fatal("组合错误不得被洗白成业务错误")
	}
}
