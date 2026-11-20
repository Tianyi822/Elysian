package files

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

/*
 * 文件管理的服务编排（filesService.ts 等价物）：把界面动作翻译成容器/VM 内 cp/mv/tar
 * 的真实执行与 fs 原语调用。校验顺序与中文错误文案逐字对齐 web 侧 mock
 * （apps/web/src/adapters/mock/filesData.ts）；全部宿主访问经 hostDeps 注入，
 * getent 走 seam.SystemAccounts（security 域实现）。
 *
 * 安全红线（对齐 filesService.ts 文件头，如实迁移不收紧也不放宽）：
 *   - 所有命令经注入的出口数组传参执行，绝不拼 shell 字符串；路径与文件名即使含空格、
 *     引号、`--` 也只是单个 argv 元素（控制字符已被路径判据拒绝，双保险）。
 *   - 写操作不跟随最终组件符号链接：chmod/chown 走 O_NOFOLLOW 句柄原语，最终组件是
 *     符号链接时显式抛中文错误；mv -T 与 rename 走 rename(2)，天然不跟随。
 *   - cp 与 tar 只在源侧不跟随：GNU 语义里目标名上的符号链接是跟随的（coreutils 9.4
 *     与 tar 1.35 实测都会写穿到链接目标），所以复制与压缩的产物一律先落进 mkdir
 *     独占创建的私有暂存目录（0700、名字带随机段），再用 rename(2) 发布到最终名。
 *   - 写禁区双道检查：归一化字符串前缀之外再做一次 realpath 复核，中间组件符号链接
 *     （如 /tmp/x → /root/.ssh）解析后清单依然命中；清单同时收录面板资产的字符串名
 *     与卷挂真身（/root/.Elysian 与 /var/lib/elysian）。
 *   - 锚点防换链（TOCTOU）：复制/移动/重命名/压缩四个写入口在复核时捕获目标目录的
 *     realpath 锚点，命令执行前复验锚点不变、执行后核验产物落点仍在锚点内。锚点复验
 *     与 mv/cp/tar 子进程 spawn 之间仍有毫秒级窗口，竞态赢家的写穿由执行后落点校验
 *     清理，但被覆盖的保护区原文件内容不可恢复——损害从「凭据接管」降为「保护区文件
 *     被删或被覆盖后清理、fail closed、可 resetpwd 恢复」，不承诺绝对防写穿。
 *   - 递归 chmod 分三段：入口 realpath 复核 → 受限遍历收集（超限在收集段拒绝，不留
 *     半改状态）→ 收集列表逐项过写禁区判定后才执行，chmod -R /root 砸不穿保护区。
 *   - 读遍历全程 lstat 不跟随符号链接（防循环与 /proc、/sys、/dev 陷阱），深度与
 *     节点双上限；写命令前先做同款预检，预检遇虚拟 FS 前缀直接拒绝。
 *   - 每次写操作完成后回读真实条目（stat 推导视图），绝不返回命令拼出来的乐观值。
 */

// 列举条数上限：超出截断（顺序本不保证，截断不破坏契约）。
const listMaxEntries = 10000

// 同一文件服务的 HTTP goroutine 共享扫描槽，避免批量统计耗尽磁盘 I/O。
const sizeScanConcurrency = 4

// 规模上限的中文文案（两个语境只差尾段）。
var (
	sizeLimitMessage      = fmt.Sprintf("目录规模超出统计上限（%d 个条目），请缩小统计范围", walkMaxNodes)
	operationLimitMessage = fmt.Sprintf("目录规模超出操作上限（%d 个条目）", walkMaxNodes)
)

// fileEntry 目录里的一个直接子项（FileEntry 契约形状）：kind 只有两值——目录为
// directory，其余（含 socket/fifo/设备）一律 file；目录条目整个省略 sizeBytes 字段
// （指针为 nil 时 JSON 自然消失）。键序即 JSON 输出序（对齐 TS 插入序）。
type fileEntry struct {
	Name       string `json:"name"`
	Kind       string `json:"kind"`
	Mode       string `json:"mode"`
	Owner      string `json:"owner"`
	SizeBytes  *int64 `json:"sizeBytes,omitempty"`
	ModifiedAt string `json:"modifiedAt"`
}

