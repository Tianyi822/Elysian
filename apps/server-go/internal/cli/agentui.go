package cli

import (
	"context"

	"elysian/server/internal/cli/client"
	"elysian/server/internal/cli/tui"
)

// Agent 终端的装配（CLI 方案 §6.1）：cli 根包把面板发现（panelhost）、本地持久化
// （cliStore）与 HTTP 客户端（client）适配为 tui.Deps；tui 包自身不 import cli，
// 依赖方向保持 cli → tui 单向。

// productionTUIDeps 组装 Agent 终端生产依赖：后端发现复用菜单同款探测（panelStatus
// 映射五态错误）；凭据与指针落 $HOME/.elysian/cli/。
func productionTUIDeps(d deps) tui.Deps {
	return tui.Deps{
		Discover: func(ctx context.Context) (string, error) {
			return discoverBackend(ctx, d)
		},
		Dial: func(baseURL string) tui.API {
			return client.New(baseURL)
		},
		LoadCreds: func() (string, string, error) {
			store, err := newCLIStore("")
			if err != nil {
				return "", "", err
			}
			stored, err := store.ReadSession()
			return stored.BaseURL, stored.Cookie, err
		},
		SaveCreds: func(baseURL, cookie string) error {
			store, err := newCLIStore("")
			if err != nil {
				return err
			}
			return store.WriteSession(StoredSession{BaseURL: baseURL, Cookie: cookie})
		},
		ClearCreds: func() error {
			store, err := newCLIStore("")
			if err != nil {
				return err
			}
			return store.ClearSession()
		},
		LoadState: func() tui.StoredState {
			store, err := newCLIStore("")
			if err != nil {
				return tui.StoredState{}
			}
			state, err := store.ReadState()
			if err != nil {
				return tui.StoredState{}
			}
			return tui.StoredState{Selected: state.SelectedSessionID, Levels: state.ReasoningLevels, PermissionModes: state.PermissionModes, Drafts: state.Drafts}
		},
		SaveState: func(state tui.StoredState) error {
			store, err := newCLIStore("")
			if err != nil {
				return err
			}
			return store.WriteState(StoredState{SelectedSessionID: state.Selected, ReasoningLevels: state.Levels, PermissionModes: state.PermissionModes, Drafts: state.Drafts})
		},
	}
}

// discoverBackend 解析面板数据根并探测后端地址；探测结果映射为 client 五态错误
// （未启动／连接异常），供 TUI 连接错误屏呈现。
func discoverBackend(ctx context.Context, d deps) (string, error) {
	home, err := resolvePanelHome(d.getenv, d.fileExists, d.userHome)
	if err != nil {
		return "", &client.Error{Kind: client.KindUnreachable, Message: err.Error(), Hint: client.HintFor(client.KindUnreachable)}
	}
	status := probePanelAt(ctx, home, defaultBackendPort)
	switch status.kind {
	case panelReachable:
		return status.baseURL, nil
	case panelNotRunning:
		return "", &client.Error{Kind: client.KindNotRunning, Message: "面板后端连接被拒绝", Hint: client.HintFor(client.KindNotRunning)}
	default:
		message := "无法连接面板后端"
		if status.detail != "" {
			message += "：" + status.detail
		}
		return "", &client.Error{Kind: client.KindUnreachable, Message: message, Hint: client.HintFor(client.KindUnreachable)}
	}
}
