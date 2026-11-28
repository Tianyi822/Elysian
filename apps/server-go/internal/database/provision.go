package database

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	"elysian/server/internal/applog"
	"elysian/server/internal/contract"
	"elysian/server/internal/shared"
)

// Agent 数据库部署：按「复用优先」把一个库部署到实例里。受理前把能判定的问题全部拒绝
//（可纠正、不建任务）；受理后由持久任务执行，失败按对业务的影响如实分类。

// ProvisionInput 是 database_provision 的参数。
type ProvisionInput struct {
	Engine       string `json:"engine"`
	Version      string `json:"version"`
	Database     string `json:"database"`
	Username     string `json:"username,omitempty"`
	Instance     string `json:"instance,omitempty"`
	NewInstance  bool   `json:"newInstance,omitempty"`
	InstanceName string `json:"instanceName,omitempty"`
	ResourceTier string `json:"resourceTier,omitempty"`
	NetworkScope string `json:"networkScope,omitempty"`
	HostPort     int    `json:"hostPort,omitempty"`
	RequestID    string `json:"requestId"`
}

// AgentProvisionError 只带固定文案；NotDispatched 表示未受理、没有任何变更。
type AgentProvisionError struct {
	Code          string
	Message       string
	NotDispatched bool
}

func (e *AgentProvisionError) Error() string { return e.Message }

// InstancesReport 是实例发现的结果：实例列表，以及给出引擎时的部署决策。
type InstancesReport struct {
	Instances []InstanceView `json:"instances"`
	Plan      *ProvisionPlan `json:"plan,omitempty"`
}

// ProvisionReceipt 是部署成功的回执投影：不含任何凭据值。
type ProvisionReceipt struct {
	Action          string                     `json:"action"`
	Instance        InstanceView               `json:"instance"`
	Database        logicalDatabaseView        `json:"database"`
	Username        string                     `json:"username"`
	CredentialsNote string                     `json:"credentialsNote"`
	FirewallPort    *contract.FirewallPortSync `json:"firewallPort,omitempty"`
}

const provisionCredentialsNote = "用户名和密码只保存在面板登记：到数据库页该实例卡片点「复制用户名」「复制密码」获取，密码不会出现在对话里"

// provisionFailure 是执行中的确定失败：effect 说明对业务的影响。
type provisionFailure struct {
	code   string
	err    error
	effect string
}

func (e *provisionFailure) Error() string { return e.err.Error() }
func (e *provisionFailure) Unwrap() error { return e.err }

func provisionFailureOf(effect, message string) error {
	return &provisionFailure{code: "database-provision-failed", err: errors.New(message), effect: effect}
}

// provisionSpec 是受理后的执行计划。
type provisionSpec struct {
	plan       ProvisionPlan
	logical    logicalPlan
	create     *provisionInstance
	target     string
	instanceID string
}

// provisionInstance 描述要新建的受管实例。
type provisionInstance struct {
	name         string
	tier         string
	networkScope string
	hostPort     int
}

// provisionRejected 把受理前的拒绝表达为未派发的固定文案错误。
func provisionRejected(err error) error {
	if err == nil {
		return nil
	}
	message := ""
	var invalid *shared.InvalidRequestError
	if errors.As(err, &invalid) {
		message = invalid.Message
	}
	if message == "" {
		message = "数据库部署提交预检失败，未受理任何变更；请核实输入与面板状态后重试"
	}
	return &AgentProvisionError{Code: "database-provision-rejected", Message: message, NotDispatched: true}
}

// instancesReport 列出实例；给了引擎时附上部署决策。
func (s *databaseService) instancesReport(ctx context.Context, engine, version string) (InstancesReport, error) {
	report := InstancesReport{Instances: []InstanceView{}}
	instances, err := s.ListInstances(ctx)
	if err != nil {
		return report, err
	}
	for _, view := range instances {
		if engine != "" && view.Engine != engine {
			continue
		}
		report.Instances = append(report.Instances, view)
	}
	if engine != "" {
		if engine != engineMySQL && engine != engineMariaDB && engine != engineRedis {
			return report, shared.InvalidRequest("数据库引擎不受支持")
		}
		plan, err := s.PlanProvision(ctx, engine, version, "", false)
		if err != nil {
			return report, err
		}
		report.Plan = &plan
	}
	return report, nil
}

