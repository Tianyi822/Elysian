package sqlite

import (
	"testing"
	"time"
)

func DefaultLimits() Limits {
	return Limits{
		Concurrency: 2, QueueCapacity: 32, MaxSteps: 16, InputBytes: 65536,
		CallTimeoutSeconds: 30, RunTimeoutSeconds: 300, ResultBytes: 262144,
		RunResultBytes: 2097152, LogBytes: 1048576, FrameBytes: 524288,
		RetentionDays: 30, CancelGraceSeconds: 5,
	}
}
func DefaultAgentLimits() Limits {
	l := DefaultLimits()
	l.RunTimeoutSeconds = 600
	l.MaxModelRequests = 16
	l.ModelTimeoutSeconds = 60
	l.OutputTokens = 0 // 未设置：按思考模式的官方默认取值
	// 单轮预算容纳一次 128K 输出与多轮思考请求，并低于工作流实例预算（256000），步骤超额仍由步骤预算先裁定。
	l.TokenBudget = 196608
	l.UserBytes = 32768
	l.MemoryBytes = 16384
	// 前端按图片独立压缩至 1 MiB，不限制张数，处理后的图片合计最多 8 MiB。
	l.ImageCountPerMessage = 0
	l.ImageBytesPerFile = 1048576
	l.ImageBytesPerMessage = maxImageAttachmentSetBytes
	// 校验后的响应上限覆盖 128K 档长回答的正文（含思考），原始流转上限由模型客户端按输出上限单独放大。
	l.ModelResponseBytes = 2097152
	return l
}
func runtimeEventually(t *testing.T, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !f() {
		if time.Now().After(deadline) {
			t.Fatal("等待状态超时")
		}
		time.Sleep(time.Millisecond)
	}
}
func awaitDeleteSignal(t *testing.T, c <-chan struct{}) {
	t.Helper()
	select {
	case <-c:
	case <-time.After(10 * time.Second):
		t.Fatal("等待信号超时")
	}
}
