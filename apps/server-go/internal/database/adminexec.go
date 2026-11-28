package database

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// 容器内管理命令执行：凭据只经 exec 的 Env 传递，argv 里只出现固定客户端与变量引用；
// 输出各有上限，只用于就绪判断与回读确认，不进入任何对外文案。

// adminExecOutputLimit 是 stdout 与 stderr 合计保留的上限。
const adminExecOutputLimit = 8 << 10

type logicalPreflightError struct{ error }

type logicalWriteEndedError struct{ error }

var errAdminExecUnconfirmed = errors.New("容器内命令没有得到确认的退出状态")

// adminExec 是一次容器内管理命令。
type adminExec struct {
	containerID string
	argv        []string
	env         []string
	timeout     time.Duration
	writeStep   string
	firstWrite  bool
}

// adminTarget 是实例内管理操作的目标与管理员身份；凭据只在服务内部传递。
type adminTarget struct {
	containerID string
	engine      string
	admin       databaseSecret
}

// logicalExistence 是实例内只读核对的结果：目标库与用户是否已经存在，以及已存在的用户能否用
// 登记密码登录（说明它是面板先前建的）。只用于判断能否安全地继续，不改动任何东西。
type logicalExistence struct {
	Database         bool
	User             bool
	PasswordMatches  bool
	PermissionsMatch bool
}

// adminBackend 是实例内管理操作的执行面：等实例可登录，以及在其中建库建用户。
type adminBackend interface {
	// verify 用给定凭据做一次只读登录核验；失败即凭据错误，不重试。
	verify(ctx context.Context, target adminTarget) error
	// inspectLogical 只读核对目标库与用户在实例里是否已存在；密码只用于一次登录尝试。
	inspectLogical(ctx context.Context, target adminTarget, plan logicalPlan) (logicalExistence, error)
	// waitReady 等待实例可登录（新建实例后官方镜像初始化需要时间）。
	waitReady(ctx context.Context, target adminTarget) error
	createLogical(ctx context.Context, target adminTarget, plan logicalPlan) error
}

func (d *dockerAPI) verify(ctx context.Context, target adminTarget) error {
	switch target.engine {
	case engineMySQL, engineMariaDB:
		ready, err := d.mysqlReady(ctx, target.containerID, target.admin)
		if err != nil {
			return err
		}
		if !ready {
			return errors.New("数据库拒绝该凭据的管理员登录")
		}
		return nil
	case engineRedis:
		result, err := d.exec(ctx, adminExec{containerID: target.containerID, argv: redisClientArgs("PING"), env: []string{"REDISCLI_AUTH=" + target.admin.Password}, timeout: redisCommandTimeout})
		if err != nil {
			return err
		}
		if result.exitCode != 0 || !strings.Contains(result.stdout, "PONG") {
			return errors.New("Redis 拒绝该凭据的管理员登录")
		}
		return nil
	}
	return errors.New("该引擎暂不支持凭据核验")
}

func (d *dockerAPI) waitReady(ctx context.Context, target adminTarget) error {
	switch target.engine {
	case engineMySQL, engineMariaDB:
		return d.waitMySQLReady(ctx, target.containerID, target.admin)
	case engineRedis:
		return d.waitRedisReady(ctx, target.containerID, target.admin)
	}
	return errors.New("该引擎暂不支持实例内管理操作")
}

func (d *dockerAPI) createLogical(ctx context.Context, target adminTarget, plan logicalPlan) error {
	switch target.engine {
	case engineMySQL, engineMariaDB:
		return d.createMySQLLogical(ctx, target, plan)
	case engineRedis:
		return d.createRedisACLUser(ctx, target.containerID, target.admin, plan)
	}
	return errors.New("该引擎暂不支持实例内管理操作")
}