// prepareProvision 完成受理前的全部核对，返回执行计划；任何一步不满足都返回可拒绝的错误。
func (s *databaseService) prepareProvision(ctx context.Context, input ProvisionInput) (provisionSpec, error) {
	spec := provisionSpec{}
	if !provisionIDPattern.MatchString(input.RequestID) {
		return spec, shared.InvalidRequest("数据库部署需要稳定的 64 位小写十六进制请求标识 requestId")
	}
	if input.Engine != engineMySQL && input.Engine != engineMariaDB && input.Engine != engineRedis {
		return spec, shared.InvalidRequest("数据库引擎的部署目前支持 MySQL、MariaDB 与 Redis")
	}
	if !validDatabaseVersion(input.Version) {
		return spec, shared.InvalidRequest("必须指定明确的数据库版本，不能使用 latest")
	}
	if err := validateLogicalDatabase(input.Database); err != nil {
		return spec, err
	}
	if input.Engine != engineRedis {
		// MySQL／MariaDB 的库名还不能是系统库；Redis 的 database 只是 key 前缀。
		if err := validateSchemaDatabase(input.Database); err != nil {
			return spec, err
		}
	}
	username := input.Username
	if username == "" {
		username = defaultLogicalUsername(input.Database)
	}
	if err := validateLogicalUser(username, defaultAdminUsername(input.Engine, nil)); err != nil {
		return spec, err
	}
	if input.Instance != "" && (!containerIDPattern.MatchString(input.Instance) || input.NewInstance) {
		return spec, shared.InvalidRequest("instance 必须是 64 位小写十六进制的容器 ID，且不能与 newInstance 同时使用")
	}
	plan, err := s.PlanProvision(ctx, input.Engine, input.Version, input.Instance, input.NewInstance)
	if err != nil {
		return spec, err
	}
	spec.plan, spec.logical = plan, logicalPlan{database: input.Database, username: username}
	switch plan.Action {
	case planReuse:
		spec.instanceID = plan.Instance.ID
		// 复用的是别人也在用的实例：先确认要建的名字不会接到已有的库或账号上。
		if err := s.assertReuseSafe(ctx, &spec); err != nil {
			return spec, err
		}
	case planCreate:
		instance, err := s.prepareInstance(ctx, input)
		if err != nil {
			return spec, err
		}
		spec.create = instance
	default:
		return spec, shared.Conflict(plan.Reason)
	}
	if err := s.assertLogicalNamesFree(ctx, spec); err != nil {
		return spec, err
	}
	spec.target = input.Engine + "/" + input.Version + "/" + input.Database
	return spec, nil
}

// prepareInstance 核对新建实例需要的档位、网络范围、宿主端口与容量。
func (s *databaseService) prepareInstance(ctx context.Context, input ProvisionInput) (*provisionInstance, error) {
	tier, ok := shared.ResourceTierByName(input.ResourceTier)
	if !ok {
		return nil, shared.InvalidRequest("资源档位必须是 small、medium 或 large；新建实例需要用户选定 resourceTier 与 networkScope")
	}
	switch input.NetworkScope {
	case scopeContainerNet, scopeLocalhost, scopeAnyHost:
	default:
		return nil, shared.InvalidRequest("网络范围必须是 container-network、localhost 或 any-host；新建实例需要用户选定 networkScope")
	}
	instance := &provisionInstance{name: input.InstanceName, tier: tier.Name, networkScope: input.NetworkScope, hostPort: input.HostPort}
	if instance.name == "" {
		instance.name = strings.ToLower(input.Engine) + "-" + strings.ReplaceAll(input.Version, ".", "-") + "-" + input.RequestID[:6]
	}
	if !containerNamePattern.MatchString(instance.name) {
		return nil, shared.InvalidRequest("实例名称只能使用字母、数字、下划线、点和短横线，且不超过 64 个字符")
	}
	if input.NetworkScope != scopeAnyHost {
		if input.HostPort != 0 {
			return nil, shared.InvalidRequest("只有 any-host 网络范围需要宿主端口")
		}
	} else if input.HostPort < 1 || input.HostPort > 65535 {
		return nil, shared.InvalidRequest("任意主机访问必须指定 1–65535 的宿主端口")
	}
	for _, reserved := range s.deps.reservedPorts {
		if input.HostPort == reserved && input.HostPort != 0 {
			return nil, shared.InvalidRequest("宿主端口被面板保留，请换一个端口")
		}
	}
	if input.HostPort != 0 {
		if err := s.deps.docker.assertHostPortFree(ctx, input.HostPort); err != nil {
			var invalid *shared.InvalidRequestError
			if errors.As(err, &invalid) {
				return nil, err
			}
			return nil, shared.InvalidRequest("查询宿主端口占用失败，未创建实例；请稍后重试")
		}
	}
	memory, reason := s.sampleHostMemory(ctx)
	if message := shared.CapacityRejection(memory, reason, " "+tier.Name+" 档", tier.MemoryBytes); message != "" {
		return nil, shared.InvalidRequest(message)
	}
	return instance, nil
}

