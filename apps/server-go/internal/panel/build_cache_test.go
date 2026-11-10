package panel

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildCachePersistsOutsideTaskDirectories(t *testing.T) {
	base := t.TempDir()
	home := filepath.Join(base, "build-home")
	cache, initialized, err := prepareBuildCache(home, os.Geteuid(), os.Getegid())
	if err != nil || !initialized {
		t.Fatalf("首次准备缓存失败：%v %v", initialized, err)
	}
	sentinel := filepath.Join(cache.Modules, "downloaded-module")
	if err := os.WriteFile(sentinel, []byte("已下载"), 0400); err != nil {
		t.Fatal(err)
	}
	for _, task := range []string{"first", "second"} {
		stage := filepath.Join(base, "tasks", task)
		if err := os.MkdirAll(stage, 0700); err != nil {
			t.Fatal(err)
		}
		command := releaseBuildCommand(context.Background(), stage, filepath.Join(stage, "source"), filepath.Join(stage, "artifact"), strings.Repeat("a", 40), cache)
		joined := strings.Join(command.Args, "\n")
		for _, variable := range []string{"HOME=" + stage, "BUN_INSTALL_CACHE_DIR=" + cache.Bun, "GOMODCACHE=" + cache.Modules, "GOCACHE=" + cache.Go, "GOFLAGS=-trimpath -p=1", "GOMAXPROCS=2", "GOMEMLIMIT=768MiB"} {
			if !strings.Contains(joined, "\n"+variable+"\n") {
				t.Fatalf("旧维护脚本缺少直接生效的缓存环境：%s", variable)
			}
		}
		if !strings.Contains(joined, "-u\nelysian-build\n--\nenv\n") || !strings.Contains(joined, "/maintenance/build-release.sh\n") {
			t.Fatal("必须继续使用无特权账号和既有维护脚本")
		}
		if err := os.RemoveAll(stage); err != nil {
			t.Fatal(err)
		}
	}
	_, initialized, err = prepareBuildCache(home, os.Geteuid(), os.Getegid())
	if err != nil || initialized {
		t.Fatalf("缓存复用错误：%v %v", initialized, err)
	}
	if data, err := os.ReadFile(sentinel); err != nil || string(data) != "已下载" {
		t.Fatal("清理任务目录不能删除或重写缓存")
	}
}

func TestBuildCacheRejectsUntrustedDirectories(t *testing.T) {
	for _, tc := range []string{"home-link", "cache-link", "leaf-link", "regular-file", "permissions", "parent-permissions", "owner"} {
		t.Run(tc, func(t *testing.T) {
			home := filepath.Join(t.TempDir(), "home")
			cache, _, err := prepareBuildCache(home, os.Geteuid(), os.Getegid())
			if err != nil {
				t.Fatal(err)
			}
			switch tc {
			case "home-link", "cache-link", "leaf-link":
				path := map[string]string{"home-link": home, "cache-link": filepath.Join(home, "cache"), "leaf-link": cache.Bun}[tc]
				if err := os.RemoveAll(path); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(t.TempDir(), path); err != nil {
					t.Fatal(err)
				}
			case "regular-file":
				if err := os.Remove(cache.Go); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(cache.Go, nil, 0700); err != nil {
					t.Fatal(err)
				}
			case "permissions", "parent-permissions":
				path := cache.Go
				if tc == "parent-permissions" {
					path = home
				}
				if err := os.Chmod(path, 0777); err != nil {
					t.Fatal(err)
				}
			case "owner":
				if os.Geteuid() != 0 {
					t.Skip("变更归属反例需要容器内 root")
				}
				if err := os.Chown(cache.Modules, 12345, 12345); err != nil {
					t.Fatal(err)
				}
			}
			if _, _, err := prepareBuildCache(home, os.Geteuid(), os.Getegid()); err == nil {
				t.Fatal("不可信缓存目录必须在构建前拒绝，不能修正归属或继续执行")
			}
		})
	}
}
