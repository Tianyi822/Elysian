package files

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"strconv"
	"strings"

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

// 搜索结果条数上限：触顶即停止遍历返回已命中部分。
const searchMaxResults = 1000

// stagingDirPrefix 暂存目录名前缀：随机段不可预测，目标目录里的抢注者无法提前占住
// 这个名字。代价是复制/压缩期间它会短暂出现在目标目录的列举里（结束后立即清理）；
// 同文件系统是 rename(2) 发布的前提，因此暂存只能落在目标目录内。
const stagingDirPrefix = ".elysian-staging-"

// stagedArtifactName 暂存产物名：固定值。cp/tar 的目标侧符号链接是跟随的（见安全
// 红线），产物因此先写进私有暂存目录；万一暂存目录本身被换链，被写出的也是这个固定
// 名字，不由抢注者指定成 authorized_keys 之类的敏感名。
const stagedArtifactName = ".payload"

// 暂存目录创建尝试次数：随机名撞车极罕见，仅作防御性上限。
const stagingCreateAttempts = 16

// 发布重试上限：目标名被抢注时按 mock 的占用法则换名重试，反复被抢则如实报错。
const publishAttempts = 4

// 规模上限的中文文案（两个语境只差尾段）。
var (
	sizeLimitMessage      = fmt.Sprintf("目录规模超出统计上限（%d 个条目），请缩小统计范围", walkMaxNodes)
	operationLimitMessage = fmt.Sprintf("目录规模超出操作上限（%d 个条目）", walkMaxNodes)
)

// filePermissionInput 权限变更输入：与 web 侧 FilePermissionInput 结构一致。
type filePermissionInput struct {
	mode      string
	owner     string
	recursive bool // 只对目录有意义：连同全部后代一起改。
}

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

// fileSearchResult 一条搜索结果：条目本身的全量字段外加它在树中的绝对路径。
type fileSearchResult struct {
	fileEntry
	Path string `json:"path"`
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
	deps                hostDeps
	accounts            seam.SystemAccounts
	forbiddenPrefixes   []string
	searchPrunePrefixes []string
}

