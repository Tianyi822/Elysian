package files

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

/*
 * 宿主访问的最小注入形状与真实接线（filesHostDeps.ts + shared/noFollowFs.ts 等价物）。
 * 服务编排只依赖 hostDeps 接口，测试注入内存 fake（树 + 命令账本 + 时序钩子），
 * 不执行任何真实命令。真实接线全部在容器/VM 内执行：无 unix socket、不碰 Docker
 * Engine、不连数据库——外部命令仅 cp/mv/tar，数组传参、绝不拼 shell 字符串。
 */

// entryStats 服务层视角的条目元数据（TS node:fs Stats 的消费子集）：类型位、大小、
// 修改时间与属主。mode 为完整 FileMode（含类型位），权限位经 Perm() 取。
type entryStats struct {
	mode    fs.FileMode
	size    int64
	modTime time.Time
	uid     int
	gid     int
}

func (s entryStats) isDir() bool     { return s.mode.IsDir() }
func (s entryStats) isSymlink() bool { return s.mode&fs.ModeSymlink != 0 }

// dirEntry readdir 的直接子项（withFileTypes 语义只消费名字；条目视图仍逐项 stat/lstat 组装）。
type dirEntry struct {
	name string
}

// hostDeps 宿主访问的最小注入形状（TS FilesHostDeps 同构）：fs 原语 + 命令出口。
type hostDeps interface {
	Readdir(path string) ([]dirEntry, error)
	Lstat(path string) (entryStats, error)
	// Stat 跟随符号链接的 stat：读操作按指向呈现（契约口径）。
	Stat(path string) (entryStats, error)
	// Realpath 解析全部符号链接后的绝对路径：写禁区复核用。
	Realpath(path string) (string, error)
	// RenamePath rename(2)：同目录改名永不跨设备，天然不跟随最终组件符号链接。
	RenamePath(from, to string) error
	// Mkdir 非递归 mkdir（已存在即回 EEXIST）：私有暂存目录的原子抢占。
	Mkdir(path string, mode fs.FileMode) error
	// RmPath recursive + force 的 rm：暂存目录与残留产物清理；对符号链接只摘链接本身。
	RmPath(path string) error
	RunCp(args []string) error
	RunMv(args []string) error
	RunTar(args []string) error
	// ChmodNoFollow / ChownNoFollow 不跟随最终组件符号链接的权限原语（O_NOFOLLOW
	// 句柄）：权限与属主绝不落到链接目标上。
	ChmodNoFollow(path string, mode fs.FileMode) error
	ChownNoFollow(path string, uid, gid int) error
	// HomeDir 写禁区与剪枝清单的 `/root` 前缀来源（真实接线传 os.UserHomeDir()，测试注入 /root）。
	HomeDir() string
}

// realHostDeps 真实接线：node:fs/promises 原语 + execFile 命令出口的 Go 对应物。
type realHostDeps struct{}

func newRealHostDeps() hostDeps { return realHostDeps{} }

// statsFromInfo 把 os.Stat/os.Lstat 的FileInfo 换成服务层形状；uid/gid 经 Stat_t 取
// （Linux/macOS 的 Sys() 都是 *syscall.Stat_t，其他平台回落 0）。
func statsFromInfo(info fs.FileInfo) entryStats {
	stats := entryStats{mode: info.Mode(), size: info.Size(), modTime: info.ModTime()}
	if raw, ok := info.Sys().(*syscall.Stat_t); ok {
		stats.uid = int(raw.Uid)
		stats.gid = int(raw.Gid)
	}
	return stats
}

func (realHostDeps) Readdir(path string) ([]dirEntry, error) {
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}
	out := make([]dirEntry, 0, len(entries))
	for _, entry := range entries {
		out = append(out, dirEntry{name: entry.Name()})
	}
	return out, nil
}

func (realHostDeps) Lstat(path string) (entryStats, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return entryStats{}, err
	}
	return statsFromInfo(info), nil
}

func (realHostDeps) Stat(path string) (entryStats, error) {
	info, err := os.Stat(path)
	if err != nil {
		return entryStats{}, err
	}
	return statsFromInfo(info), nil
}

// Realpath 对应 node fs.realpath：全部符号链接解析后的绝对路径；断链与缺失回 ENOENT
// 类错误，服务层按缺失归一。
func (realHostDeps) Realpath(path string) (string, error) {
	return filepath.EvalSymlinks(path)
}

func (realHostDeps) RenamePath(from, to string) error { return os.Rename(from, to) }

func (realHostDeps) Mkdir(path string, mode fs.FileMode) error { return os.Mkdir(path, mode) }

func (realHostDeps) RmPath(path string) error { return os.RemoveAll(path) }

// runToStdout 执行外部命令：失败时优先取子进程 stderr 的 trim 值，为空回退错误消息
// 本身（对齐 TS 接线层 commandFailure 的 detail 口径）；命令上下文由服务层拼装。
// 数组传参（exec 的参数切片），绝不拼 shell 字符串。
func runToStdout(name string, args []string) error {
	cmd := exec.Command(name, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if detail := strings.TrimSpace(stderr.String()); detail != "" {
			return errors.New(detail)
		}
		return err
	}
	return nil
}

func (realHostDeps) RunCp(args []string) error  { return runToStdout("cp", args) }
func (realHostDeps) RunMv(args []string) error  { return runToStdout("mv", args) }
func (realHostDeps) RunTar(args []string) error { return runToStdout("tar", args) }

// openNoFollow 以 O_RDONLY|O_NOFOLLOW 打开路径本身：最终组件是符号链接即 ELOOP；
// 中间组件（如 /root/.Elysian 指向持久卷）不受影响——O_NOFOLLOW 只作用于最后一段。
func openNoFollow(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
}

// ChmodNoFollow 以句柄收紧权限且不跟随最终组件符号链接：权限绝不落到链接目标上。
func (realHostDeps) ChmodNoFollow(path string, mode fs.FileMode) error {
	handle, err := openNoFollow(path)
	if err != nil {
		return err
	}
	defer handle.Close()
	return handle.Chmod(mode)
}

// ChownNoFollow 以句柄落属主且不跟随最终组件符号链接：属主绝不落到链接目标上。
func (realHostDeps) ChownNoFollow(path string, uid, gid int) error {
	handle, err := openNoFollow(path)
	if err != nil {
		return err
	}
	defer handle.Close()
	return handle.Chown(uid, gid)
}

// HomeDir 对应 os.homedir()：容器/VM 内为 /root。os.UserHomeDir 只读 HOME 环境变量，
// 读不到（环境异常）时回落容器内 root 的固定 home，保持清单形状稳定。
func (realHostDeps) HomeDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "/root"
	}
	return home
}
