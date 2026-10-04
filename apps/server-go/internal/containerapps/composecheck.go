package containerapps

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// compose 自检的判定范围。这里刻意是**保守行扫描**而不是 YAML 解析：自检的职责是
// 判定路径引用的存在性，build 段的解析属构建任务（ADR-0021 的 yaml.v3 解析），两套
// 职责互不替代。代价是看得懂的范围有限，因此把看得懂的与判定不了的都如实回给
// 界面——静默漏报比不检查更坑。两侧同句锚定：与 TS 侧 containerApps.ts 的
// COMPOSE_CHECK_COVERAGE 逐字相同。
const coverageText = "只判定 volumes 短语法与长语法 source、以及 env_file 引用的路径是否存在；" +
	"含变量替换、锚点引用、flow 风格与 build 段的行列入未能判定清单（build 段请用构建预览），请人工核对"

// ReferenceKind 引用类型取值。
const (
	KindVolume     = "volume"
	KindEnvFile    = "env_file"
	KindBuild      = "build"
	KindUnreadable = "unreadable"
)

// Reference compose 里引用到的一条宿主侧路径。
type Reference struct {
	Raw    string `json:"raw"`
	Kind   string `json:"kind"`
	Line   int    `json:"line"`
	Path   string `json:"path"`
	Scope  string `json:"scope"`
	Exists bool   `json:"exists"`
}

// CheckResult compose 引用路径自检结果。
type CheckResult struct {
	ComposePath  string      `json:"composePath"`
	ComposeDir   string      `json:"composeDir"`
	References   []Reference `json:"references"`
	Undetermined []string    `json:"undetermined"`
	Coverage     string      `json:"coverage"`
}

// CheckCompose 扫描 compose 文本，判定其中宿主侧相对路径的存在性。
//
// workspaceDir 是工作区绝对目录；composeRel 是 compose 文件自身的相对路径，
// 引用按 compose 文件所在目录展开（与 docker compose 的语义一致）。
func CheckCompose(workspaceDir, composeRel, content string) (CheckResult, error) {
	composeNormalized, err := NormalizeRelative(composeRel)
	if err != nil {
		return CheckResult{}, err
	}
	composeDir := filepath.Dir(filepath.Join(workspaceDir, composeNormalized))
	if composeDir == "." {
		composeDir = workspaceDir
	}
	result := CheckResult{
		ComposePath:  filepath.ToSlash(composeNormalized),
		ComposeDir:   composeDir,
		References:   []Reference{},
		Undetermined: []string{},
		Coverage:     coverageText,
	}
	// mode 记录当前所在的键块与其缩进；-1 表示不在任何关心的块里。
	mode := ""
	modeIndent := -1

	for index, rawLine := range strings.Split(content, "\n") {
		lineNumber := index + 1
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		indent := len(rawLine) - len(strings.TrimLeft(rawLine, " \t"))

		if modeIndent >= 0 && indent <= modeIndent {
			mode, modeIndent = "", -1
		}

		if !strings.HasPrefix(line, "-") {
			key, value, split := splitKey(line)
			if !split {
				continue
			}
			switch key {
			case "volumes":
				mode, modeIndent = KindVolume, indent
				if value != "" {
					result.inspectItem(workspaceDir, composeDir, KindVolume, value, lineNumber, &mode, &modeIndent)
				}
				continue
			case "env_file":
				mode, modeIndent = KindEnvFile, indent
				if value != "" {
					result.inspectItem(workspaceDir, composeDir, KindEnvFile, value, lineNumber, &mode, &modeIndent)
				}
				continue
			case "build":
				mode, modeIndent = KindBuild, indent
				result.Undetermined = append(result.Undetermined, fmt.Sprintf("第 %d 行：%s（build 段由构建任务解析，自检不判定）", lineNumber, line))
				continue
			case "source":
				if mode == KindVolume {
					result.inspectItem(workspaceDir, composeDir, KindVolume, value, lineNumber, &mode, &modeIndent)
				}
				continue
			case "target":
				continue
			}
		}

		if mode == KindVolume || mode == KindEnvFile {
			result.inspectItem(workspaceDir, composeDir, mode, strings.TrimSpace(strings.TrimPrefix(line, "-")), lineNumber, &mode, &modeIndent)
		}
	}
	return result, nil
}

