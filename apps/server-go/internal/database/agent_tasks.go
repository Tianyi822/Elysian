package database

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"elysian/server/internal/config"
	"elysian/server/internal/paths"
	"elysian/server/internal/shared"
)

type AgentTaskInput struct {
	Action   string      `json:"action"`
	Create   AgentCreate `json:"create"`
	ID       string      `json:"id"`
	Expected string      `json:"expected"`
}

type AgentTaskResult struct {
	ID          string `json:"id"`
	Action      string `json:"action"`
	Engine      string `json:"engine"`
	Name        string `json:"name"`
	ContainerID string `json:"containerId"`
	Version     string `json:"version"`
}

type AgentTask struct {
	ID              string           `json:"id"`
	RequestID       string           `json:"requestId"`
	Action          string           `json:"action"`
	State           string           `json:"state"`
	Result          *AgentTaskResult `json:"result,omitempty"`
	CancelRequested bool             `json:"cancelRequested"`
	Message         string           `json:"message"`
}

type AgentTaskLog struct {
	Sequence int    `json:"sequence"`
	At       string `json:"at"`
	Stage    string `json:"stage"`
}

type AgentTaskLogPage struct {
	Entries   []AgentTaskLog `json:"entries"`
	Next      int            `json:"next"`
	HasMore   bool           `json:"hasMore"`
	Truncated bool           `json:"truncated"`
}

const agentTaskLogLimit = 128

var agentTaskStages = map[string]bool{"accepted": true, "dispatched": true, "registered": true, "succeeded": true, "unknown": true, "cancel-requested": true, "execution-stopped": true, "restart-interrupted": true, "facts-confirmed": true}

func appendAgentTaskLog(record *agentTaskRecord, stage string) {
	record.NextSequence++
	record.Logs = append(record.Logs, AgentTaskLog{Sequence: record.NextSequence, At: time.Now().UTC().Format(time.RFC3339Nano), Stage: stage})
	if len(record.Logs) > agentTaskLogLimit {
		record.Logs = append([]AgentTaskLog(nil), record.Logs[len(record.Logs)-agentTaskLogLimit:]...)
	}
}

type agentTaskRecord struct {
	AgentTask
	Input                AgentTaskInput `json:"input"`
	Digest               string         `json:"digest"`
	AnchorContainerID    string         `json:"anchorContainerId,omitempty"`
	AnchorDigest         string         `json:"anchorDigest,omitempty"`
	RegistrationID       string         `json:"registrationId,omitempty"`
	RegistrationIdentity string         `json:"registrationIdentity,omitempty"`
	Logs                 []AgentTaskLog `json:"logs,omitempty"`
	NextSequence         int            `json:"nextSequence"`
}

// The task identity is durable before the authoritative registration is
// published, without copying its credentials into the task store.
type agentTaskRegistry struct {
	databaseRegistry
	beforeRecord func(databaseRecord) error
}

func (r *agentTaskRegistry) put(row databaseRecord) error {
	if err := r.beforeRecord(row); err != nil {
		return err
	}
	return r.databaseRegistry.put(row)
}

func agentDatabaseTaskID(requestID string) string {
	sum := sha256.Sum256([]byte(requestID))
	return hex.EncodeToString(sum[:])
}