// fileService 与 web 侧 FilesAdapter 同形的服务调用面（路由层只依赖此接口，测试注入 fake）。
type fileService interface {
	List(ctx context.Context, dirPath string) ([]fileEntry, error)
	Size(ctx context.Context, nodePath string) (int64, error)
	CopyEntry(ctx context.Context, srcPath, destDirPath string) (fileEntry, error)
	MoveEntry(ctx context.Context, srcPath, destDirPath string) (fileEntry, error)
	RenameEntry(ctx context.Context, path, newName string) (fileEntry, error)
	CompressEntry(ctx context.Context, path string) (fileEntry, error)
	Chmod(ctx context.Context, path string, input filePermissionInput) error
	Search(ctx context.Context, keyword string) ([]fileSearchResult, error)
}

// filesService 服务编排实现：写禁区与剪枝清单在装配时按注入的 homeDir 建好，
// 操作内不再重复解析。
type filesService struct {
	mutationMu          sync.Mutex
	sizeScans           chan struct{}
	deps                hostDeps
	accounts            seam.SystemAccounts
	forbiddenPrefixes   []string
	searchPrunePrefixes []string
}

// newService 构造服务编排：deps 为宿主访问出口，accounts 为 getent 账号通道。
func newService(deps hostDeps, accounts seam.SystemAccounts) *filesService {
	return &filesService{
		sizeScans:           make(chan struct{}, sizeScanConcurrency),
		deps:                deps,
		accounts:            accounts,
		forbiddenPrefixes:   forbiddenWritePrefixes(deps.HomeDir()),
		searchPrunePrefixes: searchExtraPrunePrefixes(deps.HomeDir()),
	}
}

// commandError 命令失败的中文包装：argv 以空格 join（对齐 TS commandError）。
func commandError(command string, args []string, err error) error {
	argv := strings.Join(append([]string{command}, args...), " ")
	return fmt.Errorf("%s 执行失败（%s）：%s", command, argv, errorText(err))
}

// errorText 错误转文案：nil 回 "null"（对齐 TS String(null)，发布重试耗尽的兜底文案依赖）。
func errorText(err error) string {
	if err == nil {
		return "null"
	}
	return err.Error()
}

// fsErrorInChinese 非缺失类 fs 错误的中文上下文包装：errno 细节保留在冒号后，
// 绝不裸冒英文 500。
func fsErrorInChinese(context string, err error) error {
	return fmt.Errorf("%s：%s", context, errorText(err))
}

func (s *filesService) directoryMissing(path string) error {
	return shared.InvalidRequest("目录不存在：" + path)
}

// statExisting stat 一个必须存在的路径；不存在或中间组件不是目录统一报
// 「目录不存在：<label>」，其余错误带中文上下文上抛。
func (s *filesService) statExisting(path, label string) (entryStats, error) {
	stats, err := s.deps.Stat(path)
	if err != nil {
		if isMissingPathError(err) {
			return entryStats{}, s.directoryMissing(label)
		}
		return entryStats{}, fsErrorInChinese("读取路径状态失败（"+label+"）", err)
	}
	return stats, nil
}

// statDirectory stat 一个必须存在且是目录的路径；路径是文件同样报「目录不存在」
// （mock 的 findDirectory 同款）。
func (s *filesService) statDirectory(path, label string) (entryStats, error) {
	stats, err := s.statExisting(path, label)
	if err != nil {
		return entryStats{}, err
	}
	if !stats.isDir() {
		return entryStats{}, s.directoryMissing(label)
	}
	return stats, nil
}

// lstatOrNull 不跟随符号链接的 lstat：不存在（ENOENT 或中间组件不是目录）返回 nil。
func (s *filesService) lstatOrNull(path string) (*entryStats, error) {
	stats, err := s.deps.Lstat(path)
	if err == nil {
		return &stats, nil
	}
	if isMissingPathError(err) {
		return nil, nil
	}
	return nil, err
}

