package logs

import (
	"fmt"
	"strings"
)

/*
 * 操作日志的端点描述符表（operationDescriptors.ts 等价物）：**什么动作被记录、记成什么**
 * 的唯一权威。键 = `${METHOD} ${含挂载前缀的全路径}`，与方法名、路由模板逐字相同。
 *
 * 凭据隔离是结构性的：只有声明了 summarize 的端点才会被采集器读取请求体（summarize
 * 为 nil 即「未声明」，请求体恒不被读——密码/私钥端点因此不可能进日志）。
 * target 为常量或函数（拿 params/body 取值）；函数 panic 只让该字段退化为 null。
 */

// opInput 摘要与对象的取值上下文：白名单字段的请求体、路径参数与最终状态码。
type opInput struct {
	// body 已解析的请求体对象；没有体、体超限或不是 JSON 对象时为 nil。
	body map[string]any
	// params 从路由模板与具体路径还原的路径参数。
	params map[string]string
	// status 最终 HTTP 状态码（服务端事实）。
	status int
}

// opDescriptor 单个写端点的描述符。
type opDescriptor struct {
	category string
	action   string
	// targetConst 常量动作对象（与 targetFn 互斥；都缺省记 null）。
	targetConst *string
	// targetFn 函数形动作对象（拿 params/body）。
	targetFn func(input *opInput) *string
	// summarize 参数摘要；nil 表示未声明（结构性不读体）。
	summarize func(input *opInput) *string
}

// sp 字符串指针。
func sp(v string) *string { return &v }

