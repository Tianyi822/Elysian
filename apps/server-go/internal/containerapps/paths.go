// Package containerapps 容器应用工作区：随容器一起上传的配置文件（compose.yml、.env、
// 各类 config）的存放、登记、内容读写、compose 引用路径自检与镜像构建（ADR-0021）。
//
// 边界（ADR-0020）：面板只负责把文件存好并回显真实路径，不执行 docker compose——
// 启动由运维者在宿主上照回显路径自行编排。镜像构建按 ADR-0021 执行：Dockerfile 与
// compose build 段经 Docker Engine 的 /build（classic 构建器）受控构建，产物镜像落
// elysian/ 保留命名空间。文件实体落在 mountRoot 之下而不是 ~/.Elysian 之下，因为
// 只有 mountRoot 路径在宿主、面板与 Docker daemon 三方是同一个字符串；~/.Elysian
// 在 Docker 部署里是命名卷挂到 /var/lib/elysian 再软链回来的，把它回显进 compose
// 就是给一个错路径。
//
// 内容读写只服务本域的工作区目录，不扩进文件管理域：后者的写禁区（files/paths.go
// 的 forbiddenWritePrefixes）不覆盖 /etc，通用化等于打开任意写系统配置的口子。
package containerapps

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
)

const (
	// appsDirName 工作区根下的一层固定目录名。
	appsDirName = "apps"
	// maxSlugLength 与容器名同档：64 字符内。
	maxSlugLength = 64
	// maxRelativeDepth 相对路径最多层数，防构造深链。
	maxRelativeDepth = 8
	// maxRelativeLength 相对路径字符上限。
	maxRelativeLength = 512
)

// slugPattern 工作区标识：小写字母或数字开头，其后允许小写字母、数字、下划线与连字符。
// 只允许这个形状，`..`、`.`、绝对片段与分隔符变体全部落空。
var slugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// ValidateSlug 校验工作区标识；返回归一化后的原值（不做大小写折叠，避免歧义）。
func ValidateSlug(slug string) error {
	if slug == "" {
		return fmt.Errorf("工作区名称不能为空")
	}
	if len(slug) > maxSlugLength {
		return fmt.Errorf("工作区名称不得超过 %d 个字符", maxSlugLength)
	}
	if !slugPattern.MatchString(slug) {
		return fmt.Errorf("工作区名称只能由小写字母、数字、下划线和连字符组成，且以字母或数字开头")
	}
	return nil
}

// WorkspaceRoot 是全部工作区的根：<mountRoot>/elysian/apps。
func WorkspaceRoot(mountRoot string) string {
	return filepath.Join(mountRoot, "elysian", appsDirName)
}

// WorkspaceDir 是单个工作区的绝对目录。
func WorkspaceDir(mountRoot, slug string) string {
	return filepath.Join(WorkspaceRoot(mountRoot), slug)
}

// NormalizeRelative 校验并归一化调用方给出的相对子路径。
//
// 拒绝绝对路径、盘符、反斜杠、NUL 与控制字符、空段、`.` 与 `..` 段、超限长度与
// 超限层数。这里的 `.`/`..` 是**逐段拒绝而不是折叠消除**——折叠会把 `a/../b` 变成
// `b`，让调用方以为保留了原意；文件管理域同样按段拒绝，见 files/paths.go 的判定。
func NormalizeRelative(rel string) (string, error) {
	if rel == "" {
		return "", fmt.Errorf("文件路径不能为空")
	}
	if len(rel) > maxRelativeLength {
		return "", fmt.Errorf("文件路径过长")
	}
	if strings.HasPrefix(rel, "/") {
		return "", fmt.Errorf("文件路径必须是相对路径")
	}
	if strings.Contains(rel, "\\") {
		return "", fmt.Errorf("文件路径不允许反斜杠")
	}
	if strings.ContainsRune(rel, 0) {
		return "", fmt.Errorf("文件路径包含非法字符")
	}
	for _, r := range rel {
		if unicode.IsControl(r) {
			return "", fmt.Errorf("文件路径包含控制字符")
		}
	}
	if strings.HasSuffix(rel, "/") {
		return "", fmt.Errorf("文件路径必须指向文件本身")
	}
	segments := strings.Split(rel, "/")
	if len(segments) > maxRelativeDepth {
		return "", fmt.Errorf("文件路径层级过深")
	}
	for _, segment := range segments {
		if segment == "" {
			return "", fmt.Errorf("文件路径包含空路径段")
		}
		if segment == "." || segment == ".." {
			return "", fmt.Errorf("文件路径不允许 . 与 .. 段")
		}
	}
	return strings.Join(segments, "/"), nil
}

// JoinWithin 把已归一化的相对路径拼进工作区目录，并断言结果仍落在该目录内。
// 归一化已经排除了逃逸写法，这里是第二道：拼完再用 filepath.Clean 复核一次前缀，
// 防止将来有人放宽 NormalizeRelative 而悄悄打开目录穿越。
func JoinWithin(workspaceDir, normalizedRel string) (string, error) {
	target := filepath.Clean(filepath.Join(workspaceDir, normalizedRel))
	root := filepath.Clean(workspaceDir)
	if target != root && !strings.HasPrefix(target, root+string(os.PathSeparator)) {
		return "", fmt.Errorf("文件路径超出工作区范围")
	}
	return target, nil
}

// AssertWithin 断言一个已解析（realpath 之后）的绝对路径仍在工作区内。
// 写之前对工作区目录与目标父目录做 EvalSymlinks，符号链接指向外部就被拦下——
// 与 docker 域的 resolveBindSource 同一手法（createspec.go 的 realpath 复核）。
func AssertWithin(workspaceDir, resolvedTarget string) error {
	root := filepath.Clean(workspaceDir)
	target := filepath.Clean(resolvedTarget)
	if target != root && !strings.HasPrefix(target, root+string(os.PathSeparator)) {
		return fmt.Errorf("文件路径经符号链接解析后超出工作区范围")
	}
	return nil
}

// resolveWithinWorkspace 归一化 → 拼接 → 逐段 realpath 复核，一次做完。
// 目标文件本身可以不存在（新建场景），此时对它已存在的最近祖先做解析复核。
func resolveWithinWorkspace(workspaceDir, rel string) (string, error) {
	normalized, err := NormalizeRelative(rel)
	if err != nil {
		return "", err
	}
	target, err := JoinWithin(workspaceDir, normalized)
	if err != nil {
		return "", err
	}
	anchor := filepath.Dir(target)
	for anchor != "" && anchor != "/" {
		resolved, statErr := filepath.EvalSymlinks(anchor)
		if statErr == nil {
			if err = AssertWithin(workspaceDir, resolved); err != nil {
				return "", err
			}
			return target, nil
		}
		if !os.IsNotExist(statErr) {
			return "", statErr
		}
		parent := filepath.Dir(anchor)
		if parent == anchor {
			break
		}
		anchor = parent
	}
	return target, nil
}
