package docker

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"time"

	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

const recreateHealthWait = time.Minute

// RecreateRecord contains only operation identity and recovery evidence.
type RecreateRecord struct {
	Observation   *RecreateObservation `json:"observation,omitempty"`
	Name          string               `json:"name"`
	CandidateName string               `json:"candidateName"`
	CandidateID   string               `json:"candidateId,omitempty"`
	BackupName    string               `json:"backupName"`
	Running       bool                 `json:"running"`
	ImageID       string               `json:"imageId,omitempty"`
	RestartPolicy json.RawMessage      `json:"restartPolicy"`
	Changes       []RecreateChange     `json:"changes"`
}

func (a *AgentFacade) PreviewAgentRecreate(ctx context.Context, id string, patch RecreatePatch, scope string) (RecreatePreview, error) {
	if err := a.check(ctx); err != nil {
		return RecreatePreview{}, agentSubmitRejected(err)
	}
	preview, err := a.previewRecreate(ctx, id, patch, "agent:"+scope, false)
	return preview, agentRejected(err)
}

func (a *AgentFacade) SubmitAgentRecreate(ctx context.Context, input RecreateInput, scope string) (ContainerOperationTask, error) {
	if err := a.check(ctx); err != nil {
		return ContainerOperationTask{}, agentSubmitRejected(err)
	}
	task, err := a.submitRecreate(ctx, input, "agent:"+scope, false)
	return task, agentSubmitRejected(err)
}

func RecreateOperationIdentity(input RecreateInput) any {
	return ScopedContainerOperationInput("recreate/v1", input)
}

func (a *AgentFacade) submitRecreate(ctx context.Context, input RecreateInput, scope string, allowSensitive bool) (ContainerOperationTask, error) {
	if !agentOperationIDPattern.MatchString(input.RequestID) {
		return ContainerOperationTask{}, shared.InvalidRequest("重建请求 ID 无效")
	}
	identity := RecreateOperationIdentity(input)
	if prior, found, err := a.existingContainerOperation(input.RequestID, input.ID, identity); found || err != nil {
		return prior, err
	}
	a.recreateMu.Lock()
	plan, ok := a.recreatePlans[input.PlanID]
	a.recreateMu.Unlock()
	if !ok || plan.scope != scope || plan.preview.ID != input.ID || plan.preview.Revision != input.Revision || !time.Now().Before(plan.expires) {
		return ContainerOperationTask{}, shared.Conflict("预览无效或已过期，请重新预览")
	}
	if err := a.CheckContainerMutation(ctx, input.ID, "", ""); err != nil {
		return ContainerOperationTask{}, err
	}
	source, body, err := a.revalidateRecreate(ctx, plan, allowSensitive)
	if err != nil {
		return ContainerOperationTask{}, err
	}
	image, _ := body["Image"].(string)
	meta := &RecreateRecord{Name: source.name, CandidateName: "ely-recreate-" + input.PlanID[:24], BackupName: "ely-backup-" + input.PlanID[:24], Running: source.running, ImageID: image, RestartPolicy: source.restartBody, Changes: plan.preview.Changes}
	release, err := a.service.beginDatabaseMutation(ctx, input.ID, source.name)
	if err != nil {
		return ContainerOperationTask{}, err
	}
	defer release()
	task, err := a.submitContainerOperationWithRecreate(input.RequestID, input.ID, identity, meta, func(ctx context.Context, taskID string) (any, error) {
		return a.executeRecreate(ctx, taskID, input.RequestID, plan, *meta, allowSensitive)
	})
	if err == nil {
		a.recreateMu.Lock()
		delete(a.recreatePlans, input.PlanID)
		a.recreateMu.Unlock()
	}
	return task, err
}

func (a *AgentFacade) revalidateRecreate(ctx context.Context, plan recreatePlan, allowSensitive bool) (recreateSource, map[string]any, error) {
	s, b, _, err := a.prepareRecreate(ctx, plan.preview.ID, plan.patch, allowSensitive)
	if err != nil {
		return s, nil, err
	}
	raw, err := json.Marshal(b)
	if err != nil {
		return s, nil, err
	}
	if s.fingerprint != plan.sourceFingerprint || sha256.Sum256(raw) != plan.createFingerprint {
		return s, nil, shared.Conflict("容器配置已经变更，请重新预览")
	}
	return s, b, nil
}

type recreateEngineRejection struct{ status int }

func (recreateEngineRejection) Error() string { return "Docker 拒绝变更" }

func (a *AgentFacade) recreateEngineWrite(ctx context.Context, method, endpoint string, query url.Values, body any, success ...int) ([]byte, error) {
	var raw []byte
	var err error
	if body != nil {
		raw, err = json.Marshal(body)
		if err != nil {
			return nil, err
		}
	}
	response, err := a.service.deps.transport.Request(ctx, seam.EngineRequest{Method: method, Path: endpoint, Query: query, Body: raw, Timeout: actionTimeout, MaxBytes: 1 << 20})
	if err != nil {
		return nil, errors.New("Docker 变更结果未确认")
	}
	for _, status := range success {
		if response.Status == status {
			return response.Body, nil
		}
	}
	if response.Status >= 400 && response.Status < 600 {
		return nil, recreateEngineRejection{response.Status}
	}
	return nil, errors.New("Docker 变更结果未确认")
}