// assertLogicalNamesFree 在目标实例内拒绝与已生效登记重名的库，以及被别的登记占用的用户名
// （用户名在实例内全局唯一）。同一实例上尚未确认的同名登记属于之前被打断的部署，由执行阶段
// 沿用，不算冲突；库名只在实例内有意义，别的实例上的同名库不构成冲突。
func (s *databaseService) assertLogicalNamesFree(ctx context.Context, spec provisionSpec) error {
	if spec.instanceID == "" {
		return nil
	}
	rows, err := s.deps.registry.list()
	if err != nil {
		return err
	}
	for _, row := range rows {
		if row.ContainerID != spec.instanceID {
			continue
		}
		for _, logical := range row.Logical {
			if logical.Name == spec.logical.database && logical.State == logicalStateActive {
				return shared.Conflict("数据库 " + spec.logical.database + " 已由面板登记在该实例上，请换一个库名")
			}
			if logical.Name == spec.logical.database {
				continue
			}
			for _, user := range logical.Users {
				if user.Username == spec.logical.username {
					return shared.Conflict("数据库用户名 " + spec.logical.username + " 已被该实例上的另一个数据库占用，请指定其他 username")
				}
			}
		}
	}
	return nil
}

// assertReuseSafe 在复用的实例上核将要创建的名字。幂等的建库脚本会改掉同名用户的密码并授出
// 整库权限，所以实例里已有的同名库或用户只有在确实是面板自己的待确认登记时才能续做：
// 待确认登记里的用户必须能用登记密码登录。别的来源一律拒绝，不碰现有账号。
func (s *databaseService) assertReuseSafe(ctx context.Context, spec *provisionSpec) error {
	rows, err := s.deps.registry.list()
	if err != nil {
		return err
	}
	own, admin := false, databaseSecret{}
	for _, row := range rows {
		if row.ContainerID != spec.instanceID {
			continue
		}
		if row.Admin.Password != "" {
			admin = row.Admin
		}
		for _, logical := range row.Logical {
			if logical.Name == spec.logical.database && logical.State == logicalStatePending && len(logical.Users) > 0 {
				own = true
				// 续做沿用登记里的用户名与密码，而不是这次请求新给的。
				spec.logical.username, spec.logical.password = logical.Users[0].Username, logical.Users[0].Password
			}
		}
	}
	if admin.Password == "" || s.deps.admin == nil {
		return nil
	}
	existence, err := s.deps.admin.inspectLogical(ctx, adminTarget{containerID: spec.instanceID, engine: spec.plan.Engine, admin: admin}, spec.logical)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return shared.InvalidRequest("无法核对实例 " + spec.plan.Instance.Name + " 里是否已有同名的库或用户，未执行任何变更；请稍后重试")
	}
	instance := "实例 " + spec.plan.Instance.Name + " 里已存在"
	switch {
	case !existence.Database && !existence.User:
		return nil
	case own && existence.PasswordMatches:
		return nil
	case existence.User && !existence.PasswordMatches:
		return shared.Conflict(instance + "用户 " + spec.logical.username + "，且它的密码不是面板登记的；继续会改掉它的密码与权限，未执行。请换一个用户名，或先确认该账号的归属")
	case existence.Database:
		return shared.Conflict(instance + "名为 " + spec.logical.database + " 的库，且它不是面板登记的；未执行。请换一个库名")
	}
	return nil
}

func (s provisionSpec) instanceTarget() (string, string) {
	if s.create != nil {
		return "", s.create.name
	}
	return s.instanceID, s.plan.Instance.Name
}

