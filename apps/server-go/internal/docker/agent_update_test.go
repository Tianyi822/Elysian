package docker

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

func TestAgentUpdateVerifiesReadbackAndPreservesUnknownBarrier(t *testing.T) {
	for _, verified := range []bool{true, false} {
		t.Run(map[bool]string{true: "verified", false: "unknown"}[verified], func(t *testing.T) {
			var dispatched atomic.Bool
			engine := newFakeEngine(func(call engineCall) (int, string, bool) {
				switch {
				case strings.HasSuffix(call.Path, "/json"):
					return 200, hostScopeInspect(hostScopeID, nil, func(row map[string]any) {
						host := row["HostConfig"].(map[string]any)
						host["PidsLimit"] = 64
						if dispatched.Load() {
							host["RestartPolicy"] = map[string]any{"Name": "on-failure", "MaximumRetryCount": 3}
							if verified {
								host["PidsLimit"] = -1
							}
						}
					}), true
				case call.Method == http.MethodPost && strings.HasSuffix(call.Path, "/update"):
					if !dispatched.CompareAndSwap(false, true) || call.Body != `{"PidsLimit":-1,"RestartPolicy":{"MaximumRetryCount":3,"Name":"on-failure"}}` {
						t.Errorf("unexpected write: %s", call.Body)
					}
					return 200, `{"Warnings":["raw Engine warning must not escape"]}`, true
				default:
					return 0, "", false
				}
			})
			f := facadeWithEngine(t, engine)
			policy, maxRetries, pids := "on-failure", 3, 0
			input := ContainerUpdateInput{ID: hostScopeID, RequestID: strings.Repeat("c", 64), RestartPolicy: &policy, RestartMaxRetries: &maxRetries, PIDsLimit: &pids}
			task, err := f.SubmitUpdate(t.Context(), input)
			if err != nil {
				t.Fatal(err)
			}
			got := awaitContainerTask(t, f, task.ID)
			if !verified {
				if got.State != "unknown" || got.ErrorCode != "docker-container-update-unknown" || f.CheckContainerMutation(t.Context(), input.ID, "", "") == nil {
					t.Fatalf("unverified update lost its barrier: %+v", got)
				}
				if _, err := f.service.actionWithGuard(t.Context(), input.ID, "stop", f.CheckContainerMutation); err == nil {
					t.Fatal("Web action bypassed the unresolved update")
				}
			} else {
				var result containerUpdateResult
				if got.State != "succeeded" || json.Unmarshal(got.Result, &result) != nil || result.WarningCount != 1 ||
					result.Changes["pidsLimit"].To != float64(0) || result.Changes["restartPolicy"].To != "on-failure" ||
					result.Changes["restartMaxRetries"].To != float64(3) || strings.Contains(string(got.Result), "raw Engine warning") {
					t.Fatalf("incorrect readback receipt: %+v %s", got, got.Result)
				}
			}
			if prior, err := f.SubmitUpdate(t.Context(), input); err != nil || prior.ID != task.ID {
				t.Fatalf("request identity changed across retry: %+v %v", prior, err)
			}
			input.RestartMaxRetries = nil
			if _, err := f.SubmitUpdate(t.Context(), input); err == nil {
				t.Fatal("request ID reused with altered parameters")
			}
			posts := 0
			for _, call := range engine.Requests() {
				if call.Method == http.MethodPost {
					posts++
				}
			}
			if posts != 1 {
				t.Fatalf("expected one write, got %d", posts)
			}
		})
	}
}

func TestAgentUpdateZeroAndTemplateLimits(t *testing.T) {
	zero, tight, loose := 0, 256, 768
	userLimited, _ := decodeOrderedJSON([]byte(hostScopeInspect(hostScopeID, nil, func(row map[string]any) {
		host := row["HostConfig"].(map[string]any)
		host["Memory"] = 512 * mib
		host["NanoCpus"] = 1_000_000_000
	})))
	userUnlimited, _ := decodeOrderedJSON([]byte(hostScopeInspect(hostScopeID, nil, nil)))
	template, _ := decodeOrderedJSON([]byte(hostScopeInspect(hostScopeID, map[string]string{"elysian.agent.template": "restricted-v1"}, func(row map[string]any) {
		row["HostConfig"].(map[string]any)["Memory"] = 512 * mib
	})))
	for _, check := range []struct {
		name      string
		value     any
		input     ContainerUpdateInput
		wantKey   string
		wantError bool
	}{
		{"memory zero with existing limit", userLimited, ContainerUpdateInput{MemoryMiB: &zero}, "", true},
		{"cpu zero with existing limit", userLimited, ContainerUpdateInput{CPUMillis: &zero}, "", true},
		{"zero without limits", userUnlimited, ContainerUpdateInput{MemoryMiB: &zero, CPUMillis: &zero}, "", false},
		{"tighten template", template, ContainerUpdateInput{MemoryMiB: &tight}, "Memory", false},
		{"loosen template", template, ContainerUpdateInput{MemoryMiB: &loose}, "", true},
	} {
		t.Run(check.name, func(t *testing.T) {
			patch, err := planContainerUpdate(check.value, check.input)
			if (err != nil) != check.wantError || check.wantKey == "" && len(patch) != 0 || check.wantKey != "" && patch[check.wantKey] == nil {
				t.Fatalf("unexpected patch: %v %v", patch, err)
			}
		})
	}
}

func TestAgentUpdateRechecksTargetBeforeWriting(t *testing.T) {
	var inspections atomic.Int32
	facade := facadeWithEngine(t, newFakeEngine(func(call engineCall) (int, string, bool) {
		if call.Method != http.MethodGet || !strings.HasSuffix(call.Path, "/json") {
			t.Errorf("preflight dispatched an unexpected request: %+v", call)
			return 0, "", false
		}
		id := hostScopeID
		if inspections.Add(1) > 1 {
			id = strings.Repeat("b", 64)
		}
		return 200, hostScopeInspect(id, nil, nil), true
	}))
	policy := "unless-stopped"
	task, err := facade.SubmitUpdate(t.Context(), ContainerUpdateInput{
		ID: hostScopeID, RequestID: strings.Repeat("a", 64), RestartPolicy: &policy,
	})
	if err != nil {
		t.Fatal(err)
	}
	result := awaitContainerTask(t, facade, task.ID)
	if result.State != "failed" || result.Stage != "preflight-rejected" || facade.CheckContainerMutation(t.Context(), hostScopeID, "", "") != nil {
		t.Fatalf("unexecuted mutation was not recorded correctly: %+v", result)
	}
}
