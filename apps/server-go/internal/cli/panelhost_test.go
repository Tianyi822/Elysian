package cli

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// panelhost 测试（CLI 方案 §3.1／§8）：panel home 解析次序（env → 生产 → $HOME）、
// health 探测的端口回退与形态分类（可达／连接拒绝回退／双拒绝判未启动／非 200 不
// 回退判连接异常／端口配置损坏）。探测走真实回环 HTTP（httptest）。

func TestResolvePanelHomeOrder(t *testing.T) {
	// 1. ELYSIAN_PANEL_HOME 显式覆盖：即使生产目录存在也以 env 为准。
	home, err := resolvePanelHome(
		func(string) string { return "/tmp/override-home" },
		func(string) bool { return true },
		func() (string, error) { return "/home/dev", nil })
	if err != nil || home != "/tmp/override-home" {
		t.Fatalf("env 覆盖应最优先：(\"%s\", %v)", home, err)
	}

	// 2. 无 env、生产目录存在：取 /var/lib/elysian/.Elysian。
	home, err = resolvePanelHome(
		func(string) string { return "" },
		func(p string) bool { return p == productionPanelHome },
		func() (string, error) { return "/home/dev", nil })
	if err != nil || home != productionPanelHome {
		t.Fatalf("生产目录存在应取生产路径：(\"%s\", %v)", home, err)
	}

	// 3. 无 env、无生产目录：回落 $HOME/.Elysian（开发裸跑）。
	home, err = resolvePanelHome(
		func(string) string { return "" },
		func(string) bool { return false },
		func() (string, error) { return "/home/dev", nil })
	if err != nil || home != "/home/dev/.Elysian" {
		t.Fatalf("开发形态应取 $HOME/.Elysian：(\"%s\", %v)", home, err)
	}

	// 4. home 解析失败：中文错误。
	_, err = resolvePanelHome(
		func(string) string { return "" },
		func(string) bool { return false },
		func() (string, error) { return "", fmt.Errorf("boom") })
	if err == nil || !strings.Contains(err.Error(), "无法解析用户主目录") {
		t.Fatalf("home 解析失败应上抛中文错误：%v", err)
	}
}

// srvPort 取 httptest 服务监听的回环端口。
func srvPort(t *testing.T, srv *httptest.Server) int {
	t.Helper()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatal(err)
	}
	return port
}

// deadPort 取一个确定无人监听的回环端口（先占位再释放）。
func deadPort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return port
}

// writeNetworkConfig 在面板数据根下写 panel-network.json（config.ReadPanelNetwork 同形状）。
func writeNetworkConfig(t *testing.T, home string, backendPort int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(home, "config"), 0o700); err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"frontendPort":48100,"backendPort":%d}`+"\n", backendPort)
	if err := os.WriteFile(filepath.Join(home, "config", "panel-network.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestProbePanelReachablePrefersHealthPorts(t *testing.T) {
	// health 回传的 backendPort 与实际监听端口不同时，以回传值为准（端口迁移窗口）。
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, `{"ok":true,"ready":false,"commit":"deadbeef","ports":{"frontendPort":48100,"backendPort":49999}}`)
	}))
	defer srv.Close()
	home := t.TempDir()
	writeNetworkConfig(t, home, srvPort(t, srv))
	st := probePanelAt(context.Background(), home, defaultBackendPort)
	if st.kind != panelReachable {
		t.Fatalf("应判可达：%+v", st)
	}
	if st.commit != "deadbeef" {
		t.Errorf("应回传面板 commit：%q", st.commit)
	}
	if st.baseURL != "http://127.0.0.1:49999" {
		t.Errorf("后端地址应以 health 回传端口为准：%q", st.baseURL)
	}
}

func TestProbePanelFallsBackToDefaultPort(t *testing.T) {
	// panel-network.json 指向的端口无人监听（连接拒绝）→ 回退默认端口探测一次。
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"ok":true,"ready":true,"commit":"cafe123","ports":{"frontendPort":48100,"backendPort":48101}}`)
	}))
	defer srv.Close()
	home := t.TempDir()
	writeNetworkConfig(t, home, deadPort(t))
	st := probePanelAt(context.Background(), home, srvPort(t, srv)) // 回退端口注入为健康服务
	if st.kind != panelReachable || st.commit != "cafe123" {
		t.Fatalf("连接拒绝应回退默认端口并判可达：%+v", st)
	}
}

func TestProbePanelNotRunningWhenAllRefused(t *testing.T) {
	home := t.TempDir()
	writeNetworkConfig(t, home, deadPort(t))
	st := probePanelAt(context.Background(), home, deadPort(t))
	if st.kind != panelNotRunning {
		t.Fatalf("双候选均连接拒绝应判未启动：%+v", st)
	}
}

func TestProbePanelHTTPErrorDoesNotFallBack(t *testing.T) {
	// 非 200（运行失败形态）不回退默认端口，直接判连接异常并保留原始详情。
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"ok":true}`)
	}))
	defer healthy.Close()
	home := t.TempDir()
	writeNetworkConfig(t, home, srvPort(t, srv))
	st := probePanelAt(context.Background(), home, srvPort(t, healthy))
	if st.kind != panelUnreachable {
		t.Fatalf("非 200 应判连接异常且不回退：%+v", st)
	}
	if !strings.Contains(st.detail, "健康检查返回 500") {
		t.Errorf("应保留原始状态详情：%q", st.detail)
	}
}

func TestProbePanelCorruptNetworkConfig(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, "config"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config", "panel-network.json"), []byte("{bad"), 0o600); err != nil {
		t.Fatal(err)
	}
	st := probePanelAt(context.Background(), home, defaultBackendPort)
	if st.kind != panelUnreachable || !strings.Contains(st.detail, "面板端口配置损坏") {
		t.Fatalf("端口配置损坏应判连接异常并带中文详情：%+v", st)
	}
}
