package firewall

// 面板自身端口的共享禁区判据（panelPort.ts 等价物）。面板服务在 PanelPort/tcp，
// 一切可能改写这条通道的手段——端口转发的 DNAT、防扫描监控的 DROP——都必须在
// 输入校验里直接拒绝，先于任何规则落盘。端口数值的唯一权威在契约（迁移期待收口）。

// coversPanelPort 端口或端口段是否覆盖面板端口；单端口即自身，端口段含端点。
func coversPanelPort(port float64, portTo *float64) bool {
	end := port
	if portTo != nil {
		end = *portTo
	}
	return port <= float64(PanelPort) && float64(PanelPort) <= end
}
