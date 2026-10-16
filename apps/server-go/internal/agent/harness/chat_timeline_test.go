package harness

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
)

func TestChatTimelineRetainsThreeInferencesAndToolContent(t *testing.T) {
	count := 0
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			response := memoryReply(r)
			response.Content, response.Reasoning = "内部正文", "内部整理"
			return response, nil
		}
		count++
		response := finalReply("终答")
		if count < 3 {
			response = toolReply("docker_containers_list", "docker_images_list")
			response.Content = fmt.Sprintf("正文%d", count)
		}
		response.Reasoning = fmt.Sprintf("思考%d", count)
		return response, nil
	}, nil)
	run := submitAgentTest(t, m, session, "timeline", "查询")
	if finished := runtimeFinished(t, m, run.ID); finished.Status != StateSucceeded {
		t.Fatalf("run failed: %+v", finished)
	}
	output, err := m.ChatSnapshot(context.Background(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	timeline := output.Timeline
	wantKinds := []string{"reasoning", "content", "tool", "tool", "reasoning", "content", "tool", "tool", "reasoning", "content"}
	var kinds []string
	ids := map[string]bool{}
	for _, entry := range timeline.Entries {
		kinds = append(kinds, entry.Kind)
		if ids[entry.ID] || strings.Contains(entry.Text, "内部") {
			t.Fatalf("duplicate or internal entry: %+v", entry)
		}
		ids[entry.ID] = true
		if entry.Kind == "tool" && (entry.Status != StateSucceeded || entry.CallID == "" || entry.ArgumentsJSON != "{}") {
			t.Fatalf("tool receipt not linked: %+v", entry)
		}
	}
	if !reflect.DeepEqual(kinds, wantKinds) || !timeline.Done || timeline.FinalResponseID != timeline.Entries[9].ModelRequestID {
		t.Fatalf("wrong chronology: %+v", timeline)
	}
	// 独立读取端点从原始记录重建相同顺序，且不夹带工具结果。
	rec := httptest.NewRecorder()
	m.Router().ServeHTTP(rec, httptest.NewRequest("GET", "/runs/"+run.ID+"/timeline", nil))
	var restored ChatTimelineSnapshot
	if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &restored) != nil || !reflect.DeepEqual(restored, *timeline) {
		t.Fatalf("timeline route: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), `"result":`) {
		t.Fatal("tool results leaked into snapshot")
	}
}

func TestChatTimelineToolStatesAndIncompleteText(t *testing.T) {
	statuses := []string{"planned", StateWaitingApproval, StateWaitingResource, StateWaitingTask, "dispatched", "unknown", "completed"}
	for _, status := range statuses {
		t.Run(status, func(t *testing.T) {
			record := ModelRequestRecord{ID: "m", Purpose: "inference", Status: StateSucceeded, Response: &model.Response{ToolCalls: []model.ToolCall{{ID: "p", Name: "test", Arguments: json.RawMessage(`{"n":9007199254740993}`)}}}}
			op := Operation{ID: "o", ModelRequestID: "m", ModelCallID: "p", Status: status, ApprovalID: "a"}
			timeline := projectChatTimeline(Run{ID: "r", Status: StateInterrupted}, []ModelRequestRecord{record}, []Operation{op}, nil, nil)
			want := "not-executed"
			if status == StateWaitingTask {
				want = StateWaitingTask
			} else if status == "dispatched" || status == "unknown" || status == "completed" {
				want = "unknown"
			}
			if got := timeline.Entries[0]; got.Status != want || got.ArgumentsJSON != `{"n":9007199254740993}` {
				t.Fatal(got)
			}
			for _, decision := range []string{"denied", "expired", "revoked"} {
				out := projectChatTimeline(Run{ID: "r", Status: StateFailed}, []ModelRequestRecord{record}, []Operation{op}, nil, []Approval{{ID: "a", Status: decision}})
				if out.Entries[0].Status != decision {
					t.Fatal(out)
				}
			}
		})
	}
	for _, status := range []string{StateFailed, StateCancelled, StateInterrupted} {
		timeline := projectChatTimeline(Run{ID: "r", Status: status}, []ModelRequestRecord{{ID: "m", Purpose: "inference", Status: status, Reasoning: "部分思考", Content: "部分正文"}}, nil, nil, nil)
		if !timeline.Done || len(timeline.Entries) != 2 || !timeline.Entries[1].Incomplete || timeline.Entries[1].Text != "部分正文" {
			t.Fatal(timeline)
		}
	}
}

func TestChatTimelineRetainsConfirmedTimeoutAndCancellation(t *testing.T) {
	for _, cancel := range []bool{false, true} {
		t.Run(map[bool]string{false: "timeout", true: "cancelled"}[cancel], func(t *testing.T) {
			emitted, resume := make(chan struct{}), make(chan struct{})
			var once sync.Once
			release := func() { once.Do(func() { close(resume) }) }
			defer release()
			m, session, _ := agentManager(t, func(ctx context.Context, _ model.Profile, r model.Request) (model.Response, error) {
				r.OnReasoning("保留的思考")
				r.OnContent("保留的正文")
				close(emitted)
				select {
				case <-ctx.Done():
					return model.Response{}, ctx.Err()
				case <-resume:
					return model.Response{}, context.DeadlineExceeded
				}
			}, nil)
			run := submitAgentTest(t, m, session, "partial-timeline", "查询")
			select {
			case <-emitted:
			case <-time.After(5 * time.Second):
				t.Fatal("未收到模型增量")
			}
			wantStatus := StateFailed
			if cancel {
				wantStatus = StateCancelled
				if _, err := m.Cancel(context.Background(), run.ID); err != nil {
					t.Fatal(err)
				}
			} else {
				release()
			}
			if finished := runtimeFinished(t, m, run.ID); finished.Status != wantStatus {
				t.Fatalf("未确认终态：%+v", finished)
			}
			output, err := m.ChatSnapshot(context.Background(), run.ID)
			if err != nil {
				t.Fatal(err)
			}
			entries := output.Timeline.Entries
			if len(entries) != 2 || entries[0].Text != "保留的思考" || entries[1].Text != "保留的正文" || !entries[1].Incomplete || entries[1].Status != wantStatus || !output.Timeline.Done {
				t.Fatalf("未恢复完整片段：%+v", output.Timeline)
			}
		})
	}
}
