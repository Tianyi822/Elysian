package firewall

import (
	"regexp"
	"strconv"
	"strings"
)

// `ss -Hultn` 输出解析（parseSockets.ts 等价物）：监听中的 TCP/UDP 端口集合，
// 用于派生规则的「正常/未使用」。形状取自容器内真实输出（-t 与 -u 混用时首列是
// 协议名，列间多空格分隔）：
//
//	udp UNCONN 0      0      127.0.0.11:37622 0.0.0.0:*
//	tcp LISTEN 0      512             *:5173        *:*

var rePortText = regexp.MustCompile(`^\d{1,5}$`)

// parseSsListening 解析出监听键集合，元素形如 `tcp:22`。
func parseSsListening(stdout string) map[string]bool {
	listeners := map[string]bool{}
	for _, rawLine := range strings.Split(stdout, "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" {
			continue
		}
		columns := strings.Fields(line)
		if len(columns) < 6 {
			continue
		}
		proto := ""
		switch columns[0] {
		case "udp":
			proto = "udp"
		case "tcp":
			proto = "tcp"
		default:
			continue
		}
		state := columns[1]
		if proto == "tcp" && state != "LISTEN" {
			continue
		}
		// 列序：协议、状态、接收队列、发送队列、本地地址、对端地址。
		local := columns[4]
		portText := local[strings.LastIndex(local, ":")+1:]
		if !rePortText.MatchString(portText) {
			continue
		}
		port, err := strconv.Atoi(portText)
		if err != nil {
			continue
		}
		listeners[strings.ToLower(proto)+":"+strconv.Itoa(port)] = true
	}
	return listeners
}