// bodyText 取值器：字段缺失、非字符串或 trim 后为空一律回 nil。
func bodyText(body map[string]any, field string) *string {
	if body == nil {
		return nil
	}
	value, ok := body[field]
	if !ok {
		return nil
	}
	s, ok := value.(string)
	if !ok {
		return nil
	}
	trimmed := trimJS(s)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// onOff 开关的中文取值：只有 true 才算「开」（缺字段按「关」呈现）。
func onOff(value any) string {
	if b, ok := value.(bool); ok && b {
		return "开"
	}
	return "关"
}

// paramValue 路径参数取值：模板里有、具体路径里给不出时回 nil。
func paramValue(params map[string]string, name string) *string {
	if v, ok := params[name]; ok {
		return &v
	}
	return nil
}

// firewallPolicyLabels 防火墙策略标签（契约 FIREWALL_POLICY_LABELS 的域内副本）。
var firewallPolicyLabels = map[string]string{
	"allow": "放行",
	"deny":  "拒绝",
	"limit": "限连",
}

// sshRootLoginPolicyLabels SSH Root 登录策略标签（契约的域内副本）。
var sshRootLoginPolicyLabels = map[string]string{
	"no":                   "禁止 Root 登录",
	"prohibit-password":    "只能密钥登录",
	"forced-commands-only": "仅允许指定命令",
	"yes":                  "允许密码登录",
}

// policyLabelOf 防火墙策略标签取值（值不在表内回 nil）。
func policyLabelOf(value any) *string {
	s, ok := value.(string)
	if !ok {
		return nil
	}
	if label, exists := firewallPolicyLabels[s]; exists {
		return &label
	}
	return nil
}

// rootLoginLabelOf SSH Root 登录策略标签取值。
func rootLoginLabelOf(value any) *string {
	s, ok := value.(string)
	if !ok {
		return nil
	}
	if label, exists := sshRootLoginPolicyLabels[s]; exists {
		return &label
	}
	return nil
}

// ruleSummary 端口规则的参数摘要：`<protocol>/<port> <policy>`。
func ruleSummary(body map[string]any) *string {
	if body == nil {
		return nil
	}
	port, ok := jsStringOf(body["port"])
	if !ok {
		return nil
	}
	protocol := "tcp"
	if body["protocol"] == "udp" {
		protocol = "udp"
	}
	label := policyLabelOf(body["policy"])
	if label == nil {
		return nil
	}
	return sp(fmt.Sprintf("%s/%s %s", protocol, port, *label))
}

// forwardSummary 端口转发的参数摘要：`<port> → <targetHost>:<targetPort>`。
func forwardSummary(body map[string]any) *string {
	if body == nil {
		return nil
	}
	port, portOK := jsStringOf(body["port"])
	if !portOK {
		return nil
	}
	host, hostOK := body["targetHost"].(string)
	if !hostOK {
		return nil
	}
	targetPort, targetOK := jsStringOf(body["targetPort"])
	if !targetOK {
		return nil
	}
	return sp(fmt.Sprintf("%s → %s:%s", port, host, targetPort))
}

// ipRuleSummary IP 规则的参数摘要：`来源 <source> <policy>`。
func ipRuleSummary(body map[string]any) *string {
	source := bodyText(body, "source")
	label := policyLabelOf(body["policy"])
	if source == nil || label == nil {
		return nil
	}
	return sp(fmt.Sprintf("来源 %s %s", *source, *label))
}

// setupStepTarget 依赖安装步骤的对象名：只认固定步骤，其余不进日志对象。
func setupStepTarget(name string, step *string) *string {
	if step == nil {
		return nil
	}
	switch *step {
	case "install":
		return sp(name + " 安装")
	case "configure":
		return sp(name + " 配置管理通道")
	case "enable":
		return sp(name + " 启动并常驻")
	default:
		return nil
	}
}

// targetOfID 路径参数直接作对象（target: param(params, 'id') 的简写）。
func targetOfID(input *opInput) *string {
	return paramValue(input.params, "id")
}

// operationDescriptors 端点描述符表（键与 TS 版逐字相同；挂载常量展开为字面量）。
var operationDescriptors = map[string]*opDescriptor{
	// 安全区：SSH（/api/security/ssh）
	"PUT /api/security/ssh/service-enabled": {
		category: "security", action: "启停 SSH 服务", targetConst: sp("sshd"),
		summarize: func(input *opInput) *string {
			if input.body["enabled"] == true {
				return sp("已启动")
			}
			return sp("已停止")
		},
	},
	"PUT /api/security/ssh/auth-methods": {
		category: "security", action: "修改 SSH 登录方式", targetConst: sp("sshd"),
		summarize: func(input *opInput) *string {
			return sp(fmt.Sprintf("密码登录 %s，密钥登录 %s",
				onOff(input.body["passwordAuthEnabled"]), onOff(input.body["keyAuthEnabled"])))
		},
	},
	"PUT /api/security/ssh/port": {
		category: "security", action: "修改 SSH 监听端口", targetConst: sp("sshd"),
		summarize: func(input *opInput) *string {
			if port, ok := jsStringOf(input.body["port"]); ok {
				return sp(fmt.Sprintf("端口 %s", port))
			}
			return nil
		},
	},
	"PUT /api/security/ssh/root-login-policy": {
		category: "security", action: "修改 Root 登录策略", targetConst: sp("sshd"),
		summarize: func(input *opInput) *string {
			return rootLoginLabelOf(input.body["policy"])
		},
	},
	// 体是明文密码：**不声明 summarize**，请求体因此永不被读取。
	"POST /api/security/ssh/root-password": {
		category: "security", action: "重置 Root 密码", targetConst: sp("root"),
	},
	"POST /api/security/ssh/root-key": {
		category: "security", action: "生成 Root 密钥", targetConst: sp("root"),
	},
	"POST /api/security/ssh/keys": {
		category: "security", action: "创建登录密钥",
		// 账号只在请求体里；本端点同时声明了 summarize，因此体是可读的。
		targetFn: func(input *opInput) *string {
			userId := bodyText(input.body, "userId")
			if userId == nil {
				return nil
			}
			return sp(fmt.Sprintf("账号 %s", *userId))
		},
		summarize: func(input *opInput) *string {
			name := bodyText(input.body, "name")
			if name == nil {
				return nil
			}
			return sp(fmt.Sprintf("名称 %s", *name))
		},
	},
	"DELETE /api/security/ssh/keys/:id": {
		category: "security", action: "删除登录密钥", targetFn: targetOfID,
	},

	// 安全区：防火墙（/api/security/firewall）
	"PUT /api/security/firewall/toggles": {
		category: "security", action: "修改防火墙开关",
		summarize: func(input *opInput) *string {
			return sp(fmt.Sprintf("防火墙 %s，禁 Ping %s",
				onOff(input.body["firewallEnabled"]), onOff(input.body["pingBlocked"])))
		},
	},
	"POST /api/security/firewall/rules": {
		category: "security", action: "新增端口规则",
		summarize: func(input *opInput) *string { return ruleSummary(input.body) },
	},
	"PUT /api/security/firewall/rules/:id": {
		category: "security", action: "修改端口规则", targetFn: targetOfID,
		summarize: func(input *opInput) *string { return ruleSummary(input.body) },
	},
	"DELETE /api/security/firewall/rules/:id": {
		category: "security", action: "删除端口规则", targetFn: targetOfID,
	},
	"POST /api/security/firewall/rules/import": {
		category: "security", action: "导入端口规则",
		summarize: func(input *opInput) *string {
			rules, ok := input.body["rules"].([]any)
			if !ok {
				return nil
			}
			return sp(fmt.Sprintf("共 %d 条", len(rules)))
		},
	},
	"POST /api/security/firewall/sync": {
		category: "security", action: "从系统同步防火墙规则",
	},
	"POST /api/security/firewall/ip-rules": {
		category: "security", action: "新增 IP 规则",
		summarize: func(input *opInput) *string { return ipRuleSummary(input.body) },
	},
	"PUT /api/security/firewall/ip-rules/:id": {
		category: "security", action: "修改 IP 规则", targetFn: targetOfID,
		summarize: func(input *opInput) *string { return ipRuleSummary(input.body) },
	},
	"DELETE /api/security/firewall/ip-rules/:id": {
		category: "security", action: "删除 IP 规则", targetFn: targetOfID,
	},
	"POST /api/security/firewall/forwards": {
		category: "security", action: "新增端口转发",
		summarize: func(input *opInput) *string { return forwardSummary(input.body) },
	},
	"PUT /api/security/firewall/forwards/:id": {
		category: "security", action: "修改端口转发", targetFn: targetOfID,
		summarize: func(input *opInput) *string { return forwardSummary(input.body) },
	},
	"DELETE /api/security/firewall/forwards/:id": {
		category: "security", action: "删除端口转发", targetFn: targetOfID,
	},
	"POST /api/security/firewall/scan/toggle": {
		category: "security", action: "启停防扫描",
		summarize: func(input *opInput) *string {
			if input.body["enabled"] == true {
				return sp("已开启")
			}
			return sp("已关闭")
		},
	},
	"PUT /api/security/firewall/scan/config": {
		category: "security", action: "修改防扫描配置",
		summarize: func(input *opInput) *string {
			window, windowOK := input.body["windowSeconds"].(float64)
			hits, hitsOK := input.body["hitCount"].(float64)
			ban, banOK := input.body["banSeconds"].(float64)
			if !windowOK || !hitsOK || !banOK {
				return nil
			}
			return sp(fmt.Sprintf("窗口 %ss，命中 %s 次，封禁 %ss",
				formatJSNumber(window), formatJSNumber(hits), formatJSNumber(ban)))
		},
	},
	"POST /api/security/firewall/scan/unblock": {
		category: "security", action: "解除 IP 封禁",
		summarize: func(input *opInput) *string {
			ip := bodyText(input.body, "ip")
			if ip == nil {
				return nil
			}
			return sp(fmt.Sprintf("IP %s", *ip))
		},
	},

	// 安全区：系统账号（两个含密码的端点不声明 summarize）
	"POST /api/security/users": {
		category: "security", action: "创建系统账号",
	},
	"PUT /api/security/users/:id": {
		category: "security", action: "修改系统账号",
		targetFn: func(input *opInput) *string {
			id := paramValue(input.params, "id")
			if id == nil {
				return nil
			}
			return sp(fmt.Sprintf("账号 %s", *id))
		},
	},
	"DELETE /api/security/users/:id": {
		category: "security", action: "删除系统账号",
		targetFn: func(input *opInput) *string {
			id := paramValue(input.params, "id")
			if id == nil {
				return nil
			}
			return sp(fmt.Sprintf("账号 %s", *id))
		},
	},
	"POST /api/security/users/sync": {
		category: "security", action: "从系统同步账号清单",
	},

	// 文件管理（/api/files）
	"PUT /api/files/upload": {
		// 文件正文可能很大且包含凭据；仅记录动作和结果，采集器绝不读取正文。
		category: "files", action: "上传文件",
	},
	"POST /api/files/copy": {
		category: "files", action: "复制文件",
		summarize: func(input *opInput) *string {
			src := bodyText(input.body, "srcPath")
			dest := bodyText(input.body, "destDirPath")
			if src == nil || dest == nil {
				return nil
			}
			return sp(fmt.Sprintf("%s → %s", *src, *dest))
		},
	},
	"POST /api/files/move": {
		category: "files", action: "移动文件",
		summarize: func(input *opInput) *string {
			src := bodyText(input.body, "srcPath")
			dest := bodyText(input.body, "destDirPath")
			if src == nil || dest == nil {
				return nil
			}
			return sp(fmt.Sprintf("%s → %s", *src, *dest))
		},
	},
	"POST /api/files/rename": {
		category: "files", action: "重命名",
		summarize: func(input *opInput) *string {
			path := bodyText(input.body, "path")
			newName := bodyText(input.body, "newName")
			if path == nil || newName == nil {
				return nil
			}
			return sp(fmt.Sprintf("%s → %s", *path, *newName))
		},
	},
	"POST /api/files/compress": {
		category: "files", action: "压缩文件",
		summarize: func(input *opInput) *string { return bodyText(input.body, "path") },
	},
	"POST /api/files/chmod": {
		category: "files", action: "修改权限",
		summarize: func(input *opInput) *string {
			path := bodyText(input.body, "path")
			mode := bodyText(input.body, "mode")
			owner := bodyText(input.body, "owner")
			if path == nil || mode == nil || owner == nil {
				return nil
			}
			recursive := ""
			if input.body["recursive"] == true {
				recursive = "（递归）"
			}
			return sp(fmt.Sprintf("%s %s %s%s", *path, *mode, *owner, recursive))
		},
	},

	// 容器管理（/api/docker）
	"POST /api/docker/containers": {
		category: "containers", action: "创建容器",
		targetFn: func(input *opInput) *string {
			name := bodyText(input.body, "name")
			if name == nil {
				return sp("新容器")
			}
			return name
		},
		summarize: func(input *opInput) *string {
			imageID := bodyText(input.body, "imageId")
			if imageID == nil {
				return nil
			}
			return sp(fmt.Sprintf("镜像 %s", *imageID))
		},
	},
	"POST /api/docker/containers/:id/start": {
		category: "containers", action: "启动容器", targetFn: containerTarget,
	},
	"POST /api/docker/containers/:id/stop": {
		category: "containers", action: "停止容器", targetFn: containerTarget,
	},
	"POST /api/docker/containers/:id/restart": {
		category: "containers", action: "重启容器", targetFn: containerTarget,
	},
	"DELETE /api/docker/containers/:id": {
		category: "containers", action: "删除容器", targetFn: containerTarget,
	},
	"POST /api/docker/images/pull": {
		category: "containers", action: "拉取镜像",
		summarize: func(input *opInput) *string {
			name := bodyText(input.body, "name")
			tag := bodyText(input.body, "tag")
			if name == nil || tag == nil {
				return nil
			}
			return sp(fmt.Sprintf("%s:%s", *name, *tag))
		},
	},
	"POST /api/docker/images/pull/stream": {
		category: "containers", action: "发起镜像拉取",
		summarize: func(input *opInput) *string {
			name := bodyText(input.body, "name")
			tag := bodyText(input.body, "tag")
			if name == nil || tag == nil {
				return nil
			}
			return sp(fmt.Sprintf("%s:%s", *name, *tag))
		},
	},
	"DELETE /api/docker/images/:id": {
		category: "containers", action: "删除镜像",
		targetFn: func(input *opInput) *string {
			id := paramValue(input.params, "id")
			if id == nil {
				return nil
			}
			return sp(fmt.Sprintf("镜像 %s", *id))
		},
	},

	// 数据库（/api/databases）
	"POST /api/databases": {
		category: "database", action: "创建或接管数据库",
		targetFn: func(input *opInput) *string { return bodyText(input.body, "name") },
		summarize: func(input *opInput) *string {
			engine := bodyText(input.body, "engine")
			version := bodyText(input.body, "versionTag")
			if engine != nil && version != nil {
				return sp(fmt.Sprintf("%s:%s", *engine, *version))
			}
			return nil
		},
	},
	"POST /api/databases/:id/reveal": {
		category: "database", action: "读取普通账号凭证", targetFn: targetOfID,
	},
	"DELETE /api/databases/:id": {
		category: "database", action: "删除逻辑库或清空 Redis DB 0", targetFn: targetOfID,
	},
	"DELETE /api/databases/:id/container": {
		category: "database", action: "删除数据库容器及专属卷", targetFn: targetOfID,
	},
	"POST /api/databases/:id/reconcile": {
		category: "database", action: "重新核对数据库", targetFn: targetOfID,
	},
	"DELETE /api/databases/:id/registration": {
		category: "database", action: "移除待处理接管登记", targetFn: targetOfID,
	},
	"POST /api/databases/sqlite": {
		category: "database", action: "新建 SQLite 文件",
		targetFn: func(input *opInput) *string { return bodyText(input.body, "name") },
		// 声明了 summarize（恒 null）：体可读，摘要固定无。
		summarize: func(input *opInput) *string { return nil },
	},
	"POST /api/databases/sqlite/import": {
		category: "database", action: "导入 SQLite 文件",
	},
	"DELETE /api/databases/sqlite/:id": {
		category: "database", action: "删除 SQLite 文件", targetFn: targetOfID,
	},
	"POST /api/databases/sqlite/:id/reconcile": {
		category: "database", action: "重新核对 SQLite 文件", targetFn: targetOfID,
	},
	"DELETE /api/databases/sqlite/:id/registration": {
		category: "database", action: "清理待处理 SQLite 文件", targetFn: targetOfID,
	},

	// 网站（/api/websites）：创建和访问配置携带私钥，不声明 summarize、体 target。
	"POST /api/websites": {
		category: "websites", action: "创建网站项目",
	},
	"PUT /api/websites/:id": {
		category: "websites", action: "修改网站项目设置", targetFn: targetOfID,
	},
	"PUT /api/websites/:id/access": {
		category: "websites", action: "调整网站访问配置", targetFn: targetOfID,
	},
	"POST /api/websites/:id/running": {
		category: "websites", action: "启停网站项目", targetFn: targetOfID,
		summarize: func(input *opInput) *string {
			if input.body["running"] == true {
				return sp("已启动")
			}
			return sp("已停止")
		},
	},
	"POST /api/websites/proxy/reconcile": {
		category: "websites", action: "重新下发反向代理配置",
	},
	"DELETE /api/websites/:id": {
		category: "websites", action: "删除网站项目", targetFn: targetOfID,
	},

	// 日志管理：清空本身也留痕（「想抹掉痕迹」只会留下「抹掉痕迹」这条痕迹）。
	"PUT /api/panel/ports": {
		category: "security", action: "修改面板端口并重启",
		summarize: func(input *opInput) *string {
			return sp(fmt.Sprintf("前端：%v；后端回环：%v", input.body["frontendPort"], input.body["backendPort"]))
		},
	},
	"POST /api/panel/restart": {category: "security", action: "重启面板"},
	"POST /api/panel/update": {
		category: "security", action: "更新面板并重启",
		summarize: func(input *opInput) *string { return bodyText(input.body, "targetCommit") },
	},
	"POST /api/logs/runtime/clear": {
		category: "logs", action: "清空运行日志",
	},
	"POST /api/logs/operation/clear": {
		category: "logs", action: "清空操作日志",
	},

	// 宿主依赖安装：一步一个写请求；目标只取路径里的步骤名，不读请求体。
	"POST /api/platform/dependencies/setup/docker/:step": {
		category: "containers", action: "安装 Docker",
		targetFn: func(input *opInput) *string {
			return setupStepTarget("Docker", paramValue(input.params, "step"))
		},
	},
	"POST /api/platform/dependencies/setup/caddy/:step": {
		category: "websites", action: "安装 Caddy",
		targetFn: func(input *opInput) *string {
			return setupStepTarget("Caddy", paramValue(input.params, "step"))
		},
	},

	// 登录鉴权：登录/改密体含密码——不声明 summarize；登出无会话也记 success。
	"POST /api/auth/login":                  {category: "auth", action: "登录面板"},
	"POST /api/auth/logout":                 {category: "auth", action: "退出登录"},
	"POST /api/auth/password":               {category: "auth", action: "修改面板密码"},
	"POST /api/auth/sessions/logout-others": {category: "auth", action: "退出其他会话"},
}

// containerTarget 容器对象：`容器 <id>`。
func containerTarget(input *opInput) *string {
	id := paramValue(input.params, "id")
	if id == nil {
		return nil
	}
	return sp(fmt.Sprintf("容器 %s", *id))
}

// extractPathParams 从路由模板与具体路径还原路径参数（纯函数，TS 逐字对齐）：
// 只按段对齐取 `:name` 段；段数不符时给不出值的键不存在；通配段不是参数；不做二次解码。
func extractPathParams(routeTemplate, concretePath string) map[string]string {
	template := splitPathSegments(routeTemplate)
	concrete := splitPathSegments(concretePath)
	params := map[string]string{}
	for index, segment := range template {
		if !strings.HasPrefix(segment, ":") {
			continue
		}
		if index >= len(concrete) {
			continue
		}
		params[segment[1:]] = concrete[index]
	}
	return params
}

// splitPathSegments 路径切段：忽略首尾斜杠带来的空段（/a/b/ 与 /a/b 同形）。
func splitPathSegments(path string) []string {
	segments := strings.Split(path, "/")
	kept := segments[:0]
	for _, segment := range segments {
		if segment != "" {
			kept = append(kept, segment)
		}
	}
	return kept
}

// splitDescriptorKey 键拆 METHOD 与路径。
func splitDescriptorKey(key string) (method, path string, ok bool) {
	method, path, found := strings.Cut(key, " ")
	if !found || method == "" || path == "" {
		return "", "", false
	}
	return method, path, true
}