func (d *dockerAPI) inspectLogical(ctx context.Context, target adminTarget, plan logicalPlan) (logicalExistence, error) {
	switch target.engine {
	case engineMySQL, engineMariaDB:
		return d.inspectMySQLLogical(ctx, target, plan)
	case engineRedis:
		return d.inspectRedisLogical(ctx, target, plan)
	}
	return logicalExistence{}, errors.New("该引擎暂不支持实例内管理操作")
}

// adminResult 是确认退出后的结果；stderr 只用于本地诊断。
type adminResult struct {
	exitCode int
	stdout   string
	stderr   string
}

// exec 在容器内执行命令并确认退出状态。创建被拒、输出流不完整或退出状态无法确认都报错，
// 调用方不得把它当作「命令已结束」。
func (d *dockerAPI) exec(ctx context.Context, input adminExec) (adminResult, error) {
	beforeStart := func(err error) (adminResult, error) {
		if input.firstWrite {
			return adminResult{}, &logicalPreflightError{errors.New("容器内管理命令未启动")}
		}
		if input.writeStep != "" {
			return adminResult{}, &logicalWriteEndedError{errors.New("下一条容器内管理命令未启动")}
		}
		return adminResult{}, err
	}
	// 请求体交给 request 序列化一次；它接收任意值，传入已编码的字节会被再次编码。
	created, err := d.request(ctx, "POST", "/containers/"+input.containerID+"/exec", nil,
		map[string]any{"AttachStdin": false, "AttachStdout": true, "AttachStderr": true, "Tty": false, "Privileged": false, "Cmd": input.argv, "Env": input.env})
	if err != nil {
		return beforeStart(err)
	}
	var receipt struct {
		ID string `json:"Id"`
	}
	if created.Status != 201 || json.Unmarshal(created.Body, &receipt) != nil || !containerIDPattern.MatchString(receipt.ID) {
		return beforeStart(errAdminExecUnconfirmed)
	}
	if err := ctx.Err(); err != nil {
		return beforeStart(err)
	}
	write := provisionWrite{Stage: input.writeStep, InstanceID: input.containerID, ExecID: receipt.ID}
	if input.writeStep != "" {
		if err := recordProvisionWrite(ctx, write); err != nil {
			return adminResult{}, err
		}
	}
	output := shared.NewExecOutput(adminExecOutputLimit)
	stream, err := d.transport.Stream(ctx, seam.EngineRequest{Method: "POST", Path: "/exec/" + receipt.ID + "/start", Body: []byte(`{"Detach":false,"Tty":false}`), DiscardBody: true, Timeout: input.timeout}, output.Consume)
	if err != nil {
		return adminResult{}, err
	}
	exit, err := d.inspectAdminExec(ctx, receipt.ID, input.containerID)
	if err != nil || stream.Status != 200 || output.Invalid() || output.Incomplete() {
		return adminResult{}, errAdminExecUnconfirmed
	}
	if input.writeStep != "" {
		write.Finished = true
		if err := recordProvisionWrite(ctx, write); err != nil {
			return adminResult{}, err
		}
	}
	return adminResult{exitCode: exit, stdout: string(output.Stdout()), stderr: string(output.Stderr())}, nil
}

func (d *dockerAPI) inspectAdminExec(ctx context.Context, execID, containerID string) (int, error) {
	if !containerIDPattern.MatchString(execID) || !containerIDPattern.MatchString(containerID) {
		return 0, errAdminExecUnconfirmed
	}
	inspected, err := d.request(ctx, "GET", "/exec/"+execID+"/json", nil, nil)
	if err != nil {
		return 0, err
	}
	var status struct {
		Running     *bool
		ExitCode    *int
		ContainerID string
	}
	if inspected.Status != 200 || json.Unmarshal(inspected.Body, &status) != nil ||
		status.Running == nil || *status.Running || status.ExitCode == nil || status.ContainerID != containerID {
		return 0, errAdminExecUnconfirmed
	}
	return *status.ExitCode, nil
}
