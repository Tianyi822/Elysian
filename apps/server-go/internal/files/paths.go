package files

import (
	"strings"

	"elysian/server/internal/shared"
)

/*
 * 文件管理的纯路径判据（filesPaths.ts 等价物）：归一化、控制字符与穿越段拒绝、
 * 写禁区清单与前缀匹配。全部动作入口先过这里的判据，归一化结果才进文件系统访问，
 * 原始入参只进错误文案——绕过界面直发请求（手改 URL 的 `.` 段、相对路径、控制字符）
 * 也穿不透。只做纯计算，不碰文件系统；realpath 复核由服务层组合本模块的前缀判定完成。
 */

// filePathMaxLength 归一化后路径长度上限：对齐 PATH_MAX（4096），长度按 UTF-16 码元计
// （对齐 TS String.prototype.length 的口径）。恰好等于上限放行。
const filePathMaxLength = 4096

// virtualFsPrefixes 内核接口与设备节点：读遍历整树剪枝，写操作一律拒绝。
var virtualFsPrefixes = []string{"/proc", "/sys", "/dev"}

// elysianVolumeDir compose 持久卷的真身挂载点：/root/.Elysian 是指向这里的符号链接，
// 两侧都得守。
const elysianVolumeDir = "/var/lib/elysian"

// appDir 容器内面板自身代码与运行位置（Dockerfile 的 WORKDIR、绑定挂载与卷都在此前缀下）。
const appDir = "/app"

// hasControlChars NUL 与全部 C0/C1 控制字符（含换行、制表、DEL 与 U+0080-U+009F）：
// 路径与新条目名称里一律拒绝（对齐 TS 正则 /[\u0000-\u001F\u007F-\u009F]/）。
func hasControlChars(s string) bool {
	for _, r := range s {
		if r <= 0x1F || (r >= 0x7F && r <= 0x9F) {
			return true
		}
	}
	return false
}

// normalizeServerFilePath 归一化并校验服务端路径：必须以 `/` 开头；逐段检查，`..` 段与
// `.` 段一律拒绝（不是压掉——filepath.Clean 会消化它们，本域禁用）；空段（连续斜杠与
// 尾斜杠）压掉；整串不得含 NUL 与控制字符；归一化后长度 ≤ 4096。拒绝时回 400 错误
// 「无效的文件路径：<原样入参>」；`/` 归一化为自身。
func normalizeServerFilePath(input string) (string, error) {
	reject := func() (string, error) {
		return "", shared.InvalidRequest("无效的文件路径：" + input)
	}
	if !strings.HasPrefix(input, "/") {
		return reject()
	}
	if hasControlChars(input) {
		return reject()
	}
	segments := nonEmptySegments(input)
	for _, segment := range segments {
		if segment == ".." || segment == "." {
			return reject()
		}
	}
	normalized := "/"
	if len(segments) > 0 {
		normalized = "/" + strings.Join(segments, "/")
	}
	if utf16Len(normalized) > filePathMaxLength {
		return reject()
	}
	return normalized, nil
}

// nonEmptySegments 切出非空路径段（连续斜杠与首尾斜杠自然压掉）。
func nonEmptySegments(path string) []string {
	return strings.FieldsFunc(path, func(r rune) bool { return r == '/' })
}

// childPathOf 拼子路径：根目录下不带双斜杠（`/ + name`），其余直接拼接。
// name 由调用方保证不含 `/`。
func childPathOf(dirPath, name string) string {
	if dirPath == "/" {
		return "/" + name
	}
	return dirPath + "/" + name
}

// parentDirOf 父目录路径：根目录与一级条目的父目录都是 `/`。调用方须先保证路径已归一化且非根。
func parentDirOf(path string) string {
	segments := nonEmptySegments(path)
	if len(segments) == 0 {
		return "/"
	}
	segments = segments[:len(segments)-1]
	if len(segments) == 0 {
		return "/"
	}
	return "/" + strings.Join(segments, "/")
}

// leafNameOf 叶名：路径最后一段。调用方须先保证路径已归一化且非根。
func leafNameOf(path string) string {
	segments := nonEmptySegments(path)
	if len(segments) == 0 {
		return ""
	}
	return segments[len(segments)-1]
}

// matchPathPrefix 前缀匹配：路径等于前缀本身、或落在其下（前缀 + `/`）才算命中——
// `/root/.Elysian2` 不落在 `/root/.Elysian` 下。返回是否命中。
func matchPathPrefix(path string, prefixes []string) (string, bool) {
	for _, prefix := range prefixes {
		if path == prefix || strings.HasPrefix(path, prefix+"/") {
			return prefix, true
		}
	}
	return "", false
}

// joinUnderHome 在 homeDir 下拼子路径（对齐 node:path.join 的拼装语义，homeDir 已无尾斜杠）。
func joinUnderHome(homeDir, name string) string {
	return strings.TrimSuffix(homeDir, "/") + "/" + name
}

// forbiddenWritePrefixes 写禁区清单：对归一化路径与 realpath 结果分别做前缀匹配用。
// `/root` 前缀经注入的 homeDir 解析（真实接线传 os.UserHomeDir()，容器内为 /root），
// 不硬编码。同时收录面板资产的字符串名与卷挂真身两侧——只收一侧时符号链接另一侧的
// 直写会绕过保护。
func forbiddenWritePrefixes(homeDir string) []string {
	return append(append([]string{}, virtualFsPrefixes...),
		joinUnderHome(homeDir, ".Elysian"),
		elysianVolumeDir,
		joinUnderHome(homeDir, ".ssh"),
		joinUnderHome(homeDir, ".bun"),
		appDir,
	)
}

// isForbiddenWritePath 归一化路径是否落写禁区（纯字符串判定；realpath 复核由服务层再调一次）。
func isForbiddenWritePath(path, homeDir string) bool {
	_, hit := matchPathPrefix(path, forbiddenWritePrefixes(homeDir))
	return hit
}

// searchExtraPrunePrefixes search 专属的额外剪枝前缀：Bun 运行时与安装缓存，不是运维搜索的对象。
func searchExtraPrunePrefixes(homeDir string) []string {
	return []string{joinUnderHome(homeDir, ".bun")}
}

// searchPruneDirNames search 专属的额外剪枝段名：任何位置的 `node_modules` 目录整树跳过，
// 预算留给系统文件。
var searchPruneDirNames = []string{"node_modules"}