// newService 构造服务编排：deps 为宿主访问出口，accounts 为 getent 账号通道。
func newService(deps hostDeps, accounts seam.SystemAccounts) *filesService {
	return &filesService{
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

// anchorEqual 锚点严格相等（含双 nil）：不能用「字符串前缀」复验锚点（/a/b2 会误命中
// /a/b 前缀），必须逐值比较。
func anchorEqual(resolved, anchor *string) bool {
	if resolved == nil || anchor == nil {
		return resolved == nil && anchor == nil
	}
	return *resolved == *anchor
}

// assertDirAnchorUnchanged 目录锚点复验：resolvedOrNull 取值与锚点捕获时严格相等
// （含双 nil）才放行。锚点捕获与命令执行之间目标目录被整体换成符号链接（如 /tmp →
// /root/.ssh）时，后续 cp/mv/tar 会经链接把产物落进保护区，这里在命令执行前拒绝。
// 回普通错误（500 口径）：目录被换链不是客户端的请求错误，不伪装成 invalidRequest。
func (s *filesService) assertDirAnchorUnchanged(dirPath string, anchor *string) error {
	resolved, err := s.resolvedOrNull(dirPath)
	if err != nil {
		return err
	}
	if !anchorEqual(resolved, anchor) {
		return fmt.Errorf("目标目录在操作期间被替换，已中止：%s", dirPath)
	}
	return nil
}

// verifyArtifactWithinAnchor 执行后落点校验：产物必须仍在锚点目录内。先 lstat：产物
// 消失直接中止；产物本身是符号链接时不做 realpath 包含判定（realpath 会跟随产物自身
// 的链接——活链接解析到锚点外误判写穿、断链回 nil 后再前缀判定会误拒，而产物自身是否
// 为链接与写穿无关），改验父目录锚点复验，中间组件换链由它抓住。非符号链接产物
// realpath 不在锚点之下（含解析失败）时，先尽力清理产物（rm 对符号链接只摘链接本身，
// 无穿透风险）再中止；anchor 为 nil 时只做父目录锚点复验（复核时断链的路径命令自身
// 会先失败，到不了这里，防御性收口）。
func (s *filesService) verifyArtifactWithinAnchor(artifactPath, anchorDirPath string, anchor *string) error {
	stats, err := s.lstatOrNull(artifactPath)
	if err != nil {
		return err
	}
	if stats == nil {
		return fmt.Errorf("产物落点异常，已清理并中止：%s", artifactPath)
	}
	if stats.isSymlink() || anchor == nil {
		return s.assertDirAnchorUnchanged(anchorDirPath, anchor)
	}
	resolved, err := s.resolvedOrNull(artifactPath)
	if err != nil {
		return err
	}
	if resolved == nil || !strings.HasPrefix(*resolved, *anchor+"/") {
		_ = s.deps.RmPath(artifactPath) // 尽力清理，吞错（对齐 TS rmPath().catch(() => {})）
		return fmt.Errorf("产物落点异常，已清理并中止：%s", artifactPath)
	}
	return nil
}

// assertNotForbiddenTargetPath 派生落点的窄版禁区：只做字符串前缀判定，不做 realpath
// 复核。派生出的目标名是本次操作即将创建的最终组件——它若已被抢注为符号链接，
// rename(2) 只替换链接本身、不跟随，按占用法则换名即可；而父目录的 realpath 复核已由
// 各入口的完整判定覆盖。这里挡的是「名字恰好补齐一条禁区路径」——在保护区内造出新条目。
func (s *filesService) assertNotForbiddenTargetPath(target string) error {
	if _, hit := matchPathPrefix(target, s.forbiddenPrefixes); hit {
		return shared.InvalidRequest("拒绝操作受保护路径：" + target)
	}
	return nil
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

// assertDestNotInsideSource 目标目录在源目录内部（含相等）：字符串判断 + realpath 复核
// （中间组件符号链接会绕过字符串判断）。action 为「复制」或「移动」。
func (s *filesService) assertDestNotInsideSource(src, destDir, action string) error {
	inside := func(target, source string) bool {
		return target == source || strings.HasPrefix(target, source+"/")
	}
	if inside(destDir, src) {
		return shared.InvalidRequest("不能把目录" + action + "到它自己内部")
	}
	resolvedSrc, err := s.resolvedOrNull(src)
	if err != nil {
		return err
	}
	resolvedDest, err := s.resolvedOrNull(destDir)
	if err != nil {
		return err
	}
	if resolvedSrc != nil && resolvedDest != nil && inside(*resolvedDest, *resolvedSrc) {
		return shared.InvalidRequest("不能把目录" + action + "到它自己内部")
	}
	return nil
}

// deriveUniqueName 目标重名时派生「 副本」后缀，副本再撞车往下编号（mock 同算法；
// 名字与「副本」之间是半角空格）。
func (s *filesService) deriveUniqueName(destDir, name string) (string, error) {
	dirents, err := s.deps.Readdir(destDir)
	if err != nil {
		return "", err
	}
	taken := make(map[string]bool, len(dirents))
	for _, dirent := range dirents {
		taken[dirent.name] = true
	}
	if !taken[name] {
		return name, nil
	}
	candidate := name + " 副本"
	counter := 2
	for taken[candidate] {
		candidate = fmt.Sprintf("%s 副本 %d", name, counter)
		counter++
	}
	return candidate, nil
}

// precheckSourceTree 复制/压缩的预检：与 size 同款受限遍历，遇虚拟 FS 前缀报告拒绝
// （cp/tar 无排除能力），超限拒绝。
func (s *filesService) precheckSourceTree(src, action string) error {
	_, err := walkFileTree(s.deps, src, walkOptions{virtualDirs: virtualReject, onLimit: limitThrow})
	if err != nil {
		var virtualErr *walkVirtualDirError
		if errors.As(err, &virtualErr) {
			return shared.InvalidRequest("目录包含系统虚拟目录（/proc、/sys、/dev），无法" + action)
		}
		var limitErr *walkLimitError
		if errors.As(err, &limitErr) {
			return shared.InvalidRequest(operationLimitMessage)
		}
		return err
	}
	return nil
}

// randomHex16 16 位小写 hex 随机段：crypto/rand 在受支持平台上不会失败；极端失败时
// 全零后缀由 mkdir 撞车重试兜底（16 次尝试后如实报「无法在目标目录创建暂存目录」）。
func randomHex16() string {
	buf := make([]byte, 8)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

// createStagingDir 私有暂存目录：mkdir 独占创建（名字已被占用即换随机名重试，绝不复用
// 别人占住的名字），权限 0700。cp/tar 的产物先写在这里，最终名由发布时的 rename(2)
// 落位。调用点放在预检之后：预检可能遍历上万条，越晚建目录，「目标名被抢注」的窗口越小。
func (s *filesService) createStagingDir(destDir string) (string, error) {
	for attempt := 0; attempt < stagingCreateAttempts; attempt++ {
		candidate := childPathOf(destDir, stagingDirPrefix+randomHex16())
		err := s.deps.Mkdir(candidate, 0o700)
		if err == nil {
			return candidate, nil
		}
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		return "", fmt.Errorf("无法创建暂存目录（%s）：%s", candidate, errorText(err))
	}
	return "", fmt.Errorf("无法在目标目录创建暂存目录：%s", destDir)
}

// assertStagingIntact 暂存目录复核：仍是我们创建的那个目录（不是被换成符号链接的名字）
// 才允许发布。lstat 判定之外再做一次 realpath 过写禁区——锚点复验之后才被换链的暂存
// 目录名，解析后落进保护区的在这里拦下（防复验后才换链的第二道）。
func (s *filesService) assertStagingIntact(stagingDir string) error {
	stats, err := s.deps.Lstat(stagingDir)
	if err != nil {
		return fmt.Errorf("暂存目录不可用（%s）：%s", stagingDir, errorText(err))
	}
	if stats.isSymlink() || !stats.isDir() {
		return fmt.Errorf("暂存目录被抢占，已放弃发布：%s", stagingDir)
	}
	resolved, err := s.resolvedOrNull(stagingDir)
	if err != nil {
		return err
	}
	if resolved != nil {
		if _, hit := matchPathPrefix(*resolved, s.forbiddenPrefixes); hit {
			return fmt.Errorf("暂存目录被抢占，已放弃发布：%s", stagingDir)
		}
	}
	return nil
}

// publishCopyArtifact 复制产物的发布：最终名被占用（lstat 不跟随，断链符号链接也算
// 占用）时按 mock 的占用法则换「副本」名重试。落位一律用 rename(2)：目标名即使在复核
// 之后被换成符号链接，rename 也只替换链接本身、不跟随它（目录产物会以 ENOTDIR 失败，
// 随后换名重试）。
func (s *filesService) publishCopyArtifact(staged, destDir, baseName string) (string, string, error) {
	name := baseName
	var lastError error
	for attempt := 0; attempt < publishAttempts; attempt++ {
		destChild := childPathOf(destDir, name)
		occupied, err := s.lstatOrNull(destChild)
		if err != nil {
			return "", "", err
		}
		if occupied == nil {
			renameErr := s.deps.RenamePath(staged, destChild)
			if renameErr == nil {
				return name, destChild, nil
			}
			lastError = renameErr
		}
		name, err = s.deriveUniqueName(destDir, baseName)
		if err != nil {
			return "", "", err
		}
	}
	return "", "", fmt.Errorf(
		"发布复制产物失败（已换名重试 %d 次，目标名可能被抢占）：%s",
		publishAttempts, errorText(lastError),
	)
}

// publishArchive 压缩包的发布：最终名被抢占即按 mock 语义报「同名压缩包已存在」，
// 不换名也不写穿。复核与 rename 之间被抢占：名字确已被占用一律按该文案报出，
// 其余失败原样上抛。
func (s *filesService) publishArchive(staged, archivePath, archiveName string) error {
	exists, err := s.nameExists(archivePath)
	if err != nil {
		return err
	}
	if exists {
		return shared.InvalidRequest("同名压缩包已存在：" + archiveName)
	}
	if err := s.deps.RenamePath(staged, archivePath); err != nil {
		occupied, lerr := s.nameExists(archivePath)
		if lerr != nil {
			return lerr
		}
		if occupied {
			return shared.InvalidRequest("同名压缩包已存在：" + archiveName)
		}
		return err
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
	total, err := sumDescendantSizes(s.deps, normalized)
	if err != nil {
		var limitErr *walkLimitError
		if errors.As(err, &limitErr) {
			return 0, shared.InvalidRequest(sizeLimitMessage)
		}
		return 0, err
	}
	return total, nil
}

// CopyEntry 深拷贝进目标目录：cp -a 保留权限/属主/时间戳，目标重名自动派生副本名。
// 校验顺序即契约（逐条对齐盘点 §4.6），不得重排。
func (s *filesService) CopyEntry(ctx context.Context, srcPath, destDirPath string) (fileEntry, error) {
	src, err := normalizeServerFilePath(srcPath)
	if err != nil {
		return fileEntry{}, err
	}
	destDir, err := normalizeServerFilePath(destDirPath)
	if err != nil {
		return fileEntry{}, err
	}
	if src == "/" {
		return fileEntry{}, shared.InvalidRequest("根目录不能复制")
	}
	srcStats, err := s.statExisting(src, srcPath)
	if err != nil {
		return fileEntry{}, err
	}
	if _, err := s.statDirectory(destDir, destDirPath); err != nil {
		return fileEntry{}, err
	}
	if err := s.assertNotVirtualSource(src); err != nil {
		return fileEntry{}, err
	}
	srcIsDirectory := srcStats.isDir()
	if srcIsDirectory {
		if err := s.assertDestNotInsideSource(src, destDir, "复制"); err != nil {
			return fileEntry{}, err
		}
	}
	destDirAnchor, err := s.assertNotForbiddenWrite(destDir)
	if err != nil {
		return fileEntry{}, err
	}
	newName, err := s.deriveUniqueName(destDir, leafNameOf(src))
	if err != nil {
		return fileEntry{}, err
	}
	// 目标目录放行不代表派生出的目标名放行：源名恰好补齐一条禁区路径时（往 /root 落一个
	// 名为 .ssh 的条目），条目的完整路径已进保护区，与其余判据一样先于任何命令拒绝。
	if err := s.assertNotForbiddenTargetPath(childPathOf(destDir, newName)); err != nil {
		return fileEntry{}, err
	}
	if srcIsDirectory {
		if err := s.precheckSourceTree(src, "复制"); err != nil {
			return fileEntry{}, err
		}
	}
	stagingDir, err := s.createStagingDir(destDir)
	if err != nil {
		return fileEntry{}, err
	}
	// 暂存目录与残留产物一并清理（尽力而为，不掩盖原始错误）。
	defer func() { _ = s.deps.RmPath(stagingDir) }()

	staged := childPathOf(stagingDir, stagedArtifactName)
	// 锚点防换链：mkdir 前目标目录被换链会使暂存落进保护区，cp 执行前先拒。
	if err := s.assertDirAnchorUnchanged(destDir, destDirAnchor); err != nil {
		return fileEntry{}, err
	}
	args := []string{"-a", src, staged}
	if err := s.deps.RunCp(args); err != nil {
		return fileEntry{}, commandError("cp", args, err)
	}
	if err := s.assertStagingIntact(stagingDir); err != nil {
		return fileEntry{}, err
	}
	// rename 发布是穿透点：发布前再验一次锚点，发布后核验产物落点仍在锚点内。
	if err := s.assertDirAnchorUnchanged(destDir, destDirAnchor); err != nil {
		return fileEntry{}, err
	}
	publishedName, publishedPath, err := s.publishCopyArtifact(staged, destDir, newName)
	if err != nil {
		return fileEntry{}, err
	}
	if err := s.verifyArtifactWithinAnchor(publishedPath, destDir, destDirAnchor); err != nil {
		return fileEntry{}, err
	}
	uidNames, err := s.uidNameMap(ctx)
	if err != nil {
		return fileEntry{}, err
	}
	return s.readEntry(publishedPath, publishedName, uidNames)
}

// MoveEntry 移动进目标目录：mv -T 封死「目标意外是目录时把源挪进去」；重名同样派生
// 副本名。源的移动自带删除语义，与复制的只读源不同：源与目标都查完整写禁区。
func (s *filesService) MoveEntry(ctx context.Context, srcPath, destDirPath string) (fileEntry, error) {
	src, err := normalizeServerFilePath(srcPath)
	if err != nil {
		return fileEntry{}, err
	}
	destDir, err := normalizeServerFilePath(destDirPath)
	if err != nil {
		return fileEntry{}, err
	}
	if src == "/" {
		return fileEntry{}, shared.InvalidRequest("根目录不能移动")
	}
	inside := func(target, source string) bool {
		return target == source || strings.HasPrefix(target, source+"/")
	}
	// 字符串判定先于存在性检查（顺序即契约）。
	if inside(destDir, src) {
		return fileEntry{}, shared.InvalidRequest("不能把目录移动到它自己内部")
	}
	srcStats, err := s.statExisting(src, srcPath)
	if err != nil {
		return fileEntry{}, err
	}
	if _, err := s.statDirectory(destDir, destDirPath); err != nil {
		return fileEntry{}, err
	}
	if parentDirOf(src) == destDir {
		return fileEntry{}, shared.InvalidRequest("目标目录与源目录相同")
	}
	if _, err := s.assertNotForbiddenWrite(src); err != nil {
		return fileEntry{}, err
	}
	destDirAnchor, err := s.assertNotForbiddenWrite(destDir)
	if err != nil {
		return fileEntry{}, err
	}
	if srcStats.isDir() {
		if err := s.assertDestNotInsideSource(src, destDir, "移动"); err != nil {
			return fileEntry{}, err
		}
	}
	newName, err := s.deriveUniqueName(destDir, leafNameOf(src))
	if err != nil {
		return fileEntry{}, err
	}
	destChild := childPathOf(destDir, newName)
	// 同复制：目标目录放行不代表派生出的目标名放行（源名恰好补齐禁区路径）。
	if err := s.assertNotForbiddenTargetPath(destChild); err != nil {
		return fileEntry{}, err
	}
	// 锚点防换链：mv 执行前复验目标目录、执行后核验产物落点仍在锚点内。
	if err := s.assertDirAnchorUnchanged(destDir, destDirAnchor); err != nil {
		return fileEntry{}, err
	}
	args := []string{"-T", src, destChild}
	if err := s.deps.RunMv(args); err != nil {
		return fileEntry{}, commandError("mv", args, err)
	}
	if err := s.verifyArtifactWithinAnchor(destChild, destDir, destDirAnchor); err != nil {
		return fileEntry{}, err
	}
	uidNames, err := s.uidNameMap(ctx)
	if err != nil {
		return fileEntry{}, err
	}
	return s.readEntry(destChild, newName, uidNames)
}

// RenameEntry 重命名：名称非法或同级重名报错；名字没变不执行任何命令，原样回读返回。
func (s *filesService) RenameEntry(ctx context.Context, path, newName string) (fileEntry, error) {
	trimmed := jsTrim(newName)
	if !isValidFileName(trimmed) {
		return fileEntry{}, shared.InvalidRequest("无效的名称：" + newName)
	}
	normalized, err := normalizeServerFilePath(path)
	if err != nil {
		return fileEntry{}, err
	}
	if normalized == "/" {
		return fileEntry{}, shared.InvalidRequest("根目录不能重命名")
	}
	parent := parentDirOf(normalized)
	if _, err := s.statDirectory(parent, parent); err != nil {
		return fileEntry{}, err
	}
	leaf := leafNameOf(normalized)
	// 存在性走 lstat：断链符号链接也算存在（rename(2) 搬的正是链接名本身）。
	existing, err := s.lstatOrNull(normalized)
	if err != nil {
		return fileEntry{}, err
	}
	if existing == nil {
		return fileEntry{}, shared.InvalidRequest("条目不存在：" + path)
	}
	if trimmed == leaf {
		// 名字没变：呈现与 list/search 同口径（符号链接按指向呈现，断链才回退链接自身）。
		stats, err := s.statListedEntry(normalized)
		if err != nil {
			return fileEntry{}, err
		}
		if stats == nil {
			return fileEntry{}, shared.InvalidRequest("条目不存在：" + path)
		}
		uidNames, err := s.uidNameMap(ctx)
		if err != nil {
			return fileEntry{}, err
		}
		return entryOf(leaf, *stats, uidNames), nil
	}
	siblings, err := s.deps.Readdir(parent)
	if err != nil {
		return fileEntry{}, err
	}
	for _, dirent := range siblings {
		if dirent.name == trimmed {
			return fileEntry{}, shared.InvalidRequest("同名条目已存在：" + trimmed)
		}
	}
	if _, err := s.assertNotForbiddenWrite(normalized); err != nil {
		return fileEntry{}, err
	}
	// 父目录此前只有 statDirectory（stat 跟随符号链接，拦不住换链）：这里补完整写
	// 禁区判定并捕获锚点，顺带堵住父目录静态换链而条目 realpath 因 ENOENT 回 nil 的漏判。
	parentAnchor, err := s.assertNotForbiddenWrite(parent)
	if err != nil {
		return fileEntry{}, err
	}
	target := childPathOf(parent, trimmed)
	// 目标名可能恰好补齐一条禁区路径（父目录放行、名字补齐），按同一道判定拒绝。
	if err := s.assertNotForbiddenTargetPath(target); err != nil {
		return fileEntry{}, err
	}
	// 锚点防换链：rename 执行前复验父目录、执行后核验产物落点仍在锚点内。
	if err := s.assertDirAnchorUnchanged(parent, parentAnchor); err != nil {
		return fileEntry{}, err
	}
	if err := s.deps.RenamePath(normalized, target); err != nil {
		return fileEntry{}, fmt.Errorf("重命名失败（%s → %s）：%s", normalized, target, errorText(err))
	}
	if err := s.verifyArtifactWithinAnchor(target, parent, parentAnchor); err != nil {
		return fileEntry{}, err
	}
	uidNames, err := s.uidNameMap(ctx)
	if err != nil {
		return fileEntry{}, err
	}
	return s.readEntry(target, trimmed, uidNames)
}

// CompressEntry 压缩成同级的「名称.tar.gz」：tar 打包符号链接成员本身、不跟随。
func (s *filesService) CompressEntry(ctx context.Context, path string) (fileEntry, error) {
	normalized, err := normalizeServerFilePath(path)
	if err != nil {
		return fileEntry{}, err
	}
	if normalized == "/" {
		return fileEntry{}, shared.InvalidRequest("根目录不能压缩")
	}
	parent := parentDirOf(normalized)
	if _, err := s.statDirectory(parent, parent); err != nil {
		return fileEntry{}, err
	}
	leaf := leafNameOf(normalized)
	stats, err := s.statExisting(normalized, path)
	if err != nil {
		return fileEntry{}, err
	}
	archiveName := leaf + ".tar.gz"
	archivePath := childPathOf(parent, archiveName)
	occupied, err := s.nameExists(archivePath)
	if err != nil {
		return fileEntry{}, err
	}
	if occupied {
		return fileEntry{}, shared.InvalidRequest("同名压缩包已存在：" + archiveName)
	}
	if _, err := s.assertNotForbiddenWrite(normalized); err != nil {
		return fileEntry{}, err
	}
	parentAnchor, err := s.assertNotForbiddenWrite(parent)
	if err != nil {
		return fileEntry{}, err
	}
	// 产物名恒为 `<名>.tar.gz`，今天不可能等于清单里的任何前缀；仍过同一道判定，
	// 让「派生落点全部先于命令过写禁区判定」这条规律完整可审，清单扩张时不留缺口。
	if err := s.assertNotForbiddenTargetPath(archivePath); err != nil {
		return fileEntry{}, err
	}
	if stats.isDir() {
		if err := s.precheckSourceTree(normalized, "压缩"); err != nil {
			return fileEntry{}, err
		}
	}
	stagingDir, err := s.createStagingDir(parent)
	if err != nil {
		return fileEntry{}, err
	}
	defer func() { _ = s.deps.RmPath(stagingDir) }()

	staged := childPathOf(stagingDir, stagedArtifactName)
	args := []string{"-czf", staged, "-C", parent, "--", leaf} // `--` 分隔防名字当选项
	// 锚点防换链：tar 执行前与发布前各复验一次父目录，发布后核验产物落点。
	if err := s.assertDirAnchorUnchanged(parent, parentAnchor); err != nil {
		return fileEntry{}, err
	}
	if err := s.deps.RunTar(args); err != nil {
		return fileEntry{}, commandError("tar", args, err)
	}
	if err := s.assertStagingIntact(stagingDir); err != nil {
		return fileEntry{}, err
	}
	if err := s.assertDirAnchorUnchanged(parent, parentAnchor); err != nil {
		return fileEntry{}, err
	}
	if err := s.publishArchive(staged, archivePath, archiveName); err != nil {
		return fileEntry{}, err
	}
	if err := s.verifyArtifactWithinAnchor(archivePath, parent, parentAnchor); err != nil {
		return fileEntry{}, err
	}
	uidNames, err := s.uidNameMap(ctx)
	if err != nil {
		return fileEntry{}, err
	}
	return s.readEntry(archivePath, archiveName, uidNames)
}

// Chmod 改权限与属主：非递归两个原语直落；递归三段（复核 → 收集 → 过滤后执行），
// 绝不半改。收集/过滤段的拒绝保证零命令；执行段中途某项失败会留部分已改
// （每项 chmod 后 chown，两原语非原子）。
func (s *filesService) Chmod(ctx context.Context, path string, input filePermissionInput) error {
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

// Search 全树搜索：契约 matchesFilePath 口径（去全部空白+小写，名称或完整路径任一
// 命中）。遍历全程 lstat 不跟随（防循环与 /proc、/sys 陷阱），命中条目的呈现与 list
// 同口径：逐条补一次跟随 stat（契约「符号链接按其指向呈现，不单列一类」），断链才
// 回退 lstat——与 list 共用 statListedEntry，两个读路径的条目字段不会各说各话。
// 触顶即静默截断：报错替代截断会让 `/` 下搜常见词必然失败，搜索整体不可用，两害取其轻。
func (s *filesService) Search(ctx context.Context, keyword string) ([]fileSearchResult, error) {
	if normalizeFileSearch(keyword) == "" {
		return []fileSearchResult{}, nil // 空关键词不碰文件系统
	}
	uidNames, err := s.uidNameMap(ctx)
	if err != nil {
		return nil, err
	}
	type matchedEntry struct {
		path string
		name string
	}
	matched := []matchedEntry{}
	_, err = walkFileTree(s.deps, "/", walkOptions{
		virtualDirs: virtualPrune,
		onLimit:     limitStop,
		extraPrune: func(entryPath, entryName string) bool {
			for _, pruneName := range searchPruneDirNames {
				if entryName == pruneName {
					return true
				}
			}
			_, hit := matchPathPrefix(entryPath, s.searchPrunePrefixes)
			return hit
		},
		onEntry: func(entry walkEntry) bool {
			if matchesFilePath(keyword, entry.name, entry.path) {
				matched = append(matched, matchedEntry{path: entry.path, name: entry.name})
			}
			return len(matched) < searchMaxResults
		},
	})
	if err != nil {
		return nil, err
	}
	results := make([]fileSearchResult, 0)
	for _, entry := range matched {
		stats, err := s.statListedEntry(entry.path)
		if err != nil {
			return nil, err
		}
		if stats == nil {
			continue
		}
		results = append(results, fileSearchResult{fileEntry: entryOf(entry.name, *stats, uidNames), Path: entry.path})
	}
	return results, nil
}

// 确保 filesService 满足服务调用面（编译期锚点）。
var _ fileService = (*filesService)(nil)