func (f *AgentFacade) existingProvision(id, digest string) (ProvisionTask, bool, error) {
	f.operationMu.Lock()
	defer f.operationMu.Unlock()
	return f.existingProvisionLocked(id, digest)
}

func (f *AgentFacade) existingProvisionLocked(id, digest string) (ProvisionTask, bool, error) {
	if err := f.loadProvisions(); err != nil {
		return ProvisionTask{}, false, err
	}
	task, found := f.operations[id]
	if found && task.Digest != digest {
		return ProvisionTask{}, true, &AgentProvisionError{Code: "database-provision-conflict", Message: "requestId 已用于其他数据库部署；同一请求重试必须复用原值与完整参数", NotDispatched: true}
	}
	return ProvisionAgentReceipt(task), found, nil
}

// SubmitProvision 受理一次部署。受理前的问题都作为未派发拒绝返回；受理后返回持久任务。
func (f *AgentFacade) SubmitProvision(ctx context.Context, input ProvisionInput) (ProvisionTask, error) {
	if err := f.checkProvision(ctx); err != nil {
		return ProvisionTask{}, err
	}
	if !provisionIDPattern.MatchString(input.RequestID) {
		return ProvisionTask{}, provisionRejected(shared.InvalidRequest("数据库部署需要稳定的 64 位小写十六进制请求标识 requestId"))
	}
	digest, err := ProvisionInputDigest(input)
	if err != nil {
		return ProvisionTask{}, err
	}
	id := provisionID(input.RequestID)
	if task, found, err := f.existingProvision(id, digest); found || err != nil {
		return task, err
	}
	spec, err := f.service.prepareProvision(ctx, input)
	if err != nil {
		if task, found, lookupErr := f.existingProvision(id, digest); found || lookupErr != nil {
			return task, lookupErr
		}
		return ProvisionTask{}, provisionRejected(err)
	}
	instanceID, instanceName := spec.instanceTarget()
	release, err := f.lockProvisionTarget(ctx, instanceID, instanceName, true)
	if err != nil {
		return ProvisionTask{}, err
	}
	defer release()
	if task, found, err := f.existingProvision(id, digest); found || err != nil {
		return task, err
	}

	// Resolve and inspect again while container-level operations are excluded.
	spec, err = f.service.prepareProvision(ctx, input)
	if err != nil {
		if task, found, lookupErr := f.existingProvision(id, digest); found || lookupErr != nil {
			return task, lookupErr
		}
		return ProvisionTask{}, provisionRejected(err)
	}
	if actualID, actualName := spec.instanceTarget(); actualID != instanceID || actualName != instanceName {
		return ProvisionTask{}, provisionRejected(shared.Conflict("数据库部署目标已变化，请重新核对实例"))
	}
	if err := f.service.checkContainerMutation(ctx, instanceID, instanceName); err != nil {
		return ProvisionTask{}, provisionRejected(err)
	}
	if err := ctx.Err(); err != nil {
		return ProvisionTask{}, err
	}
	f.operationMu.Lock()
	defer f.operationMu.Unlock()
	if task, found, err := f.existingProvisionLocked(id, digest); found || err != nil {
		return task, err
	}
	if f.operationClosed {
		return ProvisionTask{}, errors.New("数据库部署服务已停止")
	}
	if err := f.checkProvisionConflictLocked(instanceID, instanceName); err != nil {
		return ProvisionTask{}, provisionRejected(err)
	}
	task := ProvisionTask{ID: id, RequestID: input.RequestID, Target: spec.target, InstanceID: instanceID, InstanceName: instanceName, Digest: digest, State: ProvisionRunning, Stage: "accepted", UpdatedAt: f.stamp()}
	if err := f.publishProvisionLocked(id, task); err != nil {
		return ProvisionTask{}, err
	}
	runCtx, cancel := context.WithTimeout(context.Background(), provisionTimeout)
	f.operationCancel[id] = cancel
	f.operationWG.Add(1)
	go func() {
		defer f.operationWG.Done()
		defer cancel()
		defer func() {
			f.operationMu.Lock()
			delete(f.operationCancel, id)
			f.operationMu.Unlock()
		}()
		var result ProvisionReceipt
		var runErr error
		func() {
			defer func() {
				if recovered := recover(); recovered != nil {
					applog.Default().RecoveredPanic("数据库部署", recovered)
					runErr = errors.New("数据库部署内部失败")
				}
			}()
			runCtx = context.WithValue(runCtx, provisionJournalKey{}, func(write provisionWrite) error {
				return f.recordProvisionWrite(id, write)
			})
			if runErr = f.updateProvision(id, func(t *ProvisionTask) { t.Stage = "dispatched" }); runErr == nil {
				result, runErr = f.service.executeProvision(runCtx, spec, input.RequestID,
					func(stage string) {
						_ = f.updateProvision(id, func(t *ProvisionTask) { t.Stage = stage })
					},
					// 实例一旦产生就记到任务上：此后针对它的部署与本任务互斥，结果未知时也保留这层保护。
					func(containerID string) error {
						return f.updateProvision(id, func(t *ProvisionTask) { t.InstanceID = containerID })
					})
			}
		}()
		_ = f.updateProvision(id, func(t *ProvisionTask) {
			var failure *provisionFailure
			switch {
			case runErr == nil:
				value, marshalErr := json.Marshal(result)
				if marshalErr != nil {
					t.State, t.ErrorCode, t.Message = ProvisionUnknown, "database-provision-result-unpersisted", "部署回执保存失败"
					return
				}
				t.State, t.Stage, t.Result = ProvisionSucceeded, "completed", value
			case errors.As(runErr, &failure):
				t.State, t.Effect, t.ErrorCode, t.Message = ProvisionFailed, failure.effect, failure.code, failure.err.Error()
				if failure.effect == ProvisionEffectNotDispatched {
					t.Stage = "preflight-rejected"
				}
			default:
				t.State, t.ErrorCode, t.Message = ProvisionUnknown, "database-provision-unknown", "数据库部署结果未确认，请核实实际状态，禁止自动重试"
			}
		})
	}()
	return task, nil
}

