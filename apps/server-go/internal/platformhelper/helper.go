// Package platformhelper implements the installer helper using only the standard library.
package platformhelper

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const maximumConfigBytes = 4 << 20

var socketPattern = regexp.MustCompile(`^/[A-Za-z0-9_./-]+$`)
var tcpPattern = regexp.MustCompile(`^(localhost|127\.0\.0\.1|\[::1\]):[0-9]+$`)
var assignmentPattern = regexp.MustCompile(`(?s)^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$`)

func socketPath(value string) (string, error) {
	if !socketPattern.MatchString(value) || strings.Contains(value, "/../") || strings.HasSuffix(value, "/..") {
		return "", errors.New("管理 socket 必须是无空白、冒号、引号及控制字符的绝对路径，且不得包含 .. 路径段")
	}
	return value, nil
}

func readConfig(file string) (map[string]any, error) {
	f, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	body, err := io.ReadAll(io.LimitReader(f, maximumConfigBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maximumConfigBytes {
		return nil, errors.New("Caddy 配置响应超过 4 MiB")
	}
	var value any
	if json.Unmarshal(body, &value) != nil {
		return nil, errors.New("Caddy 配置不是有效 JSON")
	}
	if value == nil {
		return nil, nil
	}
	config, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("Caddy 配置必须是 JSON 对象或 null")
	}
	return config, nil
}

func object(value any) map[string]any   { result, _ := value.(map[string]any); return result }
func servers(config map[string]any) any { return object(object(config["apps"])["http"])["servers"] }

// Preserve the script's JSON truthiness when rejecting disabled admin endpoints.
func truthy(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case bool:
		return v
	case float64:
		return v != 0
	case string:
		return v != ""
	default:
		return true
	}
}

func normalize(value any, temporary, original string) {
	switch item := value.(type) {
	case map[string]any:
		if item["handler"] == "file_server" {
			if hide, ok := item["hide"].([]any); ok {
				for i, path := range hide {
					if path == temporary {
						hide[i] = original
					}
				}
			}
		}
		for _, child := range item {
			normalize(child, temporary, original)
		}
	case []any:
		for _, child := range item {
			normalize(child, temporary, original)
		}
	}
}

type record struct{ key, text string }

func environmentRecords(text string) ([]record, error) {
	lines := strings.SplitAfter(text, "\n")
	var records []record
	for i := 0; i < len(lines); i++ {
		text := lines[i]
		match := assignmentPattern.FindStringSubmatch(text)
		if match == nil {
			records = append(records, record{text: text})
			continue
		}
		value := strings.TrimLeft(match[2], " \t\r\n")
		if len(value) > 0 && (value[0] == '\'' || value[0] == '"') {
			quote, end := value[0], 1
			for {
				for end < len(value) {
					if quote == '"' && value[end] == '\\' {
						end += 2
						continue
					}
					if value[end] == quote {
						break
					}
					end++
				}
				if end < len(value) {
					break
				}
				i++
				if i >= len(lines) {
					return nil, errors.New("EnvironmentFile 存在未闭合引号，拒绝改写")
				}
				text += lines[i]
				value += lines[i]
			}
		} else {
			for strings.HasSuffix(text, "\\\n") || strings.HasSuffix(text, "\\\r\n") {
				i++
				if i >= len(lines) || lines[i] == "" {
					return nil, errors.New("EnvironmentFile 存在未完成的续行，拒绝改写")
				}
				text += lines[i]
			}
		}
		records = append(records, record{match[1], text})
	}
	return records, nil
}
func readEnvironment(file string) ([]record, error) {
	info, err := os.Stat(file)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if info.Size() > 256<<10 {
		return nil, errors.New("EnvironmentFile 超过 256 KiB，拒绝自动读取或改写")
	}
	body, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	return environmentRecords(string(body))
}
func environmentValue(records []record, key string) (string, error) {
	result := ""
	for _, record := range records {
		if record.key != key {
			continue
		}
		value := strings.TrimSpace(strings.SplitN(record.text, "=", 2)[1])
		if len(value) >= 2 && (value[0] == '"' && value[len(value)-1] == '"' || value[0] == '\'' && value[len(value)-1] == '\'') {
			value = value[1 : len(value)-1]
		}
		if value != "" {
			if _, err := socketPath(value); err != nil {
				return "", err
			}
		}
		result = value
	}
	return result, nil
}

