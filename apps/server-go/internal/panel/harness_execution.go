package panel

import (
	"context"
	"fmt"
	"os"

	"elysian/server/internal/agent/harness/sessionstore"
	"elysian/server/internal/seam"
)

// AgentExecutionRecoveryRequired 先核对 Agent 配置，再检查持久化的未决执行事实。
func AgentExecutionRecoveryRequired(root string, recovery seam.AgentExecutionRecovery, inspector sessionstore.Inspector) (bool, error) {
	required, err := recovery.ConfigRequiresRecovery(root)
	if err != nil || required {
		return required, err
	}
	return preserveAgentFacts(root, inspector)
}

func (h SystemHost) recoverAgentExecution(ctx context.Context) error {
	required, err := AgentExecutionRecoveryRequired(h.Store.Root, h.AgentRecovery, h.Store.Inspector)
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
	return h.AgentRecovery.RecoverManagedContainers(ctx, socket, binary)
}
