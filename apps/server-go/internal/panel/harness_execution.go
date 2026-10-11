package panel

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"elysian/server/internal/agent/execution"
)

// AgentExecutionRecoveryRequired 供启动与维护共用。历史配置包含全部修订，
// 停用并不证明旧容器已停止；完全未配置执行能力的安装不要求 Docker。
func AgentExecutionRecoveryRequired(root string) (bool, error) {
	var executionConfig struct {
		Schema   int               `json:"schema"`
		Profiles []json.RawMessage `json:"profiles"`
	}
	present, err := readAgentRecoveryConfig(filepath.Join(root, "config", "agent", "execution.json"), &executionConfig)
	if err != nil {
		return false, err
	}
	if present && (executionConfig.Schema != 1 || executionConfig.Profiles == nil) {
		return false, fmt.Errorf("Agent 执行配置格式未知，不能确认遗留容器已停止")
	}
	if len(executionConfig.Profiles) > 0 {
		return true, nil
	}
	var mcpConfig struct {
		Version int `json:"version"`
		Servers []struct {
			Transport string          `json:"transport"`
			Stdio     json.RawMessage `json:"stdio"`
		} `json:"servers"`
	}
	present, err = readAgentRecoveryConfig(filepath.Join(root, "config", "agent", "mcp-servers.json"), &mcpConfig)
	if err != nil {
		return false, err
	}
	if present && (mcpConfig.Version != 1 || mcpConfig.Servers == nil) {
		return false, fmt.Errorf("MCP 配置格式未知，不能确认遗留容器已停止")
	}
	for _, server := range mcpConfig.Servers {
		if server.Transport == "container-stdio" || len(server.Stdio) > 0 && string(server.Stdio) != "null" {
			return true, nil
		}
	}
	return preserveAgentFacts(root)
}

func readAgentRecoveryConfig(path string, target any) (bool, error) {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > 32<<20 {
		return false, fmt.Errorf("无法核对 Agent 执行配置，不能确认遗留容器已停止")
	}
	file, err := os.Open(path)
	if err != nil {
		return false, fmt.Errorf("无法读取 Agent 执行配置，不能确认遗留容器已停止")
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, (32<<20)+1))
	if err != nil || len(content) > 32<<20 || json.Unmarshal(content, target) != nil {
		return false, fmt.Errorf("Agent 执行配置损坏，不能确认遗留容器已停止")
	}
	return true, nil
}

func (h SystemHost) recoverAgentExecution(ctx context.Context) error {
	required, err := AgentExecutionRecoveryRequired(h.Store.Root)
	if err != nil {
		return err
	}
	socket := h.DockerSocket
	if socket == "" {
		socket = "/var/run/docker.sock"
	}
	if _, socketErr := os.Stat(socket); socketErr == nil {
		required = true
	} else if !os.IsNotExist(socketErr) {
		return fmt.Errorf("无法核对 Docker 通道，不能确认遗留执行容器已停止：%w", socketErr)
	}
	if !required {
		return nil
	}
	binary, err := os.Executable()
	if err != nil {
		return fmt.Errorf("无法定位执行器，不能确认遗留执行容器已停止：%w", err)
	}
	executor, err := execution.New(execution.Options{SocketPath: socket, SupervisorPath: binary})
	if err != nil {
		return err
	}
	defer executor.Close(context.Background())
	recoverCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := executor.Recover(recoverCtx); err != nil {
		return fmt.Errorf("受管执行容器停止未确认，面板维护已暂停：%w", err)
	}
	return nil
}
