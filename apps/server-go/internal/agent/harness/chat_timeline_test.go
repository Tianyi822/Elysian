package harness

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
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
		prompt, completion, total, cached := 15, 5, 20, 5
		usage := model.Usage{PromptTokens: &prompt, CompletionTokens: &completion, TotalTokens: &total, CachedTokens: &cached}
		if r.ToolChoice == "store_working_memory" {
			response := memoryReply(r)
			response.Content, response.Reasoning = "内部正文", "内部整理"
			response.Usage = usage
			return response, nil
		}
		count++
		response := finalReply("终答")
		if count < 3 {
			response = toolReply("docker_containers_list", "docker_images_list")
			response.Content = fmt.Sprintf("正文%d", count)
		}
		response.Reasoning = fmt.Sprintf("思考%d", count)
		response.Usage = usage
		return response, nil
	}, nil)
	run := submitAgentTest(t, m, session, "timeline", "查询")
	finished := runtimeFinished(t, m, run.ID)
	if finished.Status != StateSucceeded {
		t.Fatalf("run failed: %+v", finished)
	}
	profile := *finished.Model
	if _, err := m.UpdateModelProfile(profile.ID, profile.Revision, model.Input{Provider: profile.Provider, APIFormat: profile.APIFormat, BaseURL: profile.BaseURL, Model: "updated-model", ContextTokens: 131072, OutputTokens: profile.OutputTokens, Capabilities: profile.Capabilities, Active: true}); err != nil {
		t.Fatal(err)
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
	if timeline.Usage.ModelRequests != 4 || timeline.Usage.ActualTokens == nil || *timeline.Usage.ActualTokens != 80 || timeline.Usage.CachedTokens == nil || *timeline.Usage.CachedTokens != 20 {
		t.Fatalf("run usage missing from timeline: %+v", timeline.Usage)
	}
	if timeline.ContextUsage == nil || timeline.ContextUsage.ModelRequestID != timeline.FinalResponseID || timeline.ContextUsage.Model != profile.Model || timeline.ContextUsage.ContextTokens != profile.ContextTokens || timeline.ContextUsage.TotalTokens == nil || *timeline.ContextUsage.TotalTokens != 20 {
		t.Fatalf("latest inference or fixed model missing from timeline: %+v", timeline.ContextUsage)
	}
	if timeline.CacheHitUsage == nil || timeline.CacheHitUsage.InputTokens != 60 || timeline.CacheHitUsage.CachedTokens != 20 {
		t.Fatalf("input-weighted cache usage missing from timeline: %+v", timeline.CacheHitUsage)
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

func TestChatTimelineIncludesRunUsage(t *testing.T) {
	actual, cached := 1200, 800
	usage := Usage{Calls: 2, ResultBytes: 16, ModelRequests: 3, Tokens: 1200, EstimatedTokens: 2000, ActualTokens: &actual, CachedTokens: &cached}
	for _, status := range []string{StateRunning, StateSucceeded, StateFailed, StateCancelled, StateInterrupted} {
		t.Run(status, func(t *testing.T) {
			timeline := projectChatTimeline(Run{ID: "r", Status: status, Usage: usage}, nil, nil, nil, nil)
			if !reflect.DeepEqual(timeline.Usage, usage) || timeline.Done != terminal(status) {
				t.Fatalf("wrong usage snapshot: %+v", timeline)
			}
		})
	}
}

func TestChatTimelineContextUsageSelectsLatestConfirmedInference(t *testing.T) {
	first, latest, internal := 100, 40, 900
	response := func(total *int) *model.Response { return &model.Response{Usage: model.Usage{TotalTokens: total}} }
	modelSnapshot := &model.Profile{Model: "fixed-model", ContextTokens: 65536}
	records := []ModelRequestRecord{
		{ID: "latest", Index: 4, Purpose: "inference", Status: StateSucceeded, Response: response(&latest)},
		{ID: "checkpoint", Index: 5, Purpose: "checkpoint", Status: StateSucceeded, Response: response(&internal)},
		{ID: "final-memory", Index: 6, Purpose: "final-memory", Status: StateSucceeded, Response: response(&internal)},
		{ID: "running", Index: 7, Purpose: "inference", Status: StateRunning, Response: response(&internal)},
		{ID: "failed", Index: 8, Purpose: "inference", Status: StateFailed, Response: response(&internal)},
		{ID: "missing-response", Index: 9, Purpose: "inference", Status: StateSucceeded},
		{ID: "first", Index: 0, Purpose: "inference", Status: StateSucceeded, Response: response(&first)},
	}
	for _, status := range []string{StateRunning, StateSucceeded, StateFailed, StateCancelled, StateInterrupted} {
		t.Run(status, func(t *testing.T) {
			timeline := projectChatTimeline(Run{ID: "r", Status: status, Model: modelSnapshot, Usage: Usage{ActualTokens: &internal}}, records, nil, nil, nil)
			contextUsage := timeline.ContextUsage
			if contextUsage == nil || contextUsage.ModelRequestID != "latest" || contextUsage.Model != "fixed-model" || contextUsage.ContextTokens != 65536 || contextUsage.TotalTokens == nil || *contextUsage.TotalTokens != latest {
				t.Fatalf("wrong confirmed inference: %+v", contextUsage)
			}
		})
	}
	withoutModel := projectChatTimeline(Run{ID: "r", Status: StateSucceeded}, records, nil, nil, nil)
	if withoutModel.ContextUsage != nil {
		t.Fatalf("missing model snapshot became known: %+v", withoutModel.ContextUsage)
	}
	withoutInference := projectChatTimeline(Run{ID: "r", Status: StateRunning, Model: modelSnapshot}, records[1:6], nil, nil, nil)
	if withoutInference.ContextUsage != nil {
		t.Fatalf("internal or unconfirmed request became context usage: %+v", withoutInference.ContextUsage)
	}
}

func TestChatTimelineContextUsagePreservesReportedAndUnknownTotals(t *testing.T) {
	zero, prompt, completion, total, sum, negative, max := 0, 10, 5, 20, 15, -1, math.MaxInt
	for _, tc := range []struct {
		name     string
		usage    model.Usage
		expected *int
	}{
		{name: "reported-total", usage: model.Usage{TotalTokens: &total, PromptTokens: &prompt, CompletionTokens: &completion}, expected: &total},
		{name: "reported-zero", usage: model.Usage{TotalTokens: &zero, PromptTokens: &prompt, CompletionTokens: &completion}, expected: &zero},
		{name: "sum-input-and-output", usage: model.Usage{PromptTokens: &prompt, CompletionTokens: &completion}, expected: &sum},
		{name: "sum-zero", usage: model.Usage{PromptTokens: &zero, CompletionTokens: &zero}, expected: &zero},
		{name: "unknown", usage: model.Usage{}},
		{name: "prompt-only", usage: model.Usage{PromptTokens: &prompt}},
		{name: "completion-only", usage: model.Usage{CompletionTokens: &completion}},
		{name: "negative-total", usage: model.Usage{TotalTokens: &negative}},
		{name: "negative-input", usage: model.Usage{PromptTokens: &negative, CompletionTokens: &completion}},
		{name: "sum-overflow", usage: model.Usage{PromptTokens: &max, CompletionTokens: &completion}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			previousTotal := 200
			records := []ModelRequestRecord{
				{ID: "previous", Index: 0, Purpose: "inference", Status: StateSucceeded, Response: &model.Response{Usage: model.Usage{TotalTokens: &previousTotal}}},
				{ID: "latest", Index: 1, Purpose: "inference", Status: StateSucceeded, Response: &model.Response{Usage: tc.usage}},
			}
			timeline := projectChatTimeline(Run{ID: "r", Status: StateSucceeded, Model: &model.Profile{Model: "fixed-model", ContextTokens: 0}}, records, nil, nil, nil)
			contextUsage := timeline.ContextUsage
			if contextUsage == nil || contextUsage.ModelRequestID != "latest" || contextUsage.ContextTokens != 0 || !reflect.DeepEqual(contextUsage.TotalTokens, tc.expected) {
				t.Fatalf("wrong latest usage: %+v", contextUsage)
			}
			data, err := json.Marshal(contextUsage)
			if err != nil {
				t.Fatal(err)
			}
			var wire map[string]json.RawMessage
			if err := json.Unmarshal(data, &wire); err != nil {
				t.Fatal(err)
			}
			_, present := wire["totalTokens"]
			if present != (tc.expected != nil) || string(wire["contextTokens"]) != "0" {
				t.Fatalf("unknown or explicit zero collapsed: %s", data)
			}
		})
	}
}

func TestChatTimelineUsagePreservesUnknownAndReportedZero(t *testing.T) {
	zero := 0
	for _, reported := range []bool{false, true} {
		t.Run(map[bool]string{false: "unknown", true: "reported-zero"}[reported], func(t *testing.T) {
			usage := Usage{ModelRequests: 1, Tokens: 20, EstimatedTokens: 30}
			if reported {
				usage.ActualTokens, usage.CachedTokens = &zero, &zero
			}
			timeline := projectChatTimeline(Run{ID: "r", Status: StateSucceeded, Usage: usage}, nil, nil, nil, nil)
			data, err := json.Marshal(timeline)
			if err != nil {
				t.Fatal(err)
			}
			var wire struct {
				Usage map[string]json.RawMessage `json:"usage"`
			}
			if err := json.Unmarshal(data, &wire); err != nil {
				t.Fatal(err)
			}
			if wire.Usage == nil || string(wire.Usage["tokens"]) != "20" || string(wire.Usage["estimatedTokens"]) != "30" {
				t.Fatalf("usage missing from wire: %s", data)
			}
			for _, key := range []string{"actualTokens", "cachedTokens"} {
				value, present := wire.Usage[key]
				if present != reported || (reported && string(value) != "0") {
					t.Fatalf("unknown and zero usage collapsed: %s", data)
				}
			}
		})
	}
}

func TestChatTimelineContextUsageJavaScriptIntegerBounds(t *testing.T) {
	maxSafeValue := int64(1<<53 - 1)
	if int64(math.MaxInt) <= maxSafeValue {
		t.Skip("native int cannot exceed JavaScript safe integers")
	}
	maxSafe, aboveSafe, beforeSafe, one, five := int(maxSafeValue), int(maxSafeValue+1), int(maxSafeValue-5), 1, 5
	for _, tc := range []struct {
		name     string
		usage    model.Usage
		expected *int
	}{
		{name: "reported-limit", usage: model.Usage{TotalTokens: &maxSafe}, expected: &maxSafe},
		{name: "reported-over-limit", usage: model.Usage{TotalTokens: &aboveSafe, PromptTokens: &one, CompletionTokens: &one}},
		{name: "sum-limit", usage: model.Usage{PromptTokens: &beforeSafe, CompletionTokens: &five}, expected: &maxSafe},
		{name: "sum-over-limit", usage: model.Usage{PromptTokens: &maxSafe, CompletionTokens: &one}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			contextUsage := projectChatContextUsage(Run{Model: &model.Profile{Model: "fixed-model", ContextTokens: 65536}}, []ModelRequestRecord{{ID: "latest", Purpose: "inference", Status: StateSucceeded, Response: &model.Response{Usage: tc.usage}}})
			if contextUsage == nil || contextUsage.ModelRequestID != "latest" || contextUsage.Model != "fixed-model" || contextUsage.ContextTokens != 65536 || !reflect.DeepEqual(contextUsage.TotalTokens, tc.expected) {
				t.Fatalf("unsafe total or lost latest request: %+v", contextUsage)
			}
			data, err := json.Marshal(contextUsage)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(data), `"totalTokens":`) != (tc.expected != nil) {
				t.Fatalf("unsafe total should remain unknown: %s", data)
			}
		})
	}
}

