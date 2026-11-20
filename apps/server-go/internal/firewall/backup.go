package firewall

import (
	"strings"

	"elysian/server/internal/paths"
)

// rulesBackupSuffix 规则文件的备份后缀：文件名保留原名，便于与目标对应。
const rulesBackupSuffix = ".elysian"

// backupPathOf 规则文件的备份路径：应用侧备份统一收进 ~/.Elysian/backups/（按原文件
// 名加后缀）；坏写入仍按这份备份回滚。
func backupPathOf(path string) string {
	name := path[strings.LastIndex(path, "/")+1:]
	return paths.BackupsDir + "/" + name + rulesBackupSuffix
}

// writeRulesFileWithBackup 写规则文件前先备份当前内容，再落新内容；文件尚不存在时跳过备份。
func writeRulesFileWithBackup(deps hostDeps, path string, content string) error {
	current, err := deps.ReadText(path)
	if err == nil {
		if err := deps.WriteText(backupPathOf(path), current); err != nil {
			return err
		}
	}
	return deps.WriteText(path, content)
}

// restoreRulesFromBackups 用备份恢复规则文件（v4 与 v6 都试）。直接落盘、不再先备份：
// 避免用当前可能损坏的内容覆盖掉唯一的好备份。返回是否至少恢复了一个文件。
func restoreRulesFromBackups(deps hostDeps, fwPaths FirewallPaths) bool {
	restored := false
	for _, path := range []string{fwPaths.BeforeRules, fwPaths.BeforeRulesV6} {
		backup := backupPathOf(path)
		if !deps.Exists(backup) {
			continue
		}
		content, err := deps.ReadText(backup)
		if err != nil {
			continue
		}
		if err := deps.WriteText(path, content); err == nil {
			restored = true
		}
	}
	return restored
}
