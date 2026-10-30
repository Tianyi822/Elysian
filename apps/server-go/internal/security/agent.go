package security

import (
	"context"
	"errors"
)

// AgentFacade shares the HTTP services but exposes no host credential mutation.
type AgentFacade struct {
	authorize func(context.Context) error
	ssh       sshAPI
	users     usersAPI
}

func NewAgentFacade(deps Deps) *AgentFacade {
	f := &AgentFacade{authorize: deps.AgentAuthorize}
	if !deps.Available {
		return f
	}
	f.ssh, f.users = deps.ssh, deps.users
	if f.ssh == nil {
		f.ssh = newSshService(newConfiguredSshDeps(deps))
	}
	if f.users == nil {
		f.users = newUsersService(newRealUsersDeps(deps.Now))
	}
	return f
}

func (f *AgentFacade) Available() bool { return f != nil && f.ssh != nil && f.users != nil }

func (f *AgentFacade) check(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !f.Available() || f.authorize == nil {
		return errors.New("安全管理能力未就绪")
	}
	return f.authorize(ctx)
}

func (f *AgentFacade) Snapshot(ctx context.Context) (any, error) {
	if err := f.check(ctx); err != nil {
		return nil, err
	}
	overview, err := f.ssh.Overview()
	if err != nil {
		return nil, errors.New("读取 SSH 状态失败")
	}
	settings, err := f.ssh.Settings()
	if err != nil {
		return nil, errors.New("读取 SSH 设置失败")
	}
	root, err := f.ssh.RootAuth()
	if err != nil {
		return nil, errors.New("读取 Root 认证状态失败")
	}
	key := map[string]any{"present": root.Key != nil}
	if root.Key != nil {
		key["algorithm"], key["fingerprint"] = root.Key.Algorithm, root.Key.Fingerprint
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return map[string]any{"ssh": overview, "settings": settings, "rootPolicy": root.Policy, "rootKey": key}, nil
}

func (f *AgentFacade) Users(ctx context.Context) (any, error) {
	if err := f.check(ctx); err != nil {
		return nil, err
	}
	rows, err := f.users.List()
	if err != nil {
		return nil, errors.New("读取托管账号失败")
	}
	truncated := len(rows) > 200
	if truncated {
		rows = rows[:200]
	}
	for i := range rows {
		rows[i].Note = nil
	}
	return map[string]any{"users": rows, "truncated": truncated}, ctx.Err()
}

func (f *AgentFacade) LoginRecords(ctx context.Context) (any, error) {
	if err := f.check(ctx); err != nil {
		return nil, err
	}
	rows, err := f.ssh.ListLoginRecords()
	if err != nil {
		return nil, errors.New("读取 SSH 登录记录失败")
	}
	truncated := len(rows) > 200
	if truncated {
		rows = rows[:200]
	}
	return map[string]any{"records": rows, "truncated": truncated}, ctx.Err()
}
