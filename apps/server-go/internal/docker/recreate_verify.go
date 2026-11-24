package docker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"time"
)

func recreateEnvValues(raw any) map[string]string {
	var env []string
	bytes, _ := json.Marshal(raw)
	_ = json.Unmarshal(bytes, &env)
	out := map[string]string{}
	for _, line := range env {
		key, value, set := strings.Cut(line, "=")
		if set {
			out[key] = value
		} else {
			delete(out, key)
		}
	}
	return out
}

func recreateArgv(s recreateSource) []string {
	var args []string
	_ = json.Unmarshal(s.raw["Args"], &args)
	return append([]string{recreateString(s.raw["Path"])}, args...)
}

func candidateConfigurationMatches(old, next recreateSource, body map[string]any, p RecreatePatch) bool {
	if !slices.Equal(recreateArgv(old), recreateArgv(next)) {
		return false
	}
	host := body["HostConfig"].(map[string]any)
	var expectedPorts, actualPorts map[string][]enginePortBindingEntry
	data, _ := json.Marshal(host["PortBindings"])
	if json.Unmarshal(data, &expectedPorts) != nil || len(next.host["PortBindings"]) > 0 && json.Unmarshal(next.host["PortBindings"], &actualPorts) != nil {
		return false
	}
	if !(len(expectedPorts) == 0 && len(actualPorts) == 0) && !reflect.DeepEqual(expectedPorts, actualPorts) {
		return false
	}
	env := recreateEnvValues(body["Env"])
	actual := recreateEnvValues(next.config["Env"])
	for key, value := range env {
		if got, ok := actual[key]; !ok || got != value {
			return false
		}
	}
	for _, change := range p.Env {
		if _, ok := actual[change.Key]; change.Remove && ok {
			return false
		}
	}
	expected := recreateMounts(old)
	if p.Mounts != nil {
		expected = make([]RecreateMount, 0, len(*p.Mounts))
		for _, mount := range host["Mounts"].([]map[string]any) {
			expected = append(expected, RecreateMount{Kind: mount["Type"].(string), Source: mount["Source"].(string), Target: mount["Target"].(string), ReadOnly: mount["ReadOnly"].(bool)})
		}
	}
	mounts := map[string]RecreateMount{}
	for _, mount := range recreateMounts(next) {
		mounts[mount.Target] = mount
	}
	if len(expected) != len(mounts) {
		return false
	}
	for _, mount := range expected {
		if mount != mounts[mount.Target] {
			return false
		}
	}
	return true
}

func recreateHealthcheckEnabled(raw json.RawMessage) bool {
	var checks []string
	_ = json.Unmarshal(recreateMap(raw)["Test"], &checks)
	return len(checks) > 0 && checks[0] != "NONE"
}

func recreateHealthy(s recreateSource) bool {
	return !recreateHealthcheckEnabled(s.config["Healthcheck"]) ||
		recreateString(recreateMap(recreateMap(s.raw["State"])["Health"])["Status"]) == "healthy"
}

// ObserveRecreate compares Engine facts with the durable intent. It issues no
// Engine mutation and preserves ambiguous tasks, including partially switched names.
func (a *AgentFacade) ObserveRecreate(ctx context.Context, task ContainerOperationTask) (ContainerOperationTask, error) {
	record := task.Recreate
	if task.State != "unknown" || record == nil || record.Observation != nil || task.Resolution != nil || !agentOperationIDPattern.MatchString(record.CandidateID) {
		return task, nil
	}
	a.operationMu.Lock()
	active := a.operationCancel[task.ID] != nil
	a.operationMu.Unlock()
	if active {
		return task, nil
	}
	old, err := a.recreateSource(ctx, task.Target)
	if err != nil {
		return task, nil
	}
	next, err := a.recreateSource(ctx, record.CandidateID)
	resolved := ""
	switch {
	case err == nil && (task.Stage == "recreate-verifying" || task.Stage == "recreate-committing") &&
		old.name == record.BackupName && !old.running && old.restart == "no" &&
		next.name == record.Name && next.running == record.Running && (!record.Running || recreateHealthy(next)) &&
		sameRecreatePolicy(next.restartBody, record.RestartPolicy) &&
		stripSha256Prefix(next.image) == stripSha256Prefix(record.ImageID) &&
		recreateString(recreateMap(next.config["Labels"])["site.elysian.recreate-request"]) == task.RequestID:
		resolved = "succeeded"
	case err != nil && task.Stage == "recreate-rolling-back" && old.name == record.Name && old.running == record.Running && sameRecreatePolicy(old.restartBody, record.RestartPolicy):
		status, _, err := a.service.engineJSON(ctx, http.MethodGet, "/containers/"+record.CandidateID+"/json", nil, nil, actionTimeout)
		if err == nil && status == http.StatusNotFound {
			resolved = "failed"
		}
	}
	if resolved == "" {
		return task, nil
	}
	a.operationMu.Lock()
	defer a.operationMu.Unlock()
	current, ok := a.operations[task.ID]
	if !ok {
		return task, errors.New("无法核实重建记录")
	}
	if current.State != "unknown" || current.Stage != task.Stage || current.Digest != task.Digest || current.Recreate == nil || current.Recreate.Observation != nil || current.Resolution != nil || a.operationCancel[task.ID] != nil {
		return current, nil
	}
	// Retain the original unknown receipt and append the verified evidence.
	observation := &RecreateObservation{State: resolved, ObservedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	copy := *current.Recreate
	copy.Observation = observation
	current.Recreate = &copy
	if err := a.publishContainerOperationLocked(current.ID, current); err != nil {
		return task, err
	}
	return current, nil
}

type RecreateObservation struct {
	State      string `json:"state"`
	ObservedAt string `json:"observedAt"`
}

func validRecreateObservation(task ContainerOperationTask) bool {
	if task.State != "unknown" || task.Recreate == nil || task.Recreate.Observation == nil || !agentOperationIDPattern.MatchString(task.Recreate.CandidateID) {
		return false
	}
	o := task.Recreate.Observation
	if _, err := time.Parse(time.RFC3339Nano, o.ObservedAt); err != nil {
		return false
	}
	return o.State == "failed" && task.Stage == "recreate-rolling-back" ||
		o.State == "succeeded" && (task.Stage == "recreate-verifying" || task.Stage == "recreate-committing")
}

func RecreateTaskStatus(task ContainerOperationTask) ContainerOperationTask {
	if task.Recreate != nil && task.State == "running" && task.Message == "" {
		task.Message = map[string]string{
			"accepted": "已受理重建", "dispatched": "正在检查容器配置",
			"recreate-creating": "正在创建候选容器", "recreate-candidate": "已创建候选容器，正在核对配置",
			"recreate-switching": "正在切换容器", "recreate-verifying": "正在核对运行与健康状态",
			"recreate-committing": "正在确认替换结果", "recreate-rolling-back": "正在恢复原容器",
		}[task.Stage]
	}
	if validRecreateObservation(task) {
		task.State = task.Recreate.Observation.State
		task.Stage = "recreate-observed"
		task.Message = "已从 Docker Engine 核实重建结果"
		if task.State == "succeeded" {
			task.ErrorCode = ""
		} else {
			task.ErrorCode = "docker-recreate-rolled-back"
		}
	}
	return task
}