// executeProvision 执行一次已受理的部署：必要时新建实例，等实例可登录，再在其中
// 建库建专属用户。登记先于执行，重试因此幂等。
func (s *databaseService) executeProvision(ctx context.Context, spec provisionSpec, requestID string, stage func(string), recordInstance func(string) error) (ProvisionReceipt, error) {
	engine, version, instanceID := spec.plan.Engine, spec.plan.Version, spec.instanceID
	effect := ProvisionEffectNotDispatched
	var admin databaseSecret
	var created *databaseRecord
	var firewallPort *contract.FirewallPortSync
	if spec.create != nil {
		stage("creating-instance")
		row, err := func() (databaseRecord, error) {
			s.mutationMu.Lock()
			defer s.mutationMu.Unlock()
			return s.createProvisionInstance(ctx, *spec.create, engine, version, recordInstance)
		}()
		if err != nil {
			return ProvisionReceipt{}, err
		}
		created, instanceID, admin, effect = &row, row.ContainerID, row.Admin, ProvisionEffectPartial
		if spec.create.networkScope == scopeAnyHost {
			sync := s.openFirewallPort(ctx, spec.create.hostPort, "Elysian 数据库 "+spec.create.name)
			firewallPort = &sync
		}
	} else {
		rows, err := s.deps.registry.list()
		if err != nil {
			return ProvisionReceipt{}, provisionFailureOf(ProvisionEffectNotDispatched, "读取数据库登记失败，未执行任何变更；请稍后重试")
		}
		for _, row := range rows {
			if row.ContainerID == instanceID && row.Admin.Password != "" {
				admin = row.Admin
				break
			}
		}
		if admin.Password == "" {
			return ProvisionReceipt{}, provisionFailureOf(effect, "实例的管理员凭据登记缺失，未执行建库建用户")
		}
	}
	if s.deps.admin == nil {
		return ProvisionReceipt{}, provisionFailureOf(effect, "实例内管理操作未装配，未执行建库建用户")
	}
	target := adminTarget{containerID: instanceID, engine: engine, admin: admin}
	stage("waiting-ready")
	if err := s.deps.admin.waitReady(ctx, target); err != nil {
		if ctx.Err() != nil {
			return ProvisionReceipt{}, &provisionFailure{code: "database-provision-cancelled", err: ctx.Err(), effect: effect}
		}
		return ProvisionReceipt{}, provisionFailureOf(effect, "数据库实例在限定时间内未就绪，未执行建库建用户")
	}
	stage("creating-database")
	record, plan, err := s.registerLogicalPending(ctx, instanceID, spec.logical, requestID)
	if err != nil {
		var rejected *provisionFailure
		if created != nil && errors.As(err, &rejected) && rejected.effect == ProvisionEffectNotDispatched {
			return ProvisionReceipt{}, provisionFailureOf(ProvisionEffectPartial, rejected.Error())
		}
		return ProvisionReceipt{}, err
	}
	if err := s.deps.admin.createLogical(ctx, target, plan); err != nil {
		var rejected *logicalPreflightError
		if errors.As(err, &rejected) {
			return ProvisionReceipt{}, provisionFailureOf(effect, rejected.Error())
		}
		var ended *logicalWriteEndedError
		if errors.As(err, &ended) {
			facts, inspectErr := s.deps.admin.inspectLogical(ctx, target, plan)
			if inspectErr == nil {
				switch {
				case facts.User && facts.PasswordMatches && !facts.PermissionsMatch:
					return ProvisionReceipt{}, provisionFailureOf(ProvisionEffectPartial, "建库命令已结束，回读确认专属账号已创建，登记保留待确认")
				case !facts.User && !facts.Database && created != nil:
					return ProvisionReceipt{}, provisionFailureOf(ProvisionEffectPartial, "新实例已创建，回读未发现本次逻辑库或用户，登记保留待确认")
				case !facts.User && !facts.Database:
					return ProvisionReceipt{}, provisionFailureOf(ProvisionEffectNoChange, "建库命令已结束，回读未发现目标库或用户")
				}
			}
		}
		return ProvisionReceipt{}, err
	}
	stage("verifying")
	if err := s.activateLogical(ctx, instanceID, record.ID); err != nil {
		return ProvisionReceipt{}, err
	}
	stage("completed")
	action := "reuse"
	if created != nil {
		action = "create"
	}
	return ProvisionReceipt{
		Action:          action,
		Instance:        s.instanceReceiptView(ctx, instanceID, created),
		Database:        logicalDatabaseView{ID: record.ID, Kind: record.Kind, Name: record.Name, Users: []string{plan.username}, State: logicalStateActive, CreatedAt: record.CreatedAt},
		Username:        plan.username,
		CredentialsNote: provisionCredentialsNote,
		FirewallPort:    firewallPort,
	}, nil
}