func removeStaleSocket(value string) error {
	target, err := socketPath(value)
	if err != nil {
		return err
	}
	for current := target; current != "/"; current = filepath.Dir(current) {
		info, e := os.Lstat(current)
		if e != nil && !os.IsNotExist(e) {
			return e
		}
		if e == nil && info.Mode()&os.ModeSymlink != 0 {
			return errors.New("残留 socket 路径不能经过符号链接")
		}
	}
	before, err := os.Lstat(target)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	stat, ok := before.Sys().(*syscall.Stat_t)
	if !ok || before.Mode()&os.ModeSocket == 0 || stat.Uid != 0 || stat.Nlink != 1 {
		return errors.New("残留路径不是 root 所有的独立 Unix socket，拒绝清理")
	}
	connection, err := net.DialTimeout("unix", target, time.Second)
	if err == nil {
		connection.Close()
		return errors.New("socket 仍有监听者，拒绝删除")
	}
	if !errors.Is(err, syscall.ECONNREFUSED) {
		return errors.New("socket 未明确拒绝连接，保留现场")
	}
	after, err := os.Lstat(target)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	afterStat, ok := after.Sys().(*syscall.Stat_t)
	if !ok || after.Mode()&os.ModeSocket == 0 || afterStat.Uid != 0 || stat.Ino != afterStat.Ino || stat.Dev != afterStat.Dev {
		return errors.New("socket 身份已改变，拒绝删除")
	}
	return os.Remove(target)
}

func waitForCaddy(args []string) error {
	attempts, e1 := strconv.Atoi(args[3])
	interval, e2 := strconv.ParseFloat(args[4], 64)
	timeout, e3 := strconv.ParseFloat(args[5], 64)
	if e1 != nil || e2 != nil || e3 != nil || attempts < 1 || math.IsNaN(interval) || math.IsInf(interval, 0) || interval < 0 || math.IsNaN(timeout) || timeout <= 0 || timeout > 30 {
		return errors.New("Caddy 验证预算无效")
	}
	var connection []string
	if strings.HasPrefix(args[0], "unix:/") {
		path, err := socketPath(strings.TrimPrefix(args[0], "unix:"))
		if err != nil {
			return err
		}
		connection = []string{"--unix-socket", path, "http://localhost/config/"}
	} else if strings.HasPrefix(args[0], "tcp:") && tcpPattern.MatchString(strings.TrimPrefix(args[0], "tcp:")) {
		connection = []string{"http://" + strings.TrimPrefix(args[0], "tcp:") + "/config/"}
	} else {
		return errors.New("Caddy 验证端点无效")
	}
	deadline := time.Now().Add(time.Duration(timeout * float64(time.Second)))
	for attempt := 0; attempt < attempts && time.Now().Before(deadline); attempt++ {
		budget := time.Until(deadline)
		if budget > 5*time.Second {
			budget = 5 * time.Second
		}
		ctx, cancel := context.WithTimeout(context.Background(), budget)
		command := append([]string{"-sS", "--noproxy", "*", "--connect-timeout", "2", "--max-time", strconv.FormatFloat(budget.Seconds(), 'f', -1, 64), "--max-filesize", strconv.Itoa(maximumConfigBytes), "-o", args[1], "-w", "%{http_code}"}, connection...)
		out, err := exec.CommandContext(ctx, "curl", command...).Output()
		cancel()
		if err == nil && string(out) == "200" {
			actual, err := readConfig(args[1])
			if err == nil {
				matches := args[2] == ""
				if !matches {
					expected, e := readConfig(args[2])
					matches = e == nil && reflect.DeepEqual(expected, actual)
				}
				if matches && time.Now().Before(deadline) {
					return nil
				}
			}
		}
		pause := time.Duration(math.Min(interval*float64(time.Second), float64(time.Until(deadline))))
		if pause > 0 && attempt+1 < attempts {
			time.Sleep(pause)
		}
	}
	return errors.New("Caddy 管理 API 在总验证预算内未就绪或配置不一致")
}