func (a *AgentFacade) recreateStage(taskID, stage, candidate string) error {
	return a.updateContainerOperation(taskID, func(task *ContainerOperationTask) {
		task.Stage = stage
		if candidate != "" && task.Recreate != nil {
			record := *task.Recreate
			record.CandidateID = candidate
			task.Recreate = &record
		}
	})
}

func (a *AgentFacade) executeRecreate(ctx context.Context, taskID, requestID string, plan recreatePlan, meta RecreateRecord, allowSensitive bool) (any, error) {
	id := plan.preview.ID
	release, err := a.service.tryLockAction(id)
	if err != nil {
		return nil, workerPreflightFailure(err)
	}
	defer release()
	if err := a.CheckContainerMutation(ctx, id, meta.Name, requestID); err != nil {
		return nil, workerPreflightFailure(err)
	}
	source, body, err := a.revalidateRecreate(ctx, plan, allowSensitive)
	if err != nil {
		return nil, workerPreflightFailure(err)
	}
	host := body["HostConfig"].(map[string]any)
	restart := host["RestartPolicy"]
	if restart == nil {
		restart = source.restartBody
	}
	disabled := json.RawMessage(`{"Name":"no","MaximumRetryCount":0}`)
	host["RestartPolicy"] = disabled
	labels := recreateMap(source.config["Labels"])
	if labels == nil {
		labels = map[string]json.RawMessage{}
	}
	marker, _ := json.Marshal(requestID)
	labels["site.elysian.recreate-request"] = marker
	body["Labels"] = labels
	if err := a.recreateStage(taskID, "recreate-creating", ""); err != nil {
		return nil, err
	}
	response, err := a.recreateEngineWrite(ctx, http.MethodPost, "/containers/create", url.Values{"name": {meta.CandidateName}}, body, http.StatusCreated)
	if err != nil {
		var rejected recreateEngineRejection
		if errors.As(err, &rejected) && rejected.status < 500 {
			return nil, workerPreflightFailure(shared.InvalidRequest("Docker 拒绝创建候选容器，原容器保持原状"))
		}
		return nil, err
	}
	var identity struct{ ID string }
	if json.Unmarshal(response, &identity) != nil || !agentOperationIDPattern.MatchString(identity.ID) {
		return nil, errors.New("候选容器身份未知")
	}
	candidate := identity.ID
	if err := a.recreateStage(taskID, "recreate-candidate", candidate); err != nil {
		return nil, err
	}
	configuration, err := a.recreateSource(ctx, candidate)
	if err != nil {
		return nil, err
	}
	if !candidateConfigurationMatches(source, configuration, body, plan.patch) ||
		stripSha256Prefix(configuration.image) != stripSha256Prefix(meta.ImageID) ||
		configuration.name != meta.CandidateName || configuration.running {
		if configuration.name != meta.CandidateName || configuration.running {
			return nil, errors.New("候选容器状态异常")
		}
		if _, err := a.recreateEngineWrite(ctx, http.MethodDelete, "/containers/"+candidate, nil, nil, 204, 404); err != nil {
			return nil, err
		}
		return nil, workerPreflightFailure(shared.InvalidRequest("候选容器配置核对失败，原容器保持原状"))
	}
	releaseCandidate, err := a.service.tryLockAction(candidate)
	if err != nil {
		return nil, err
	}
	defer releaseCandidate()

	write := func(target, action string, query url.Values, params any, codes ...int) error {
		_, e := a.recreateEngineWrite(ctx, http.MethodPost, "/containers/"+target+"/"+action, query, params, codes...)
		return e
	}
	updatePolicy := func(target string, policy any) error {
		return write(target, "update", nil, map[string]any{"RestartPolicy": policy}, 200)
	}
	rename := func(target, name string) error { return write(target, "rename", url.Values{"name": {name}}, nil, 204) }
	rollback := func(reason string) (any, error) {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if err := a.recreateStage(taskID, "recreate-rolling-back", ""); err != nil {
			return nil, err
		}
		old, e1 := a.recreateSource(ctx, id)
		next, e2 := a.recreateSource(ctx, candidate)
		if e1 != nil || e2 != nil || old.name != meta.Name && old.name != meta.BackupName ||
			next.name != meta.Name && next.name != meta.CandidateName {
			return nil, errors.New("回滚前容器身份无法核实")
		}
		if err := updatePolicy(candidate, disabled); err != nil {
			return nil, err
		}
		if next.running {
			if err := write(candidate, "stop", nil, nil, 204, 304); err != nil {
				return nil, err
			}
		}
		if next.name == meta.Name {
			if err := rename(candidate, meta.CandidateName); err != nil {
				return nil, err
			}
		}
		if old.name == meta.BackupName {
			if err := rename(id, meta.Name); err != nil {
				return nil, err
			}
		}
		if err := updatePolicy(id, meta.RestartPolicy); err != nil {
			return nil, err
		}
		if source.running && !old.running {
			if err := write(id, "start", nil, nil, 204, 304); err != nil {
				return nil, err
			}
		}
		restored, err := a.recreateSource(ctx, id)
		if err != nil || restored.name != meta.Name || restored.running != source.running || !sameRecreatePolicy(restored.restartBody, meta.RestartPolicy) {
			return nil, errors.New("原容器恢复结果未确认")
		}
		if _, err := a.recreateEngineWrite(ctx, http.MethodDelete, "/containers/"+candidate, nil, nil, 204, 404); err != nil {
			return nil, err
		}
		return nil, &seam.AgentContainerError{Code: "docker-recreate-rolled-back", Message: reason + "，已恢复原容器", NoBusinessEffect: true}
	}
	if err := a.recreateStage(taskID, "recreate-switching", ""); err != nil {
		return nil, err
	}
	for _, step := range []func() error{
		func() error { return updatePolicy(id, disabled) },
		func() error {
			if source.running {
				return write(id, "stop", nil, nil, 204, 304)
			}
			return nil
		},
		func() error { return rename(id, meta.BackupName) },
		func() error { return rename(candidate, meta.Name) },
		func() error {
			if source.running {
				return write(candidate, "start", nil, nil, 204, 304)
			}
			return nil
		},
	} {
		if err := step(); err != nil {
			var rejected recreateEngineRejection
			if errors.As(err, &rejected) {
				return rollback("Docker 拒绝切换容器")
			}
			return nil, err
		}
	}
	if err := a.recreateStage(taskID, "recreate-verifying", ""); err != nil {
		return nil, err
	}
	end := time.Now().Add(recreateHealthWait)
	for {
		next, err := a.recreateSource(ctx, candidate)
		if err != nil {
			return nil, err
		}
		if next.name != meta.Name || stripSha256Prefix(next.image) != stripSha256Prefix(meta.ImageID) {
			return nil, errors.New("替换容器身份无法确认")
		}
		state := recreateMap(next.raw["State"])
		health := recreateString(recreateMap(state["Health"])["Status"])
		checkEnabled := recreateHealthcheckEnabled(next.config["Healthcheck"])
		if !source.running && !next.running || source.running && next.running && (!checkEnabled || health == "healthy") {
			break
		}
		if source.running && !next.running || health == "unhealthy" || time.Now().After(end) {
			return rollback("新容器未通过启动或健康核验")
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Second):
		}
	}
	if err := a.recreateStage(taskID, "recreate-committing", ""); err != nil {
		return nil, err
	}
	if err := updatePolicy(candidate, restart); err != nil {
		var rejected recreateEngineRejection
		if errors.As(err, &rejected) {
			return rollback("新容器重启策略未能设置")
		}
		return nil, err
	}
	old, e1 := a.recreateSource(ctx, id)
	next, e2 := a.recreateSource(ctx, candidate)
	if e1 != nil || e2 != nil || old.name != meta.BackupName || old.running || old.restart != "no" ||
		next.name != meta.Name || next.running != source.running || !sameRecreatePolicy(next.restartBody, source.restartBody) {
		return nil, errors.New("替换后状态未确认")
	}
	if source.running && !recreateHealthy(next) {
		return rollback("新容器健康状态未通过最终核验")
	}
	if policy := a.service.deps.containerFirewall; policy != nil {
		previous, beforeErr := recreateFirewallBindings(source)
		current, afterErr := recreateFirewallBindings(next)
		if err := errors.Join(beforeErr, afterErr); err != nil {
			return nil, err
		}
		unchanged := current[:0]
		for _, binding := range current {
			for _, original := range previous {
				original.ContainerID = candidate
				if original == binding {
					unchanged = append(unchanged, binding)
					break
				}
			}
		}
		if err := policy.Transfer(id, candidate, unchanged); err != nil {
			return nil, err
		}
	}
	return map[string]any{"originalId": id, "containerId": candidate, "backupName": meta.BackupName, "running": next.running, "changes": meta.Changes}, nil
}

func recreateFirewallBindings(source recreateSource) ([]contract.DockerPublishedPort, error) {
	raw, err := json.Marshal(source.raw)
	if err != nil {
		return nil, err
	}
	value, err := decodeOrderedJSON(raw)
	if err != nil {
		return nil, err
	}
	return inspectPortBindings(source.id, value, true)
}

func sameRecreatePolicy(a, b json.RawMessage) bool {
	left, right := recreateMap(a), recreateMap(b)
	return recreateString(left["Name"]) == recreateString(right["Name"]) &&
		(!recreateNonzero(left["MaximumRetryCount"]) && !recreateNonzero(right["MaximumRetryCount"]) || string(left["MaximumRetryCount"]) == string(right["MaximumRetryCount"]))
}
