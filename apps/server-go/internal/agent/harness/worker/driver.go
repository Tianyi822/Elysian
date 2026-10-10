package worker

import (
	"context"
	"errors"
)

const batchDriverName = "tool-batch"
const batchDriverVersion = 1

// Driver 是编译期登记的任务执行协议，不从磁盘或请求装载外来代码。
type Driver interface {
	Name() string
	Version() int
	Validate([]Step) error
	Run(context.Context, []Step, Invoker) error
}

type toolBatchDriver struct{}

func (toolBatchDriver) Name() string { return batchDriverName }
func (toolBatchDriver) Version() int { return batchDriverVersion }
func (toolBatchDriver) Validate(steps []Step) error {
	_, err := copySteps(steps)
	return err
}
func (toolBatchDriver) Run(ctx context.Context, steps []Step, invoke Invoker) error {
	if ctx == nil || invoke == nil {
		return errors.New("任务驱动必须提供上下文与调用器")
	}
	for index, step := range steps {
		if err := ctx.Err(); err != nil {
			return err
		}
		if _, err := invoke(ctx, index, step.Tool, step.Args); err != nil {
			return err
		}
	}
	return ctx.Err()
}

// registeredDriver 是代码注册表的唯一入口；新增驱动须显式修改这里并覆盖测试。
func registeredDriver(name string, version int) (Driver, bool) {
	driver := toolBatchDriver{}
	if name == driver.Name() && version == driver.Version() {
		return driver, true
	}
	return nil, false
}