// nameExists 名字占用判定（lstat 口径）：断链符号链接也算占用——它挡着这个名字。
func (s *filesService) nameExists(path string) (bool, error) {
	stats, err := s.lstatOrNull(path)
	if err != nil {
		return false, err
	}
	return stats != nil, nil
}

// entryOf 条目视图组装：kind 只有两值（socket/fifo/设备按文件呈现），mode 取三位
// 八进制（不足三位前补 0），owner 解析不出名字时用 uid 数字字符串，目录无 sizeBytes；
// modifiedAt 对齐 TS Stats.mtime.toISOString()（UTC、毫秒三位、Z 结尾）。
func entryOf(name string, stats entryStats, uidNames map[int]string) fileEntry {
	kind := "file"
	if stats.isDir() {
		kind = "directory"
	}
	entry := fileEntry{
		Name:       name,
		Kind:       kind,
		Mode:       fmt.Sprintf("%03o", stats.mode.Perm()),
		Owner:      strconv.Itoa(stats.uid),
		ModifiedAt: stats.modTime.UTC().Format("2006-01-02T15:04:05.000Z"),
	}
	if owner, ok := uidNames[stats.uid]; ok {
		entry.Owner = owner
	}
	if !stats.isDir() {
		size := stats.size
		entry.SizeBytes = &size
	}
	return entry
}

// uidNameMap 一次全量 getent passwd 建 uid→名字映射：list 与 search 的 owner 呈现共用，
// 首个出现的名字优先。
func (s *filesService) uidNameMap(ctx context.Context) (map[int]string, error) {
	records, err := s.accounts.PasswdAll(ctx)
	if err != nil {
		return nil, commandError("getent", []string{"passwd"}, err)
	}
	nameByUID := make(map[int]string, len(records))
	for _, record := range records {
		if _, exists := nameByUID[record.UID]; !exists {
			nameByUID[record.UID] = record.Name
		}
	}
	return nameByUID, nil
}

// resolvedOrNull realpath 复核的取值：断链符号链接（ENOENT）无法解析，返回 nil 保留
// 字符串判定结果继续——后续的符号链接检查或命令自身会给出中文错误，不让英文 ENOENT
// 冒成 500。
func (s *filesService) resolvedOrNull(path string) (*string, error) {
	resolved, err := s.deps.Realpath(path)
	if err == nil {
		return &resolved, nil
	}
	if isMissingPathError(err) {
		return nil, nil
	}
	return nil, fsErrorInChinese("解析真实路径失败（"+path+"）", err)
}

// assertNotForbiddenWrite 写禁区判定（两道）：归一化路径前缀 + realpath 复核，命中任一
// 即拒绝。放行时返回 realpath 复核的取值作为目录锚点——判定内部本就要做这次 realpath，
// 零新增系统调用，调用方可拿它做命令执行前后的「锚点防换链」复验。
func (s *filesService) assertNotForbiddenWrite(path string) (*string, error) {
	if _, hit := matchPathPrefix(path, s.forbiddenPrefixes); hit {
		return nil, shared.InvalidRequest("拒绝操作受保护路径：" + path)
	}
	resolved, err := s.resolvedOrNull(path)
	if err != nil {
		return nil, err
	}
	if resolved != nil {
		if _, hit := matchPathPrefix(*resolved, s.forbiddenPrefixes); hit {
			return nil, shared.InvalidRequest("拒绝操作受保护路径：" + *resolved)
		}
	}
	return resolved, nil
}

// assertNotVirtualSource 复制源的窄版禁区：只拦虚拟 FS 前缀（cp -a /proc 会真的遍历
// 伪文件）。realpath 道用解析结果判（别名起点同样拒），错误文案两道都用入参归一化路径。
func (s *filesService) assertNotVirtualSource(path string) error {
	if _, hit := matchPathPrefix(path, virtualFsPrefixes); hit {
		return shared.InvalidRequest("拒绝操作系统虚拟目录：" + path)
	}
	resolved, err := s.resolvedOrNull(path)
	if err != nil {
		return err
	}
	if resolved != nil {
		if _, hit := matchPathPrefix(*resolved, virtualFsPrefixes); hit {
			return shared.InvalidRequest("拒绝操作系统虚拟目录：" + path)
		}
	}
	return nil
}

