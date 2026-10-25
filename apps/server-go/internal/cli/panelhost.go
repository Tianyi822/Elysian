package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"syscall"
	"time"

	"elysian/server/internal/config"
)

// 面板发现（CLI 方案 §3.1）：后端端口唯一来源是 panel-network.json，ely 不硬编码
// 48101；解析次序 ELYSIAN_PANEL_HOME → 正式安装 STATE_DIR → $HOME/.Elysian。探测经
// 鉴权豁免的 GET /api/health（bare-metal 回传 {ok,ready,commit,ports}，其余模式只回
// ok），以 health 实际回传的 ports.backendPort 为准（覆盖端口迁移窗口），连接拒绝才
// 回退默认端口再试一次。

const (
	// envPanelHome 显式覆盖面板数据根（测试与非标准部署）。
	envPanelHome = "ELYSIAN_PANEL_HOME"
	// productionPanelHome 正式安装（install.sh STATE_DIR）的面板数据根。
	productionPanelHome = "/var/lib/elysian/.Elysian"
	// defaultBackendPort 后端默认端口（panel-network.json 缺失时的候选回退）。
	defaultBackendPort = 48101
)

// resolvePanelHome 解析面板数据根（.Elysian 目录）：ELYSIAN_PANEL_HOME 显式覆盖 →
// /var/lib/elysian/.Elysian（存在即生产安装）→ $HOME/.Elysian（开发裸跑）。
func resolvePanelHome(getenv func(string) string, fileExists func(string) bool, userHome func() (string, error)) (string, error) {
	if v := getenv(envPanelHome); v != "" {
		return v, nil
	}
	if fileExists(productionPanelHome) {
		return productionPanelHome, nil
	}
	home, err := userHome()
	if err != nil {
		return "", fmt.Errorf("无法解析用户主目录：%w", err)
	}
	return filepath.Join(home, ".Elysian"), nil
}

// isProductionPanelHome 报告路径是否为生产安装的面板数据根（重置密码本地授权门禁的
// 判定口径：该路径下改密须 root/sudo）。
func isProductionPanelHome(home string) bool { return home == productionPanelHome }

// panelStatusKind 面板探测结果分类（五态区分中菜单头部消费的子集）。
type panelStatusKind int

const (
	panelProbing panelStatusKind = iota
	panelReachable
	panelNotRunning
	panelUnreachable
)

// panelStatus 面板探测事实：可达时携带 commit 与实际后端地址，异常时携带中文 detail。
type panelStatus struct {
	kind    panelStatusKind
	commit  string
	baseURL string
	detail  string
}

// panelStatusMsg probePanelCmd 的回填消息。
type panelStatusMsg panelStatus

// healthReply /api/health 回传形状（bare-metal 完整；其余模式仅 ok）。
type healthReply struct {
	OK     bool   `json:"ok"`
	Ready  bool   `json:"ready"`
	Commit string `json:"commit"`
	Ports  struct {
		FrontendPort int `json:"frontendPort"`
		BackendPort  int `json:"backendPort"`
	} `json:"ports"`
}

// errPanelRefused 连接拒绝（端口无人监听）的分类标记：唯一触发默认端口回退重试的形态。
var errPanelRefused = errors.New("connection refused")

// healthHTTPClient 探测专用客户端：单请求短超时，不复用长连接，不进 CLI 主流程复用。
var healthHTTPClient = &http.Client{Timeout: 1200 * time.Millisecond}

// probePanelAt 在给定面板数据根下探测后端：读 panel-network.json 得候选端口 → GET
// /api/health → 连接拒绝且候选非默认端口时回退默认端口再试一次；两次均拒绝判未启动，
// 超时／非 HTTP／非 200 判连接异常（不回退，避免掩盖真实故障形态）。
func probePanelAt(ctx context.Context, home string, fallbackPort int) panelStatus {
	ports, err := config.ReadPanelNetwork(filepath.Join(home, "config", "panel-network.json"))
	if err != nil {
		// ReadPanelNetwork 的错误消息自带「面板端口配置…」中文前缀。
		return panelStatus{kind: panelUnreachable, detail: err.Error()}
	}
	candidates := []int{ports.BackendPort}
	if fallbackPort != ports.BackendPort {
		candidates = append(candidates, fallbackPort)
	}
	var last panelStatus
	for _, port := range candidates {
		reply, err := fetchHealth(ctx, port)
		if err == nil {
			// 以 health 实际回传的后端端口为准（覆盖端口迁移窗口）。
			actual := port
			if reply.Ports.BackendPort != 0 {
				actual = reply.Ports.BackendPort
			}
			return panelStatus{kind: panelReachable, commit: reply.Commit, baseURL: fmt.Sprintf("http://127.0.0.1:%d", actual)}
		}
		last = panelStatus{kind: panelUnreachable, detail: err.Error()}
		if !errors.Is(err, errPanelRefused) {
			return last
		}
	}
	last.kind = panelNotRunning
	last.detail = ""
	return last
}

// fetchHealth 对指定端口发起 GET /api/health 并解析回传。
func fetchHealth(ctx context.Context, port int) (healthReply, error) {
	url := fmt.Sprintf("http://127.0.0.1:%d/api/health", port)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return healthReply{}, err
	}
	resp, err := healthHTTPClient.Do(req)
	if err != nil {
		if errors.Is(err, syscall.ECONNREFUSED) {
			return healthReply{}, errPanelRefused
		}
		return healthReply{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return healthReply{}, fmt.Errorf("健康检查返回 %s", resp.Status)
	}
	var reply healthReply
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&reply); err != nil {
		return healthReply{}, fmt.Errorf("健康检查响应解析失败：%w", err)
	}
	return reply, nil
}
