package panel

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"
)

const buildHome = "/var/lib/elysian-build"

type buildCache struct {
	Bun     string
	Modules string
	Go      string
}

func buildAccountIDs() (int, int, error) {
	account, err := user.Lookup("elysian-build")
	if err != nil {
		return 0, 0, fmt.Errorf("无法读取无特权构建账号：%w", err)
	}
	uid, uidErr := strconv.Atoi(account.Uid)
	gid, gidErr := strconv.Atoi(account.Gid)
	if uidErr != nil || gidErr != nil || uid <= 0 || gid < 0 {
		return 0, 0, fmt.Errorf("无特权构建账号身份无效")
	}
	return uid, gid, nil
}

// 缓存位于任务目录之外；父目录不可由构建账号替换，已有缓存只核验、不递归 chown。
func prepareBuildCache(home string, uid, gid int) (buildCache, bool, error) {
	root := filepath.Join(home, "cache")
	cache := buildCache{Bun: filepath.Join(root, "bun"), Modules: filepath.Join(root, "go-mod"), Go: filepath.Join(root, "go-build")}
	initialized := false
	for _, dir := range []struct {
		path     string
		uid, gid int
		mode     os.FileMode
	}{
		{home, os.Geteuid(), os.Getegid(), 0755},
		{root, os.Geteuid(), os.Getegid(), 0755},
		{cache.Bun, uid, gid, 0700},
		{cache.Modules, uid, gid, 0700},
		{cache.Go, uid, gid, 0700},
	} {
		created, err := ensureBuildCacheDirectory(dir.path, dir.mode, dir.uid, dir.gid)
		if err != nil {
			return buildCache{}, initialized, err
		}
		initialized = initialized || created
	}
	return cache, initialized, nil
}

func ensureBuildCacheDirectory(path string, mode os.FileMode, uid, gid int) (bool, error) {
	created := false
	if err := os.Mkdir(path, mode); err == nil {
		created = true
	} else if !os.IsExist(err) {
		return false, fmt.Errorf("无法创建构建缓存目录 %s：%w", path, err)
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return created, fmt.Errorf("构建缓存路径不是可信目录 %s：%w", path, err)
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	if created {
		if err := f.Chown(uid, gid); err != nil {
			return true, fmt.Errorf("无法设置构建缓存归属 %s：%w", path, err)
		}
		if err := f.Chmod(mode); err != nil {
			return true, fmt.Errorf("无法设置构建缓存权限 %s：%w", path, err)
		}
	}
	info, err := f.Stat()
	if err != nil {
		return created, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != uid || int(stat.Gid) != gid || info.Mode().Perm() != mode || info.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 {
		return created, fmt.Errorf("构建缓存目录归属或权限异常：%s", path)
	}
	return created, nil
}

func releaseBuildCommand(ctx context.Context, stage, source, output, sha string, cache buildCache) *exec.Cmd {
	// 环境直接交给 Go/Bun，兼容既有安装中不认识持久缓存的 build-release.sh。
	c := exec.CommandContext(ctx, "runuser", "-u", "elysian-build", "--", "env", "HOME="+stage,
		"PATH=/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin",
		"BUN_INSTALL_CACHE_DIR="+cache.Bun, "GOMODCACHE="+cache.Modules, "GOCACHE="+cache.Go, "GOFLAGS=-trimpath",
		"bash", filepath.Join(InstallRoot, "maintenance", "build-release.sh"), source, output, sha)
	c.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8"}
	return c
}