// statListedEntry 列举的单个条目 stat：「按指向呈现」不可得（断链 ENOENT/ENOTDIR、
// 链接环 ELOOP）回退 lstat 按链接自身呈现——一个环不炸整个列举；列举瞬间消失返回
// nil（调用方跳过），其余错误带中文上下文上抛。
func (s *filesService) statListedEntry(path string) (*entryStats, error) {
	stats, err := s.deps.Stat(path)
	if err == nil {
		return &stats, nil
	}
	if !isMissingPathError(err) && !isLinkLoopError(err) {
		return nil, fsErrorInChinese("读取条目状态失败（"+path+"）", err)
	}
	lstats, lerr := s.deps.Lstat(path)
	if lerr == nil {
		return &lstats, nil
	}
	if isMissingPathError(lerr) {
		return nil, nil
	}
	return nil, fsErrorInChinese("读取条目状态失败（"+path+"）", lerr)
}

// readEntry 写后回读：返回条目来自 fs 的真实状态，绝不返回命令拼出来的乐观值。
// 呈现与 list/search 共用 statListedEntry：符号链接按指向呈现，断链（如相对目标的
// 链接被复制到别处）回退 lstat 按链接自身呈现而不是报读取失败；条目确实消失才报错。
func (s *filesService) readEntry(path, name string, uidNames map[int]string) (fileEntry, error) {
	stats, err := s.statListedEntry(path)
	if err != nil {
		return fileEntry{}, err
	}
	if stats == nil {
		return fileEntry{}, fmt.Errorf("读取条目状态失败（%s）：条目已消失", path)
	}
	return entryOf(name, *stats, uidNames), nil
}

// List 列出目录的直接子项：断链符号链接回退 lstat 按文件呈现；顺序不保证；
// 收集满 10000 个非空条目即停（跳过消失条目不占额度）。
func (s *filesService) List(ctx context.Context, dirPath string) ([]fileEntry, error) {
	normalized, err := normalizeServerFilePath(dirPath)
	if err != nil {
		return nil, err
	}
	if _, err := s.statDirectory(normalized, dirPath); err != nil {
		return nil, err
	}
	dirents, err := s.deps.Readdir(normalized)
	if err != nil {
		return nil, err
	}
	uidNames, err := s.uidNameMap(ctx)
	if err != nil {
		return nil, err
	}
	entries := make([]fileEntry, 0) // 空目录也回 []（JSON 里是空数组，不是 null）
	for _, dirent := range dirents {
		if len(entries) >= listMaxEntries {
			break
		}
		stats, err := s.statListedEntry(childPathOf(normalized, dirent.name))
		if err != nil {
			return nil, err
		}
		if stats == nil {
			continue
		}
		entries = append(entries, entryOf(dirent.name, *stats, uidNames))
	}
	return entries, nil
}

// Size 递归统计大小：文件是自身大小，目录是全部后代之和（lstat 口径，符号链接按链接
// 字节计）。别名起点（符号链接指向 /proc 等）与直指同样拒绝：遍历起点不经前缀剪枝，
// 别名的子项路径不匹配虚拟前缀，会真实遍历伪文件内容。
func (s *filesService) Size(ctx context.Context, nodePath string) (int64, error) {
	normalized, err := normalizeServerFilePath(nodePath)
	if err != nil {
		return 0, err
	}
	select {
	case s.sizeScans <- struct{}{}:
		defer func() { <-s.sizeScans }()
	case <-ctx.Done():
		return 0, ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	stats, err := s.statExisting(normalized, nodePath)
	if err != nil {
		return 0, err
	}
	if err := s.assertNotVirtualSource(normalized); err != nil {
		return 0, err
	}
	if !stats.isDir() {
		return stats.size, nil
	}
	total, err := sumDescendantSizes(ctx, s.deps, normalized)
	if err != nil {
		var limitErr *walkLimitError
		if errors.As(err, &limitErr) {
			return 0, shared.InvalidRequest(sizeLimitMessage)
		}
		return 0, err
	}
	return total, nil
}

// 确保 filesService 满足服务调用面（编译期锚点）。
var _ fileService = (*filesService)(nil)