// createProvisionInstance 新建带资源档位的受管实例。实例产生之前的失败是未派发；启动失败
// 则回滚删除本次创建的容器与卷，回滚确认后才是「无业务变更」，回滚失败保持结果未知。
// 容器登记之后立刻经 recordInstance 把容器 ID 记到任务上；记不下来时结果按未知处理。
func (s *databaseService) createProvisionInstance(ctx context.Context, spec provisionInstance, engine, version string, recordInstance func(string) error) (databaseRecord, error) {
	images, err := s.deps.listImages(ctx)
	if err != nil {
		return databaseRecord{}, provisionFailureOf(ProvisionEffectNotDispatched, "读取本机镜像清单失败，未创建实例；请稍后重试")
	}
	imageID := ""
	for _, image := range images {
		if databaseImageHasTag(image, engine, version) {
			imageID = image.ID
			break
		}
	}
	if imageID == "" {
		return databaseRecord{}, provisionFailureOf(ProvisionEffectNotDispatched, "本地没有该版本的官方镜像，未创建实例")
	}
	rows, err := s.deps.registry.list()
	if err != nil {
		return databaseRecord{}, provisionFailureOf(ProvisionEffectNotDispatched, "读取数据库登记失败，未创建实例；请稍后重试")
	}
	for _, row := range rows {
		if row.ContainerName == spec.name {
			return databaseRecord{}, provisionFailureOf(ProvisionEffectNotDispatched, "容器名称 "+spec.name+" 已被登记使用，未创建实例")
		}
	}
	tier, ok := shared.ResourceTierByName(spec.tier)
	if !ok {
		return databaseRecord{}, provisionFailureOf(ProvisionEffectNotDispatched, "资源档位无效，未创建实例")
	}
	memory, reason := s.sampleHostMemory(ctx)
	if message := shared.CapacityRejection(memory, reason, " "+tier.Name+" 档", tier.MemoryBytes); message != "" {
		return databaseRecord{}, provisionFailureOf(ProvisionEffectNotDispatched, message)
	}
	admin := databaseSecret{Username: defaultAdminUsername(engine, nil), Password: randomAdminPassword()}
	var hostPort *int
	if spec.networkScope == scopeAnyHost {
		port := spec.hostPort
		hostPort = &port
	}
	row := databaseRecord{ID: newUUID(), Engine: engine, Name: spec.name, VersionTag: version,
		Source: sourceManaged, AccessScope: spec.networkScope, Admin: admin, CreatedAt: isoNow(s.deps.now),
		State: stateNeedsAttention, ContainerName: spec.name, ResourceTier: spec.tier}
	recordCreated := func(id, volume string) error {
		if recordInstance != nil {
			if err := recordInstance(id); err != nil {
				return err
			}
		}
		row.ContainerID, row.VolumeName = id, volume
		return s.deps.registry.put(row)
	}
	created, err := s.deps.docker.create(ctx, createInput{
		engine: engine, versionTag: version, imageID: imageID, containerName: spec.name, accessScope: spec.networkScope,
		hostPort: hostPort, bootstrapPwd: admin.Password, onCreated: recordCreated,
		tier: spec.tier, memoryBytes: tier.MemoryBytes, nanoCpus: tier.NanoCpus, pidsLimit: 256,
	})
	if err != nil {
		var invalid *shared.InvalidRequestError
		var preflight *instanceCreatePreflightError
		if errors.As(err, &invalid) && invalid.Message != "" {
			return databaseRecord{}, provisionFailureOf(ProvisionEffectNotDispatched, invalid.Message+"，未创建实例")
		}
		if errors.As(err, &preflight) {
			return databaseRecord{}, provisionFailureOf(ProvisionEffectNotDispatched, preflight.Error())
		}
		return row, err
	}
	if !containerIDPattern.MatchString(created.containerID) {
		return row, errors.New("数据库容器身份未得到确认")
	}
	if row.ContainerID == "" {
		if err := recordCreated(created.containerID, created.volumeName); err != nil {
			return row, err
		}
	}
	if !created.started {
		if err := s.deps.docker.removeManaged(ctx, created.containerID, created.volumeName, engine, version); err != nil {
			return row, err
		}
		// removeManaged 返回成功不代表资源真的消失了：回读确认容器与卷都已 404 才算无变更。
		if err := s.deps.docker.verifyRemoved(ctx, created.containerID, created.volumeName); err != nil {
			return row, err
		}
		if err := s.deps.registry.remove(row.ID); err != nil {
			return row, err
		}
		return row, provisionFailureOf(ProvisionEffectNoChange, "数据库实例启动失败（常见原因是宿主端口被占用），已回滚并删除本次创建的容器与卷")
	}
	row.State = stateActive
	if err := s.deps.registry.put(row); err != nil {
		return row, err
	}
	return row, nil
}

