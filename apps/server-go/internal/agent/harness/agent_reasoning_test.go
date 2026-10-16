package harness

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
)

func TestAgentReasoningSnapshotAndConfirmedPersistence(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "成功", true: "失败"}[fail], func(t *testing.T) {
			emitted, resume := make(chan struct{}), make(chan struct{})
			var release sync.Once
			defer release.Do(func() { close(resume) })
			m, s, _ := agentManager(t, func(ctx context.Context, _ model.Profile, r model.Request) (model.Response, error) {
				if r.ToolChoice == "store_working_memory" {
					if r.OnReasoning != nil || r.OnContent != nil {
						t.Error("整理不应开启思考展示")
					}
					response := memoryReply(r)
					response.Reasoning = "不公开的整理过程"
					return response, nil
				}
				if r.OnReasoning == nil || r.OnContent == nil {
					return model.Response{}, errors.New("缺少思考展示回调")
				}
				r.OnReasoning("检查\n")
				r.OnReasoning("容器状态")
				r.OnContent("正在生成的回答")
				close(emitted)
				select {
				case <-resume:
				case <-ctx.Done():
					return model.Response{}, ctx.Err()
				}
				if fail {
					return model.Response{}, errors.New("测试失败")
				}
				response := finalReply("完成")
				response.Reasoning = "检查\n容器状态"
				return response, nil
			}, nil)
			run := submitAgentTest(t, m, s, "reasoning", "说明可用能力")
			select {
			case <-emitted:
			case <-time.After(5 * time.Second):
				t.Fatal("未产生思考增量")
			}
			page, err := m.ModelRequests(context.Background(), run.ID, "", 50)
			if err != nil || len(page.Items) != 1 || page.Items[0].Reasoning != "检查\n容器状态" || page.Items[0].Content != "正在生成的回答" || page.Items[0].Status != StateRunning || page.Items[0].Response != nil {
				t.Fatalf("生成中的快照错误：%+v %v", page, err)
			}
			m.mu.Lock()
			stored, err := m.store.modelRequests(context.Background(), run.ID, "", 50)
			m.mu.Unlock()
			if err != nil || len(stored.Items) != 1 || stored.Items[0].Reasoning != "" || stored.Items[0].Content != "" {
				t.Fatal("未确认的增量不应落盘")
			}
			release.Do(func() { close(resume) })
			finished := runtimeFinished(t, m, run.ID)
			page, err = m.ModelRequests(context.Background(), run.ID, "", 50)
			if err != nil || len(page.Items) == 0 {
				t.Fatal("请求记录缺失", err)
			}
			if fail {
				if finished.Status != StateFailed || page.Items[0].Response != nil || page.Items[0].Reasoning != "检查\n容器状态" || page.Items[0].Content != "正在生成的回答" {
					t.Fatal("失败后未保留未完成片段")
				}
			} else {
				if finished.Status != StateSucceeded || page.Items[0].Response == nil || page.Items[0].Response.Reasoning != "检查\n容器状态" || page.Items[0].Reasoning != "" || page.Items[0].Content != "" {
					t.Fatalf("最终思考未保存：%+v", page.Items[0])
				}
				for _, item := range page.Items {
					if item.Purpose != "inference" && item.Response != nil && strings.Contains(item.Response.Reasoning, "整理") {
						t.Fatal("整理内容进入公开记录")
					}
				}
			}
		})
	}
}