func TestChatTimelineCacheHitUsageWeightsAllCompletedRequests(t *testing.T) {
	firstInput, firstCached, secondInput, secondCached := 10, 10, 90, 0
	checkpointInput, checkpointCached, finalInput, finalCached := 100, 25, 200, 100
	records := []ModelRequestRecord{
		{ID: "first", Purpose: "inference", Status: StateSucceeded, Response: &model.Response{Usage: model.Usage{PromptTokens: &firstInput, CachedTokens: &firstCached}}},
		{ID: "second", Purpose: "inference", Status: StateSucceeded, Response: &model.Response{Usage: model.Usage{PromptTokens: &secondInput, CachedTokens: &secondCached}}},
		{ID: "checkpoint", Purpose: "checkpoint", Status: StateSucceeded, Response: &model.Response{Usage: model.Usage{PromptTokens: &checkpointInput, CachedTokens: &checkpointCached}}},
		{ID: "final", Purpose: "final-memory", Status: StateSucceeded, Response: &model.Response{Usage: model.Usage{PromptTokens: &finalInput, CachedTokens: &finalCached}}},
		{ID: "pending", Purpose: "inference", Status: StateRunning},
		{ID: "queued", Purpose: "inference", Status: StateQueued},
	}
	timeline := projectChatTimeline(Run{ID: "r", Status: StateRunning}, records, nil, nil, nil)
	if !reflect.DeepEqual(timeline.CacheHitUsage, &ChatCacheHitUsage{InputTokens: 400, CachedTokens: 135}) {
		t.Fatalf("wrong input-weighted cache usage: %+v", timeline.CacheHitUsage)
	}
}

