package files

/*
 * 受限遍历原语的行为测试（fileTreeWalk.test.ts 对等）：内存树 fake（readdir/lstat），
 * 不碰真实文件系统。覆盖深度/节点上限、虚拟 FS 与额外剪枝、报告语义（reject 抛错、
 * prune 跳过）、大小求和口径（符号链接按链接字节、目录不累计）与收集段跳过符号链接。
 */

import (
	"errors"
	"fmt"
	"io/fs"
	"strings"
	"syscall"
	"testing"
	"time"
)

// walk 测试的局部助手。
var (
	walkPermFile = fs.FileMode(0o644)
	walkPermDir  = fs.FileMode(0o755)
)

const walkFakeMtimeUnix = int64(1789075200) // 2026-09-22T08:00:00Z

func errNoent() error  { return syscall.ENOENT }
func errNotdir() error { return syscall.ENOTDIR }

func fakeIndexName(i int) string { return fmt.Sprintf("f%d", i) }

// wd walk fake 的命名子项构造助手（保插入序）。
func wd(name string, node *walkNode) walkNamedNode {
	return walkNamedNode{name: name, node: node}
}

func containsIn(items []string, target string) bool {
	for _, item := range items {
		if item == target {
			return true
		}
	}
	return false
}

func equalStringSlices(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// walkNamedNode walk fake 的命名子节点（与 fakes_test.go 的树各自独立）。
type walkNamedNode struct {
	name string
	node *walkNode
}

// walkNode 简化树节点：遍历 fake 不解析符号链接指向（遍历不跟随）。
type walkNode struct {
	kind     fakeNodeKind
	size     int64
	children []walkNamedNode
}

func walkFile(size int64) *walkNode { return &walkNode{kind: fakeFileKind, size: size} }

func walkDir(children ...walkNamedNode) *walkNode {
	return &walkNode{kind: fakeDirKind, children: children}
}

func walkLink(target string) *walkNode {
	return &walkNode{kind: fakeLinkKind, size: int64(len(target))}
}

func (n *walkNode) child(name string) *walkNode {
	for _, child := range n.children {
		if child.name == name {
			return child.node
		}
	}
	return nil
}

func walkStatsOf(node *walkNode) entryStats {
	mode := walkPermFile
	switch node.kind {
	case fakeDirKind:
		mode = fs.ModeDir | walkPermDir
	case fakeLinkKind:
		mode = fs.ModeSymlink | walkPermDir
	}
	return entryStats{mode: mode, size: node.size, modTime: time.Unix(walkFakeMtimeUnix, 0).UTC()}
}

// walkFakeDeps 只实现 treeWalkDeps 的最小 fake：路径逐段查找，符号链接不解析。
type walkFakeDeps struct {
	root      *walkNode
	lstatFail map[string]bool // 指定路径 lstat 抛 ENOENT（列举瞬间消失用例）
}

func (d *walkFakeDeps) Readdir(path string) ([]dirEntry, error) {
	node := d.find(path)
	if node == nil {
		return nil, errNoent()
	}
	if node.kind != fakeDirKind {
		return nil, errNotdir()
	}
	out := make([]dirEntry, 0, len(node.children))
	for _, child := range node.children {
		out = append(out, dirEntry{name: child.name})
	}
	return out, nil
}

func (d *walkFakeDeps) Lstat(path string) (entryStats, error) {
	if d.lstatFail != nil && d.lstatFail[path] {
		return entryStats{}, errNoent()
	}
	node := d.find(path)
	if node == nil {
		return entryStats{}, errNoent()
	}
	return walkStatsOf(node), nil
}

func (d *walkFakeDeps) find(path string) *walkNode {
	current := d.root
	for _, segment := range segmentsOf(path) {
		if current.kind != fakeDirKind {
			return nil
		}
		next := current.child(segment)
		if next == nil {
			return nil
		}
		current = next
	}
	return current
}

// seedWalkTree 种子树：/var/log 有文件与符号链接，/proc 有伪文件，
// /srv/app/node_modules 有依赖树，/root/.bun 有缓存。
func seedWalkTree() *walkNode {
	return walkDir(
		wd("var", walkDir(
			wd("log", walkDir(
				wd("syslog", walkFile(100)),
				wd("auth.log", walkFile(40)),
				wd("archive", walkDir(wd("old.log", walkFile(10)))),
				wd("current", walkLink("/var/log/syslog")),
			)),
		)),
		wd("proc", walkDir(wd("cpuinfo", walkFile(0)), wd("uptime", walkFile(0)))),
		wd("srv", walkDir(
			wd("app", walkDir(
				wd("index.ts", walkFile(5)),
				wd("node_modules", walkDir(wd("pkg", walkDir(wd("index.js", walkFile(20)))))),
			)),
		)),
		wd("root", walkDir(wd(".bun", walkDir(wd("cache.bin", walkFile(30)))))),
	)
}

func TestWalkFileTree(t *testing.T) {
	t.Run("遍历全部后代（含嵌套），起点本身不作为条目回调", func(t *testing.T) {
		deps := &walkFakeDeps{root: seedWalkTree()}
		var seen []string
		outcome, err := walkFileTree(deps, "/var", walkOptions{
			virtualDirs: virtualPrune,
			onLimit:     limitThrow,
			onEntry: func(entry walkEntry) bool {
				seen = append(seen, entry.path)
				return true
			},
		})
		if err != nil {
			t.Fatalf("遍历失败：%v", err)
		}
		want := []string{
			"/var/log", "/var/log/syslog", "/var/log/auth.log",
			"/var/log/archive", "/var/log/archive/old.log", "/var/log/current",
		}
		if got := sortedStrings(seen); !equalStringSlices(got, sortedStrings(want)) {
			t.Fatalf("遍历结果 %v，期望 %v", got, want)
		}
		if outcome.visited != 6 || outcome.truncated {
			t.Fatalf("outcome = %+v，期望 visited=6 truncated=false", outcome)
		}
	})

	t.Run("节点上限触顶：throw 模式抛 walkLimitError，stop 模式标记截断", func(t *testing.T) {
		throwing := &walkFakeDeps{root: seedWalkTree()}
		_, err := walkFileTree(throwing, "/var/log", walkOptions{virtualDirs: virtualPrune, onLimit: limitThrow, maxNodes: 2})
		var limitErr *walkLimitError
		if !errors.As(err, &limitErr) {
			t.Fatalf("期望 walkLimitError，得到 %v", err)
		}

		stopping := &walkFakeDeps{root: seedWalkTree()}
		outcome, err := walkFileTree(stopping, "/var/log", walkOptions{virtualDirs: virtualPrune, onLimit: limitStop, maxNodes: 2})
		if err != nil {
			t.Fatalf("stop 模式不应报错：%v", err)
		}
		if outcome.visited != 2 || !outcome.truncated {
			t.Fatalf("outcome = %+v，期望 visited=2 truncated=true", outcome)
		}
	})

	t.Run("深度上限触顶：目录已到深度上限即无法下探，同样按模式抛错或截断", func(t *testing.T) {
		throwing := &walkFakeDeps{root: seedWalkTree()}
		_, err := walkFileTree(throwing, "/var", walkOptions{virtualDirs: virtualPrune, onLimit: limitThrow, maxDepth: 2})
		var limitErr *walkLimitError
		if !errors.As(err, &limitErr) {
			t.Fatalf("期望 walkLimitError，得到 %v", err)
		}

		stopping := &walkFakeDeps{root: seedWalkTree()}
		outcome, err := walkFileTree(stopping, "/var", walkOptions{virtualDirs: virtualPrune, onLimit: limitStop, maxDepth: 2})
		if err != nil {
			t.Fatalf("stop 模式不应报错：%v", err)
		}
		if !outcome.truncated {
			t.Fatalf("期望 truncated=true，得到 %+v", outcome)
		}
	})

	t.Run("虚拟 FS 前缀：prune 模式整树跳过，reject 模式抛 walkVirtualDirError 报告命中路径", func(t *testing.T) {
		pruning := &walkFakeDeps{root: seedWalkTree()}
		var seen []string
		if _, err := walkFileTree(pruning, "/", walkOptions{
			virtualDirs: virtualPrune,
			onLimit:     limitThrow,
			onEntry: func(entry walkEntry) bool {
				seen = append(seen, entry.path)
				return true
			},
		}); err != nil {
			t.Fatalf("遍历失败：%v", err)
		}
		for _, path := range seen {
			if len(path) >= 5 && path[:5] == "/proc" {
				t.Fatalf("prune 模式不应出现 /proc 后代：%s", path)
			}
		}

		rejecting := &walkFakeDeps{root: seedWalkTree()}
		_, err := walkFileTree(rejecting, "/", walkOptions{virtualDirs: virtualReject, onLimit: limitThrow})
		var virtualErr *walkVirtualDirError
		if !errors.As(err, &virtualErr) {
			t.Fatalf("期望 walkVirtualDirError，得到 %v", err)
		}
		if virtualErr.hitPath != "/proc" {
			t.Fatalf("hitPath = %q，期望 /proc", virtualErr.hitPath)
		}
	})

	t.Run("额外剪枝只对目录生效：node_modules 段与工具缓存前缀整树跳过", func(t *testing.T) {
		deps := &walkFakeDeps{root: seedWalkTree()}
		var seen []string
		if _, err := walkFileTree(deps, "/", walkOptions{
			virtualDirs: virtualPrune,
			onLimit:     limitStop,
			extraPrune: func(path, name string) bool {
				return name == "node_modules" || len(path) >= 9 && path[:9] == "/root/.bun"
			},
			onEntry: func(entry walkEntry) bool {
				seen = append(seen, entry.path)
				return true
			},
		}); err != nil {
			t.Fatalf("遍历失败：%v", err)
		}
		for _, path := range seen {
			if strings.Contains(path, "node_modules") || (len(path) >= 9 && path[:9] == "/root/.bun") {
				t.Fatalf("额外剪枝未生效：%s", path)
			}
		}
		if !containsIn(seen, "/srv/app/index.ts") {
			t.Fatalf("node_modules 外的条目应保留：%v", seen)
		}
	})

	t.Run("onEntry 返回 false 提前结束整个遍历", func(t *testing.T) {
		deps := &walkFakeDeps{root: seedWalkTree()}
		var seen []string
		outcome, err := walkFileTree(deps, "/var/log", walkOptions{
			virtualDirs: virtualPrune,
			onLimit:     limitThrow,
			onEntry: func(entry walkEntry) bool {
				seen = append(seen, entry.path)
				return len(seen) < 2
			},
		})
		if err != nil {
			t.Fatalf("遍历失败：%v", err)
		}
		if len(seen) != 2 {
			t.Fatalf("seen = %v，期望 2 条", seen)
		}
		if outcome.truncated {
			t.Fatalf("提前结束不是触顶截断：%+v", outcome)
		}
	})

	t.Run("列举瞬间消失的条目（lstat ENOENT）被跳过，不炸整次遍历", func(t *testing.T) {
		deps := &walkFakeDeps{root: seedWalkTree(), lstatFail: map[string]bool{"/var/log/auth.log": true}}
		var seen []string
		if _, err := walkFileTree(deps, "/var/log", walkOptions{
			virtualDirs: virtualPrune,
			onLimit:     limitThrow,
			onEntry: func(entry walkEntry) bool {
				seen = append(seen, entry.path)
				return true
			},
		}); err != nil {
			t.Fatalf("遍历失败：%v", err)
		}
		if containsIn(seen, "/var/log/auth.log") {
			t.Fatalf("消失条目不应出现：%v", seen)
		}
		if !containsIn(seen, "/var/log/syslog") {
			t.Fatalf("其余条目照常遍历：%v", seen)
		}
	})
}

func TestSumDescendantSizes(t *testing.T) {
	t.Run("文件累加 lstat.size，符号链接按链接字节计（不跟随），目录不累计", func(t *testing.T) {
		deps := &walkFakeDeps{root: seedWalkTree()}
		total, err := sumDescendantSizes(deps, "/var/log")
		if err != nil {
			t.Fatalf("求和失败：%v", err)
		}
		want := int64(100 + 40 + 10 + len("/var/log/syslog"))
		if total != want {
			t.Fatalf("total = %d，期望 %d", total, want)
		}
	})

	t.Run("虚拟 FS 前缀整树剪枝后不计入；node_modules 有意不剪（求和要真实规模）", func(t *testing.T) {
		deps := &walkFakeDeps{root: seedWalkTree()}
		total, err := sumDescendantSizes(deps, "/")
		if err != nil {
			t.Fatalf("求和失败：%v", err)
		}
		want := int64(100 + 40 + 10 + len("/var/log/syslog") + 5 + 20 + 30)
		if total != want {
			t.Fatalf("total = %d，期望 %d", total, want)
		}
	})

	t.Run("规模触顶抛 walkLimitError（服务层据此报中文）", func(t *testing.T) {
		deps := &walkFakeDeps{root: seedWalkTree()}
		total, err := sumDescendantSizes(deps, "/var/log/archive")
		if err != nil || total != 10 {
			t.Fatalf("小目录求和 = (%d, %v)", total, err)
		}
		children := make([]walkNamedNode, 0, walkMaxNodes+1)
		for i := 0; i <= walkMaxNodes; i++ {
			children = append(children, wd(fakeIndexName(i), walkFile(1)))
		}
		bigDeps := &walkFakeDeps{root: walkDir(wd("big", walkDir(children...)))}
		_, err = sumDescendantSizes(bigDeps, "/big")
		var limitErr *walkLimitError
		if !errors.As(err, &limitErr) {
			t.Fatalf("期望 walkLimitError，得到 %v", err)
		}
	})
}

func TestCollectDescendantPaths(t *testing.T) {
	t.Run("收集全部非符号链接后代，符号链接后代跳过", func(t *testing.T) {
		deps := &walkFakeDeps{root: seedWalkTree()}
		paths, err := collectDescendantPaths(deps, "/var/log")
		if err != nil {
			t.Fatalf("收集失败：%v", err)
		}
		want := []string{"/var/log/syslog", "/var/log/auth.log", "/var/log/archive", "/var/log/archive/old.log"}
		if !equalStringSlices(paths, want) {
			t.Fatalf("paths = %v，期望 %v", paths, want)
		}
	})
}