func agentTaskInputDigest(input AgentTaskInput) string {
	raw, _ := json.Marshal(input)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func agentTaskIdentity(row databaseRecord) string {
	row.State = ""
	return agentRecordDigest(row)
}

func (f *AgentFacade) loadAgentTasks() error {
	if f.tasks != nil {
		return nil
	}
	root := f.taskRoot
	if root == "" {
		root = filepath.Join(paths.StateDir, "agent-database-tasks")
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	files, err := filepath.Glob(filepath.Join(root, "*.json"))
	if err != nil {
		return err
	}
	loaded := make(map[string]agentTaskRecord, len(files))
	for _, file := range files {
		in, err := openNoFollow(file)
		if err != nil {
			return err
		}
		info, statErr := in.Stat()
		if statErr != nil || !info.Mode().IsRegular() || info.Size() > registrySizeLimit || info.Mode()&0077 != 0 || uidOf(info) != os.Getuid() {
			in.Close()
			return errors.New("数据库任务文件权限或大小无效")
		}
		var task agentTaskRecord
		decoder := json.NewDecoder(io.LimitReader(in, registrySizeLimit+1))
		decoder.DisallowUnknownFields()
		err = decoder.Decode(&task)
		if err == nil && decoder.Decode(new(any)) != io.EOF {
			err = errors.New("数据库任务文件含多余内容")
		}
		in.Close()
		if err != nil || !containerIDPattern.MatchString(task.RequestID) || task.ID != agentDatabaseTaskID(task.RequestID) || filepath.Base(file) != task.ID+".json" || task.Digest != agentTaskInputDigest(task.Input) || task.Action != task.Input.Action || (task.Action != "create" && task.Action != "reconcile") {
			return errors.New("数据库任务记录损坏")
		}
		if (task.RegistrationID == "") != (task.RegistrationIdentity == "") || (task.RegistrationIdentity != "" && !containerIDPattern.MatchString(task.RegistrationIdentity)) {
			return errors.New("数据库任务登记关联无效")
		}
		if len(task.Logs) > agentTaskLogLimit || task.NextSequence < 0 {
			return errors.New("数据库任务日志边界无效")
		}
		for i, entry := range task.Logs {
			if !agentTaskStages[entry.Stage] || entry.Sequence < 1 || entry.Sequence > task.NextSequence || (i > 0 && entry.Sequence <= task.Logs[i-1].Sequence) {
				return errors.New("数据库任务日志无效")
			}
			if _, err := time.Parse(time.RFC3339Nano, entry.At); err != nil {
				return errors.New("数据库任务日志时间无效")
			}
		}
		switch task.State {
		case "running":
			// Accepted writes are never replayed after a process restart.
			task.State = "unknown"
			task.Message = "面板重启中断了后台执行；结果未确认，禁止重投，需核实数据库事实"
			appendAgentTaskLog(&task, "restart-interrupted")
			if err := config.AtomicJSON(file, task); err != nil {
				return err
			}
		case "unknown":
		case "succeeded":
			if task.Result == nil || task.Result.ID == "" || (task.Action == "create" && task.Result.ID != task.RegistrationID) {
				return errors.New("数据库任务缺少完成回执")
			}
		default:
			return errors.New("数据库任务状态无效")
		}
		loaded[task.ID] = task
	}
	f.taskRoot, f.tasks = root, loaded
	f.taskCtx, f.taskStop = context.WithCancel(context.Background())
	f.taskCancels = map[string]context.CancelFunc{}
	return nil
}

// validateAgentTask performs only local checks. Network work starts after the
// request has been durably recorded and the caller has an idempotency identity.
func (f *AgentFacade) validateAgentTask(input AgentTaskInput, rows []databaseRecord) (agentTaskRecord, error) {
	record := agentTaskRecord{Input: input, Digest: agentTaskInputDigest(input)}
	find := func(id, expected string) (databaseRecord, error) {
		for _, row := range rows {
			if row.ID == id && row.Source == sourceManaged && expected != "" && agentRecordDigest(row) == expected {
				return row, nil
			}
		}
		return databaseRecord{}, shared.InvalidRequest("数据库登记或版本已变化，请重新读取并审批")
	}
	switch input.Action {
	case "create":
		if input.ID != "" || input.Expected != "" {
			return record, shared.InvalidRequest("创建任务参数无效")
		}
		in := input.Create
		target := map[string]any{"kind": "new", "imageId": in.ImageID, "containerName": in.ContainerName}
		scope := scopeContainerNet
		if in.ContainerName != "" {
			if in.ID != "new:"+in.ContainerName || in.Expected != "missing" || !containerNamePattern.MatchString(in.ContainerName) || !containerIDPattern.MatchString(stripSha256Prefix(in.ImageID)) {
				return record, shared.InvalidRequest("新实例名称、镜像或登记预期无效")
			}
		} else {
			if in.ImageID != "" {
				return record, shared.InvalidRequest("已有实例不可指定新镜像")
			}
			row, err := find(in.ID, in.Expected)
			if err != nil {
				return record, err
			}
			if row.Engine != in.Engine || row.VersionTag != in.VersionTag {
				return record, shared.InvalidRequest("必须选择同版本面板受管实例")
			}
			target = map[string]any{"kind": "managed", "containerId": row.ContainerID}
			scope = row.AccessScope
			record.AnchorContainerID, record.AnchorDigest = row.ContainerID, agentTaskIdentity(row)
		}
		body := map[string]any{"engine": in.Engine, "versionTag": in.VersionTag, "name": in.Name, "accessScope": scope, "target": target, "user": map[string]any{"username": "ely_preflight", "password": "preflight-not-a-credential"}}
		if in.Charset != "" {
			body["charset"] = in.Charset
		}
		if _, err := validateCreateRequest(body); err != nil {
			return record, shared.InvalidRequest("数据库创建参数无效")
		}
		for _, row := range rows {
			if record.AnchorContainerID != "" && row.ContainerID == record.AnchorContainerID && row.State != stateEmpty && (row.Name == in.Name || in.Engine == engineRedis) {
				return record, shared.InvalidRequest("数据库已登记")
			}
		}
	case "reconcile":
		if input.Create != (AgentCreate{}) {
			return record, shared.InvalidRequest("对账任务参数无效")
		}
		row, err := find(input.ID, input.Expected)
		if err != nil {
			return record, err
		}
		if row.State == stateEmpty {
			return record, shared.InvalidRequest("空容器没有可核对的逻辑库")
		}
		record.AnchorContainerID, record.AnchorDigest = row.ContainerID, agentTaskIdentity(row)
	default:
		return record, shared.InvalidRequest("数据库任务操作未开放")
	}
	return record, nil
}

func (f *AgentFacade) SubmitTask(ctx context.Context, requestID string, input AgentTaskInput) (AgentTask, error) {
	if err := f.check(ctx); err != nil {
		return AgentTask{}, err
	}
	if !containerIDPattern.MatchString(requestID) {
		return AgentTask{}, shared.InvalidRequest("数据库请求标识必须是 64 位小写十六进制")
	}
	f.taskMu.Lock()
	defer f.taskMu.Unlock()
	if f.taskClosed {
		return AgentTask{}, errors.New("数据库任务服务已停止")
	}
	if err := f.loadAgentTasks(); err != nil {
		return AgentTask{}, errors.New("数据库任务记录不可用")
	}
	id := agentDatabaseTaskID(requestID)
	if existing, ok := f.tasks[id]; ok {
		if existing.RequestID != requestID || existing.Digest != agentTaskInputDigest(input) {
			return AgentTask{}, &shared.InvalidRequestError{Status: 409, Message: "请求标识已用于不同的数据库参数"}
		}
		return existing.AgentTask, nil
	}
	for _, task := range f.tasks {
		if task.State != "succeeded" {
			return AgentTask{}, &shared.InvalidRequestError{Status: 409, Message: "已有执行中或结果未确认的数据库任务"}
		}
	}
	rows, err := f.service.deps.registry.list()
	if err != nil {
		return AgentTask{}, errors.New("数据库登记不可用")
	}
	record, err := f.validateAgentTask(input, rows)
	if err != nil {
		return AgentTask{}, err
	}
	record.AgentTask = AgentTask{ID: id, RequestID: requestID, Action: input.Action, State: "running", Message: "后台任务已接受；取消仅请求停止，已发生的数据库变更不会回滚"}
	appendAgentTaskLog(&record, "accepted")
	if err := config.AtomicJSON(filepath.Join(f.taskRoot, id+".json"), record); err != nil {
		return AgentTask{}, errors.New("数据库任务接受回执保存失败，未派发")
	}
	f.tasks[id] = record
	taskCtx, taskCancel := context.WithTimeout(f.taskCtx, 20*time.Minute)
	f.taskCancels[id] = taskCancel
	f.taskWG.Add(1)
	go f.runAgentTask(taskCtx, taskCancel, record)
	return record.AgentTask, nil
}

func (f *AgentFacade) runAgentTask(ctx context.Context, cancel context.CancelFunc, record agentTaskRecord) {
	defer f.taskWG.Done()
	defer cancel()
	defer func() { f.taskMu.Lock(); delete(f.taskCancels, record.ID); f.taskMu.Unlock() }()
	var value any
	err := ctx.Err()
	if err == nil {
		f.taskMu.Lock()
		record = f.tasks[record.ID]
		appendAgentTaskLog(&record, "dispatched")
		err = config.AtomicJSON(filepath.Join(f.taskRoot, record.ID+".json"), record)
		if err == nil {
			f.tasks[record.ID] = record
		}
		f.taskMu.Unlock()
	}
	if err == nil && record.Input.Action == "create" {
		value, err = f.createAgentRecording(ctx, record.Input.Create, func(row databaseRecord) error {
			f.taskMu.Lock()
			defer f.taskMu.Unlock()
			record = f.tasks[record.ID]
			identity := agentTaskIdentity(row)
			if record.RegistrationID != "" {
				if record.RegistrationID != row.ID || record.RegistrationIdentity != identity {
					return errors.New("数据库任务登记身份发生变化")
				}
				return nil
			}
			updated := record
			updated.RegistrationID, updated.RegistrationIdentity = row.ID, identity
			appendAgentTaskLog(&updated, "registered")
			if err := config.AtomicJSON(filepath.Join(f.taskRoot, record.ID+".json"), updated); err != nil {
				return errors.New("数据库任务登记关联保存失败")
			}
			f.tasks[record.ID], record = updated, updated
			return nil
		})
	} else if err == nil {
		value, err = f.lifecycleAgent(ctx, record.Input.ID, record.Input.Expected, "reconcile")
	}
	var result *AgentTaskResult
	if err == nil {
		id := record.Input.ID
		if record.Input.Action == "create" {
			if result, ok := value.(map[string]any); ok {
				if instance, ok := result["database"].(serviceInstance); ok {
					id = instance.ID
				}
			}
		}
		if row, readErr := f.service.record(id); readErr == nil && ((record.Action == "create" && row.ID == record.RegistrationID && agentTaskIdentity(row) == record.RegistrationIdentity) || (record.Action == "reconcile" && agentTaskIdentity(row) == record.AnchorDigest)) {
			result = agentTaskResult(row, record.Action)
		}
	}
	f.taskMu.Lock()
	defer f.taskMu.Unlock()
	updated := f.tasks[record.ID]
	updated.State, updated.Result = "unknown", nil
	updated.Message = "执行已结束，数据库结果未确认；禁止重投，需回读实际事实"
	stage := "unknown"
	if result != nil {
		updated.State, updated.Result, updated.Message = "succeeded", result, "数据库操作已完成并核验"
		stage = "succeeded"
	} else if updated.CancelRequested {
		updated.Message = "后台执行已停止，数据库结果未确认；已发生的变更不会回滚，禁止重投"
		stage = "execution-stopped"
	}
	appendAgentTaskLog(&updated, stage)
	if config.AtomicJSON(filepath.Join(f.taskRoot, record.ID+".json"), updated) == nil {
		f.tasks[record.ID] = updated
	} else {
		// Persistence failure cannot turn an accepted task into a retryable call.
		updated.State, updated.Result = "unknown", nil
		updated.Message = "任务回执保存失败，数据库结果未确认；禁止重投"
		f.tasks[record.ID] = updated
	}
}

func agentTaskResult(row databaseRecord, action string) *AgentTaskResult {
	return &AgentTaskResult{ID: row.ID, Action: action, Engine: row.Engine, Name: row.Name, ContainerID: row.ContainerID, Version: agentRecordDigest(row)}
}

func (f *AgentFacade) recoverAgentTask(ctx context.Context, task agentTaskRecord) *AgentTaskResult {
	rows, err := f.service.deps.registry.list()
	if err != nil {
		return nil
	}
	var candidate *databaseRecord
	for i := range rows {
		row := rows[i]
		if row.Source != sourceManaged || row.State != stateActive {
			continue
		}
		if task.Action == "reconcile" {
			if row.ID != task.Input.ID || agentTaskIdentity(row) != task.AnchorDigest {
				continue
			}
		} else {
			in := task.Input.Create
			if row.Engine != in.Engine || row.VersionTag != in.VersionTag || row.Name != in.Name {
				continue
			}
			if task.RegistrationID == "" || row.ID != task.RegistrationID || agentTaskIdentity(row) != task.RegistrationIdentity || (task.AnchorContainerID != "" && row.ContainerID != task.AnchorContainerID) {
				continue
			}
			if in.ContainerName != "" {
				info, err := f.service.deps.docker.inspect(ctx, row.ContainerID)
				if err != nil || asString(info["Id"]) != row.ContainerID || strings.TrimPrefix(asString(info["Name"]), "/") != in.ContainerName || stripSha256Prefix(asString(info["Image"])) != stripSha256Prefix(in.ImageID) || row.AccessScope != scopeContainerNet {
					continue
				}
			}
		}
		if candidate != nil {
			return nil
		}
		copy := row
		candidate = &copy
	}
	if candidate == nil {
		return nil
	}
	if d, ok := f.service.deps.docker.(*dockerAPI); ok {
		if _, err := d.agentManaged(ctx, *candidate, f.service.deps.selfContainerID); err != nil {
			return nil
		}
	}
	if _, _, err := f.service.checked(ctx, *candidate); err != nil {
		return nil
	}
	current, err := f.service.record(candidate.ID)
	if err != nil || agentRecordDigest(current) != agentRecordDigest(*candidate) {
		return nil
	}
	return agentTaskResult(current, task.Action)
}

func (f *AgentFacade) InspectTask(ctx context.Context, id string) (AgentTask, error) {
	if err := ctx.Err(); err != nil {
		return AgentTask{}, err
	}
	if !f.Available() || !containerIDPattern.MatchString(id) {
		return AgentTask{}, errors.New("数据库任务不可用")
	}
	f.taskMu.Lock()
	if err := f.loadAgentTasks(); err != nil {
		f.taskMu.Unlock()
		return AgentTask{}, errors.New("数据库任务记录不可用")
	}
	task, ok := f.tasks[id]
	f.taskMu.Unlock()
	if !ok {
		return AgentTask{}, errors.New("数据库任务不存在")
	}
	if task.State != "unknown" {
		return task.AgentTask, nil
	}
	result := f.recoverAgentTask(ctx, task)
	if result == nil {
		return task.AgentTask, nil
	}
	f.taskMu.Lock()
	defer f.taskMu.Unlock()
	current := f.tasks[id]
	if current.State == "unknown" {
		current.State, current.Result = "succeeded", result
		current.Message = "数据库登记、容器身份与协议事实已重新核验"
		appendAgentTaskLog(&current, "facts-confirmed")
		if err := config.AtomicJSON(filepath.Join(f.taskRoot, id+".json"), current); err != nil {
			return task.AgentTask, errors.New("数据库任务核验回执保存失败")
		}
		f.tasks[id] = current
	}
	return current.AgentTask, nil
}

func agentTaskResource(record agentTaskRecord) string {
	if record.Action == "create" {
		return record.Input.Create.ID
	}
	return record.Input.ID
}

func (f *AgentFacade) authorizedTask(ctx context.Context, resource, id string) (agentTaskRecord, error) {
	if err := f.check(ctx); err != nil {
		return agentTaskRecord{}, err
	}
	if !containerIDPattern.MatchString(id) {
		return agentTaskRecord{}, shared.InvalidRequest("数据库任务标识无效")
	}
	f.taskMu.Lock()
	defer f.taskMu.Unlock()
	if err := f.loadAgentTasks(); err != nil {
		return agentTaskRecord{}, errors.New("数据库任务记录不可用")
	}
	record, ok := f.tasks[id]
	if !ok || agentTaskResource(record) != resource {
		return agentTaskRecord{}, errors.New("数据库任务不存在或不属于授权数据库")
	}
	return record, nil
}

func (f *AgentFacade) TaskStatus(ctx context.Context, resource, id string) (AgentTask, error) {
	if _, err := f.authorizedTask(ctx, resource, id); err != nil {
		return AgentTask{}, err
	}
	bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return f.InspectTask(bounded, id)
}

func (f *AgentFacade) TaskLogs(ctx context.Context, resource, id string, cursor, limit int) (AgentTaskLogPage, error) {
	if cursor < 0 || limit < 1 || limit > 50 {
		return AgentTaskLogPage{}, shared.InvalidRequest("日志游标须非负，单页条数须为 1–50")
	}
	record, err := f.authorizedTask(ctx, resource, id)
	if err != nil {
		return AgentTaskLogPage{}, err
	}
	if cursor > record.NextSequence {
		return AgentTaskLogPage{}, shared.InvalidRequest("日志游标超出当前范围")
	}
	page := AgentTaskLogPage{Entries: []AgentTaskLog{}, Next: cursor, Truncated: len(record.Logs) > 0 && cursor < record.Logs[0].Sequence-1}
	for _, entry := range record.Logs {
		if entry.Sequence <= cursor {
			continue
		}
		if len(page.Entries) == limit {
			page.HasMore = true
			break
		}
		page.Entries = append(page.Entries, entry)
		page.Next = entry.Sequence
	}
	return page, nil
}

func (f *AgentFacade) CancelTask(ctx context.Context, resource, id string) (AgentTask, error) {
	if _, err := f.authorizedTask(ctx, resource, id); err != nil {
		return AgentTask{}, err
	}
	f.taskMu.Lock()
	defer f.taskMu.Unlock()
	record := f.tasks[id]
	if record.State != "running" || f.taskCancels[id] == nil {
		value := record.AgentTask
		if record.State == "unknown" {
			value.Message = "任务已结束或重启中断，无法用取消确认数据库结果；保持结果未知，禁止重投"
		}
		return value, nil
	}
	if !record.CancelRequested {
		record.CancelRequested = true
		record.Message = "已请求停止后台执行；已发生的数据库变更不会回滚，需等待并核实实际结果"
		appendAgentTaskLog(&record, "cancel-requested")
		if err := config.AtomicJSON(filepath.Join(f.taskRoot, id+".json"), record); err != nil {
			return AgentTask{}, errors.New("取消请求保存失败，未发送停止信号")
		}
		f.tasks[id] = record
	}
	f.taskCancels[id]()
	return record.AgentTask, nil
}

func (f *AgentFacade) LookupTask(ctx context.Context, requestID string) (AgentTask, error) {
	if !containerIDPattern.MatchString(requestID) {
		return AgentTask{}, shared.InvalidRequest("数据库请求标识无效")
	}
	task, err := f.InspectTask(ctx, agentDatabaseTaskID(requestID))
	if err != nil {
		return AgentTask{}, err
	}
	if task.RequestID != requestID {
		return AgentTask{}, errors.New("数据库请求身份不匹配")
	}
	return task, nil
}

func (f *AgentFacade) Close(ctx context.Context) error {
	if f == nil {
		return nil
	}
	f.taskMu.Lock()
	f.taskClosed = true
	if f.taskStop != nil {
		f.taskStop()
	}
	if f.taskDone == nil {
		f.taskDone = make(chan struct{})
		go func() { f.taskWG.Wait(); close(f.taskDone) }()
	}
	done := f.taskDone
	f.taskMu.Unlock()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