// inspectItem 判定一条引用：能归一化成工作区相对路径的就查存在性，
// 变量/锚点/绝对路径等一律进「未能判定」，不猜。
func (r *CheckResult) inspectItem(workspaceDir, composeDir, kind, value string, lineNumber int, mode *string, modeIndent *int) {
	value = strings.TrimSpace(value)
	if value == "" {
		return
	}
	// 行内注释切掉，但只在引号外切。
	value = stripInlineComment(value)
	value = strings.Trim(value, `"'`)
	if value == "" {
		return
	}
	if ambiguous(value) {
		r.Undetermined = append(r.Undetermined, fmt.Sprintf("第 %d 行：%s", lineNumber, value))
		return
	}
	source := value
	if kind == KindVolume {
		// 短语法 SRC:DST[:mode]，取第一段；长语法已经是纯路径。
		if parts := strings.Split(value, ":"); len(parts) >= 2 {
			source = parts[0]
		}
	}
	if source == "." || source == ".." || strings.HasPrefix(source, "../") || strings.HasPrefix(source, "/") {
		r.Undetermined = append(r.Undetermined, fmt.Sprintf("第 %d 行：%s（指向工作区之外或上级路径，面板不判定）", lineNumber, source))
		return
	}
	if !strings.HasPrefix(source, "./") {
		// 既不是 ./ 开头也不是绝对路径：这是命名卷或容器内路径，不是宿主文件引用。
		return
	}
	relative := strings.TrimPrefix(source, "./")
	resolved := filepath.Join(composeDir, relative)
	// 引用以 compose 目录为基准，但仍要断言它没借 ./ 之外的写法跑出工作区。
	within, err := withinWorkspace(workspaceDir, resolved)
	if err != nil {
		r.Undetermined = append(r.Undetermined, fmt.Sprintf("第 %d 行：%s（解析后超出工作区范围）", lineNumber, source))
		return
	}
	display := filepath.ToSlash(within)
	if display == "." {
		display = relative
	}
	_, statErr := os.Stat(resolved)
	if statErr != nil && !os.IsNotExist(statErr) {
		r.Undetermined = append(r.Undetermined, fmt.Sprintf("第 %d 行：%s（无法读取该路径状态）", lineNumber, source))
		return
	}
	r.References = append(r.References, Reference{
		Raw:    value,
		Kind:   kind,
		Line:   lineNumber,
		Path:   display,
		Scope:  workspaceDir,
		Exists: statErr == nil,
	})
}

// ambiguous 判定一条写法是否超出可信解析范围。
func ambiguous(value string) bool {
	if strings.Contains(value, "${") || strings.Contains(value, "$") {
		return true
	}
	if strings.HasPrefix(value, "*") || strings.Contains(value, "&") {
		return true
	}
	if strings.ContainsAny(value, "{}[]") {
		return true
	}
	if strings.HasPrefix(value, "!") || strings.HasPrefix(value, "?") {
		return true
	}
	return false
}

// stripInlineComment 去掉引号外的行内 # 注释。
func stripInlineComment(value string) string {
	var quote byte
	for index := 0; index < len(value); index++ {
		char := value[index]
		if quote != 0 {
			if char == quote {
				quote = 0
			}
			continue
		}
		if char == '\'' || char == '"' {
			quote = char
			continue
		}
		if char == '#' && (index == 0 || value[index-1] == ' ') {
			return strings.TrimSpace(value[:index])
		}
	}
	return value
}

// splitKey 拆 `key: value`，保留值里的冒号（路径与端口都会带）。
func splitKey(line string) (key, value string, ok bool) {
	colon := strings.Index(line, ":")
	if colon <= 0 {
		return "", "", false
	}
	key = strings.TrimSpace(line[:colon])
	if strings.ContainsAny(key, `"'#`) {
		return "", "", false
	}
	value = strings.TrimSpace(line[colon+1:])
	// 形如 `- ./x:/y` 的行没有键，冒号前是路径片段，不当键处理。
	if strings.HasPrefix(key, "-") {
		return "", "", false
	}
	return key, value, true
}

// withinWorkspace 返回 resolved 相对工作区的路径；越界即报错。
func withinWorkspace(workspaceDir, resolved string) (string, error) {
	rel, err := filepath.Rel(workspaceDir, filepath.Clean(resolved))
	if err != nil {
		return "", err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel) {
		return "", fmt.Errorf("路径超出工作区范围")
	}
	return rel, nil
}
