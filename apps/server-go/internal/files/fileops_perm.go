package files

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"strconv"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// filePermissionInput 权限变更输入：与 web 侧 FilePermissionInput 结构一致。
type filePermissionInput struct {
	mode      string
	owner     string
	recursive bool // 只对目录有意义：连同全部后代一起改。
}

// findPasswdRecord owner 反查：getent passwd <名> 取 uid/gid，查无报「未找到系统账号」
// （与 users 片一致；退出码 2 归一为空结果的语义由 seam.SystemAccounts 实现方提供）。
func (s *filesService) findPasswdRecord(ctx context.Context, name string) (*seam.PasswdRecord, error) {
	record, err := s.accounts.PasswdByName(ctx, name)
	if err != nil {
		return nil, commandError("getent", []string{"passwd", name}, err)
	}
	if record == nil {
		return nil, shared.InvalidRequest("未找到系统账号：" + name)
	}
	return record, nil
}

// Chmod 改权限与属主：非递归两个原语直落；递归三段（复核 → 收集 → 过滤后执行），
// 绝不半改。收集/过滤段的拒绝保证零命令；执行段中途某项失败会留部分已改
// （每项 chmod 后 chown，两原语非原子）。
func (s *filesService) Chmod(ctx context.Context, path string, input filePermissionInput) error {
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	normalized, err := normalizeServerFilePath(path)
	if err != nil {
		return err
	}
	if normalized == "/" {
		return shared.InvalidRequest("根目录不能改权限")
	}
	if !isValidFileMode(input.mode) {
		return shared.InvalidRequest("无效的权限位：" + input.mode)
	}
	ownerName := jsTrim(input.owner)
	if ownerName == "" {
		return shared.InvalidRequest("所有者不能为空")
	}
	stats, err := s.deps.Lstat(normalized)
	if err != nil {
		if isMissingPathError(err) {
			return shared.InvalidRequest("目录不存在：" + path)
		}
		return err
	}
	if input.recursive && !stats.isDir() {
		return shared.InvalidRequest("只有目录可以连同子目录一起改权限")
	}
	if !isValidHostUserName(ownerName) {
		return shared.InvalidRequest("无效的所有者名：" + ownerName)
	}
	owner, err := s.findPasswdRecord(ctx, ownerName)
	if err != nil {
		return err
	}
	if _, err := s.assertNotForbiddenWrite(normalized); err != nil {
		return err
	}
	// 最终组件是符号链接：改链接指向对象 = 借链接越权；改链接本身的权限位在 Linux 上无意义。
	if stats.isSymlink() {
		return shared.InvalidRequest("不能对符号链接执行该操作：" + path)
	}

	parsed, err := strconv.ParseUint(input.mode, 8, 32)
	if err != nil {
		return err // 已过 ^[0-7]{3}$ 判据，不会发生
	}
	modeBits := fs.FileMode(parsed)

	applyTo := func(target string) error {
		if err := s.deps.ChmodNoFollow(target, modeBits); err != nil {
			return fmt.Errorf("修改权限失败（%s）：%s", target, errorText(err))
		}
		if err := s.deps.ChownNoFollow(target, owner.UID, owner.GID); err != nil {
			return fmt.Errorf("修改属主失败（%s）：%s", target, errorText(err))
		}
		return nil
	}

	if !input.recursive {
		return applyTo(normalized)
	}
	// 收集段：受限遍历收集非符号链接后代，超限在这里拒绝——零条命令已执行，不留半改状态。
	descendants, err := collectDescendantPaths(s.deps, normalized)
	if err != nil {
		var limitErr *walkLimitError
		if errors.As(err, &limitErr) {
			return shared.InvalidRequest(operationLimitMessage)
		}
		return err
	}
	// 过滤段：入口复核只挡直接点名的路径，chmod -R /root 的收集列表里会出现 /root/.ssh、
	// /root/.bun 等保护区后代——不过滤就从上往下砸穿保护。收集路径由 lstat 遍历构造、
	// 不含符号链接中间组件，字符串前缀判定即可靠。
	for _, target := range descendants {
		if _, hit := matchPathPrefix(target, s.forbiddenPrefixes); hit {
			return shared.InvalidRequest("拒绝操作受保护路径：" + target)
		}
	}
	// 执行段：入口先于后代、后代按收集列表逐项。
	if err := applyTo(normalized); err != nil {
		return err
	}
	for _, target := range descendants {
		if err := applyTo(target); err != nil {
			return err
		}
	}
	return nil
}