func TestChatTimelineCacheHitUsageUnknownAndExplicitZero(t *testing.T) {
	zero, one, input, cached, negative := 0, 1, 10, 5, -1
	known := ModelRequestRecord{Status: StateSucceeded, Response: &model.Response{Usage: model.Usage{PromptTokens: &input, CachedTokens: &cached}}}
	for _, tc := range []struct {
		name     string
		records  []ModelRequestRecord
		expected *ChatCacheHitUsage
	}{
		{name: "no-requests"},
		{name: "pending-only", records: []ModelRequestRecord{{Status: StateRunning}}},
		{name: "missing-response", records: []ModelRequestRecord{known, {Status: StateSucceeded}}},
		{name: "missing-input", records: []ModelRequestRecord{known, {Status: StateSucceeded, Response: &model.Response{Usage: model.Usage{CachedTokens: &zero}}}}},
		{name: "missing-cache", records: []ModelRequestRecord{known, {Status: StateSucceeded, Response: &model.Response{Usage: model.Usage{PromptTokens: &input}}}}},
		{name: "failed", records: []ModelRequestRecord{known, {Status: StateFailed, Response: known.Response}}},
		{name: "cancelled", records: []ModelRequestRecord{known, {Status: StateCancelled, Response: known.Response}}},
		{name: "interrupted", records: []ModelRequestRecord{known, {Status: StateInterrupted, Response: known.Response}}},
		{name: "negative-input", records: []ModelRequestRecord{known, {Status: StateSucceeded, Response: &model.Response{Usage: model.Usage{PromptTokens: &negative, CachedTokens: &zero}}}}},
		{name: "negative-cache", records: []ModelRequestRecord{known, {Status: StateSucceeded, Response: &model.Response{Usage: model.Usage{PromptTokens: &input, CachedTokens: &negative}}}}},
		{name: "cache-exceeds-input", records: []ModelRequestRecord{known, {Status: StateSucceeded, Response: &model.Response{Usage: model.Usage{PromptTokens: &zero, CachedTokens: &one}}}}},
		{name: "reported-zero", records: []ModelRequestRecord{{Status: StateSucceeded, Response: &model.Response{Usage: model.Usage{PromptTokens: &zero, CachedTokens: &zero}}}}, expected: &ChatCacheHitUsage{}},
		{name: "zero-cache", records: []ModelRequestRecord{{Status: StateSucceeded, Response: &model.Response{Usage: model.Usage{PromptTokens: &input, CachedTokens: &zero}}}}, expected: &ChatCacheHitUsage{InputTokens: input}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			timeline := projectChatTimeline(Run{ID: "r", Status: StateSucceeded}, tc.records, nil, nil, nil)
			if !reflect.DeepEqual(timeline.CacheHitUsage, tc.expected) {
				t.Fatalf("wrong cache reporting completeness: %+v", timeline.CacheHitUsage)
			}
			data, err := json.Marshal(timeline)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(data), `"cacheHitUsage":`) != (tc.expected != nil) {
				t.Fatalf("unknown cache usage should be omitted: %s", data)
			}
		})
	}
}