// registerLogicalPending 在执行之前把逻辑库登记为 pending 并返回实际执行的意图。同一实例上
// 已有的同名登记属于之前被打断的部署：沿用其用户名与已生成的密码，重试因此幂等。
func (s *databaseService) registerLogicalPending(ctx context.Context, instanceID string, plan logicalPlan, requestID string) (logicalDatabaseRecord, logicalPlan, error) {
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	rows, err := s.deps.registry.list()
	if err != nil {
		// 登记读取是建库前的最后一步只读操作：失败时没有任何变更，归为未派发。
		return logicalDatabaseRecord{}, plan, provisionFailureOf(ProvisionEffectNotDispatched, "读取数据库登记失败，未执行建库建用户；请稍后重试")
	}
	for i := range rows {
		if rows[i].ContainerID != instanceID {
			continue
		}
		for j, existing := range rows[i].Logical {
			if existing.Name != plan.database || len(existing.Users) == 0 {
				continue
			}
			if existing.State != logicalStatePending {
				return logicalDatabaseRecord{}, plan, errors.New("逻辑库登记已经完成，未再次执行")
			}
			plan.username, plan.password = existing.Users[0].Username, existing.Users[0].Password
			if existing.RequestID != requestID {
				existing.RequestID = requestID
				rows[i].Logical[j] = existing
				if err := s.deps.registry.put(rows[i]); err != nil {
					return logicalDatabaseRecord{}, plan, err
				}
			}
			return existing, plan, nil
		}
		plan.password = generateLogicalPassword()
		kind, prefix := logicalKindDatabase, ""
		if rows[i].Engine == engineRedis {
			kind, prefix = logicalKindACLUser, plan.database
		}
		record := logicalDatabaseRecord{ID: newUUID(), Kind: kind, Name: plan.database,
			Users:     []logicalUser{{Username: plan.username, Password: plan.password, Host: "%"}},
			KeyPrefix: prefix, State: logicalStatePending, RequestID: requestID, CreatedBy: logicalCreatedByAgent, CreatedAt: isoNow(s.deps.now)}
		rows[i].Logical = append(rows[i].Logical, record)
		return record, plan, s.deps.registry.put(rows[i])
	}
	return logicalDatabaseRecord{}, plan, errors.New("数据库实例登记缺失，未执行建库建用户")
}