// Run preserves the script's command-line contract; output has no implicit newline.
func Run(argv []string) (string, error) {
	if len(argv) == 0 {
		return "", errors.New("未知安装辅助操作")
	}
	op, args := argv[0], argv[1:]
	counts := map[string][2]int{"socket": {1, 1}, "remove-stale-socket": {1, 1}, "env-read": {1, 2}, "env-write": {3, 4}, "validate": {1, 1}, "endpoint": {1, 1}, "connect": {3, 3}, "wait": {6, 6}, "equal": {2, 2}, "equal-caddyfile": {4, 4}, "legacy-caddy-default": {5, 5}, "service": {2, 2}}
	count, ok := counts[op]
	if !ok {
		return "", errors.New("未知安装辅助操作")
	}
	if len(args) < count[0] || len(args) > count[1] {
		return "", errors.New("安装辅助操作参数无效")
	}
	switch op {
	case "socket":
		return socketPath(args[0])
	case "remove-stale-socket":
		return "", removeStaleSocket(args[0])
	case "wait":
		return "", waitForCaddy(args)
	case "env-read", "env-write":
		key := "ELYSIAN_CADDY_SOCKET"
		index := 1
		if op == "env-write" {
			index = 3
		}
		if len(args) > index {
			key = args[index]
		}
		if key != "ELYSIAN_CADDY_SOCKET" && key != "ELYSIAN_DOCKER_SOCKET" {
			return "", errors.New("不支持的环境配置键")
		}
		records, err := readEnvironment(args[0])
		if err != nil {
			return "", err
		}
		value, err := environmentValue(records, key)
		if err != nil || op == "env-read" {
			return value, err
		}
		value, err = socketPath(args[1])
		if err != nil {
			return "", err
		}
		retained := ""
		for _, record := range records {
			if record.key != key {
				retained += record.text
			}
		}
		if retained != "" && !strings.HasSuffix(retained, "\n") {
			retained += "\n"
		}
		return "", os.WriteFile(args[2], []byte(retained+key+"="+value+"\n"), 0666)
	case "service":
		match := regexp.MustCompile(`argv\[\]=(.*?) ;`).FindStringSubmatch(args[0])
		if len(match) > 1 {
			command := strings.Fields(match[1])
			if len(command) > 0 && regexp.MustCompile(`^/[A-Za-z0-9_./-]*caddy$`).MatchString(command[0]) {
				for _, candidate := range [][]string{{"run", "--environ", "--config", args[1]}, {"run", "--environ", "--config", args[1], "--adapter", "caddyfile"}, {"run", "--config", args[1]}, {"run", "--config", args[1], "--adapter", "caddyfile"}} {
					if reflect.DeepEqual(command[1:], candidate) {
						return "", nil
					}
				}
			}
		}
		return "", errors.New("无法确认 caddy.service 使用标准 Caddyfile 启动方式，拒绝自动接管")
	}
	config, err := readConfig(args[0])
	if err != nil {
		return "", err
	}
	switch op {
	case "validate":
		return "", nil
	case "endpoint":
		admin := object(config["admin"])
		if truthy(admin["disabled"]) {
			return "", errors.New("已有 Caddy 禁用了管理 API，不能安全自动接入")
		}
		listen, ok := admin["listen"]
		if !ok || listen == nil {
			listen = "localhost:2019"
		}
		address, ok := listen.(string)
		if !ok {
			return "", errors.New("无法识别 Caddy 管理端点")
		}
		if strings.HasPrefix(address, "unix/") {
			path, e := socketPath(strings.TrimPrefix(address, "unix/"))
			return "unix:" + path, e
		}
		if tcpPattern.MatchString(address) {
			return "tcp:" + address, nil
		}
		return "", errors.New("已有 Caddy 管理端点不是可验证的本机 Unix socket 或回环 TCP 地址")
	case "connect":
		path, e := socketPath(args[1])
		if e != nil {
			return "", e
		}
		if config == nil {
			config = map[string]any{}
		}
		admin := object(config["admin"])
		if admin == nil {
			admin = map[string]any{}
		}
		admin["listen"] = "unix/" + path
		config["admin"] = admin
		body, e := json.Marshal(config)
		if e != nil {
			return "", e
		}
		return "", os.WriteFile(args[2], append(body, '\n'), 0600)
	case "equal", "equal-caddyfile", "legacy-caddy-default":
		other, e := readConfig(args[1])
		if e != nil {
			return "", e
		}
		if op != "equal" && (!strings.HasPrefix(args[2], "/") || !strings.HasPrefix(args[3], "/")) {
			return "", errors.New("Caddyfile 比对需要原文件与临时文件的绝对路径")
		}
		if op == "equal-caddyfile" {
			normalize(servers(other), args[3], args[2])
		}
		if op == "legacy-caddy-default" {
			if admin := object(config["admin"]); admin != nil {
				path, e := socketPath(args[4])
				if e != nil {
					return "", e
				}
				for key, value := range admin {
					if key != "listen" || value != "localhost:2019" && value != "127.0.0.1:2019" && value != "[::1]:2019" && value != "unix/"+path {
						return "", errors.New("旧 Caddy 存在自定义管理设置，不能按默认站点清理")
					}
				}
				delete(config, "admin")
			}
			normalize(servers(config), args[2], args[3])
		}
		if !reflect.DeepEqual(config, other) {
			message := "Caddy 实际运行配置与待应用配置不同，不能确认路由及证书保持完整"
			if op == "equal-caddyfile" {
				message = "Caddy 候选配置改变了管理监听以外的配置，拒绝应用"
			}
			if op == "legacy-caddy-default" {
				message = "旧 Caddy 不等于默认欢迎站点，不能视为未使用"
			}
			return "", errors.New(message)
		}
		return "", nil
	}
	return "", fmt.Errorf("未知安装辅助操作：%s", op)
}