func TestChatTimelineCacheHitUsageIntegerBounds(t *testing.T) {
	limitValue := int64(1<<53 - 1)
	if int64(math.MaxInt) < limitValue {
		limitValue = int64(math.MaxInt)
	}
	limit, one, zero := int(limitValue), 1, 0
	request := func(input, cached *int) ModelRequestRecord {
		return ModelRequestRecord{Status: StateSucceeded, Response: &model.Response{Usage: model.Usage{PromptTokens: input, CachedTokens: cached}}}
	}
	if usage := projectChatCacheHitUsage([]ModelRequestRecord{request(&limit, &limit)}); !reflect.DeepEqual(usage, &ChatCacheHitUsage{InputTokens: limit, CachedTokens: limit}) {
		t.Fatalf("safe boundary was discarded: %+v", usage)
	}
	if usage := projectChatCacheHitUsage([]ModelRequestRecord{request(&limit, &zero), request(&one, &zero)}); usage != nil {
		t.Fatalf("unsafe aggregate became known: %+v", usage)
	}
	if int64(math.MaxInt) > limitValue {
		above := int(limitValue + 1)
		if usage := projectChatCacheHitUsage([]ModelRequestRecord{request(&above, &zero)}); usage != nil {
			t.Fatalf("unsafe request became known: %+v", usage)
		}
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
