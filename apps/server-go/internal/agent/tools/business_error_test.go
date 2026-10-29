package tools

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestBusinessErrorDoesNotHideAdditionalFailures(t *testing.T) {
	business := &BusinessError{Code: "invalid-version", Message: "请选择明确版本"}
	for _, test := range []struct {
		name string
		err  error
		want bool
	}{
		{"直接业务错误", business, true},
		{"单一包装", fmt.Errorf("调用：%w", business), true},
		{"单一合并", errors.Join(business), true},
		{"清理失败", errors.Join(business, errors.New("清理失败")), false},
		{"嵌套清理失败", fmt.Errorf("作用域：%w", errors.Join(business, errors.New("清理失败"))), false},
		{"取消", errors.Join(business, context.Canceled), false},
		{"超时", errors.Join(business, context.DeadlineExceeded), false},
		{"策略拒绝", errors.Join(business, &DeniedError{Name: "test", Reason: "不允许"}), false},
		{"普通错误", errors.New("域原始秘密"), false},
		{"缺少错误码", &BusinessError{Message: "无效"}, false},
		{"空错误", nil, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, ok := AsBusinessError(test.err)
			if ok != test.want || ok && got != business {
				t.Fatalf("业务错误分类不符：%+v %v", got, ok)
			}
		})
	}
}