func (s *databaseService) activateLogical(ctx context.Context, instanceID, recordID string) error {
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	rows, err := s.deps.registry.list()
	if err != nil {
		return err
	}
	for i := range rows {
		if rows[i].ContainerID != instanceID {
			continue
		}
		for j := range rows[i].Logical {
			if rows[i].Logical[j].ID == recordID {
				rows[i].Logical[j].State = logicalStateActive
				return s.deps.registry.put(rows[i])
			}
		}
	}
	return errors.New("逻辑库登记缺失，无法确认创建结果")
}

// instanceReceiptView 取实例投影用于回执；列不出来时用登记行拼最小投影。
func (s *databaseService) instanceReceiptView(ctx context.Context, instanceID string, created *databaseRecord) InstanceView {
	if instances, err := s.ListInstances(ctx); err == nil {
		for _, view := range instances {
			if view.ID == instanceID {
				return view
			}
		}
	}
	if created != nil {
		return InstanceView{ID: created.ContainerID, Name: created.ContainerName, Engine: created.Engine, Version: created.VersionTag,
			Status: statusRunning, Ownership: instanceManaged, ResourceTier: created.ResourceTier, Official: true, Reusable: true, Databases: []logicalDatabaseView{}}
	}
	return InstanceView{ID: instanceID, Databases: []logicalDatabaseView{}}
}

// generateLogicalPassword 生成 24 随机字节的十六进制密码：只含字母数字，可安全进入 SQL 字面量。
func generateLogicalPassword() string {
	var buffer [24]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		panic("无法生成数据库用户密码：" + err.Error())
	}
	return hex.EncodeToString(buffer[:])
}

// DecodeProvisionInput 从工具参数取出部署意图。数值按无损整数解释（3306.0 与 3.306e3 都是
// 3306），缺失的可选项保持零值；装配层的核实入口与工具层共用，保证两边算出同一份请求摘要。
func DecodeProvisionInput(args map[string]any) (ProvisionInput, error) {
	var input ProvisionInput
	for _, field := range []struct {
		key    string
		target *string
	}{{"engine", &input.Engine}, {"version", &input.Version}, {"database", &input.Database}, {"username", &input.Username},
		{"instance", &input.Instance}, {"instanceName", &input.InstanceName}, {"resourceTier", &input.ResourceTier},
		{"networkScope", &input.NetworkScope}, {"requestId", &input.RequestID}} {
		if value, ok := args[field.key].(string); ok {
			*field.target = value
		}
	}
	if value, ok := args["newInstance"].(bool); ok {
		input.NewInstance = value
	}
	port, ok := provisionInteger(args["hostPort"])
	if !ok && args["hostPort"] != nil {
		return ProvisionInput{}, errors.New("hostPort 必须是可表示的整数")
	}
	input.HostPort = port
	return input, nil
}

// provisionInteger 把 JSON 数值的各种无损形态解释为整数。
func provisionInteger(value any) (int, bool) {
	switch number := value.(type) {
	case nil:
		return 0, true
	case int:
		return number, true
	case int64:
		return int(number), number == int64(int(number))
	case float64:
		return int(number), number == float64(int(number))
	case json.Number:
		parsed, err := number.Int64()
		return int(parsed), err == nil && parsed == int64(int(parsed))
	}
	return 0, false
}
