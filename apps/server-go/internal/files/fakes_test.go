package files

/*
 * 服务编排测试的有状态 fake（filesService.test.ts 的内存文件树 + 命令账本同构）：
 * 不执行任何真实命令、不碰真实文件系统。fake 严格对齐真实命令语义——cp -a 不解除
 * 引用（拷贝链接本身）、mv -T 拒绝目标已存在、tar 以 O_CREAT|O_TRUNC 打开归档路径
 *（符号链接写穿）、chmodNoFollow/chownNoFollow 对符号链接抛 ELOOP——编排一旦用错
 * 命令形状，测试立刻红。全部原语经函数字段暴露，测试可包一层注入时序钩子
 *（readdir 后 / lstat 后 / realpath 后三种抢注时机）。
 */

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strings"
	"syscall"
	"time"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// fakeMtime 链接与普通条目的基准时间戳。
var fakeMtime = time.Date(2026, 9, 16, 7, 35, 0, 0, time.UTC)

// fakeTargetMtime 链接指向对象的时间戳：与 fakeMtime 不同，用于区分「按其指向呈现」
// 与「按链接自身呈现」。
var fakeTargetMtime = time.Date(2026, 9, 10, 3, 4, 5, 0, time.UTC)

// fakeNode 内存树节点：kind 三值（file/dir/link）。
type fakeNode struct {
	kind     fakeNodeKind
	size     int64
	mode     fs.FileMode // 权限位（类型位在 stats() 组装时按 kind 补）
	uid      int
	gid      int
	mtime    time.Time
	target   string          // link：目标文本（可为相对）
	children []fakeNamedNode // dir：保插入序
}

type fakeNodeKind int

const (
	fakeFileKind fakeNodeKind = iota
	fakeDirKind
	fakeLinkKind
)

type fakeNamedNode struct {
	name string
	node *fakeNode
}

// fakeNodeOverrides 文件/目录节点的可选覆盖项。
type fakeNodeOverrides struct {
	mode  fs.FileMode
	uid   int
	mtime time.Time
}

func fakeFileNode(size int64, overrides ...fakeNodeOverrides) *fakeNode {
	node := &fakeNode{kind: fakeFileKind, size: size, mode: 0o644, uid: 0, gid: 0, mtime: fakeMtime}
	for _, o := range overrides {
		applyOverride(node, o)
	}
	return node
}

func fakeDirNode(children ...fakeNamedNode) *fakeNode {
	node := &fakeNode{kind: fakeDirKind, size: 0, mode: 0o755, uid: 0, gid: 0, mtime: fakeMtime, children: children}
	return node
}

func fakeDirNodeWith(overrides fakeNodeOverrides, children ...fakeNamedNode) *fakeNode {
	node := fakeDirNode(children...)
	applyOverride(node, overrides)
	return node
}

func fakeLinkNode(target string) *fakeNode {
	return &fakeNode{kind: fakeLinkKind, size: int64(len(target)), mode: 0o777, uid: 0, gid: 0, mtime: fakeMtime, target: target}
}

func applyOverride(node *fakeNode, o fakeNodeOverrides) {
	if o.mode != 0 {
		node.mode = o.mode
	}
	if o.uid != 0 {
		node.uid = o.uid
	}
	if !o.mtime.IsZero() {
		node.mtime = o.mtime
	}
}

func (n *fakeNode) child(name string) *fakeNode {
	for _, child := range n.children {
		if child.name == name {
			return child.node
		}
	}
	return nil
}

func (n *fakeNode) setChild(name string, node *fakeNode) {
	n.children = append(n.children, fakeNamedNode{name: name, node: node})
}

func (n *fakeNode) removeChild(name string) {
	for index, child := range n.children {
		if child.name == name {
			n.children = append(n.children[:index], n.children[index+1:]...)
			return
		}
	}
}

// stats 组装 lstat/stat 形状：类型位按 kind 补（权限位保持原值）。
func (n *fakeNode) stats() entryStats {
	mode := n.mode
	switch n.kind {
	case fakeDirKind:
		mode = fs.ModeDir | n.mode
	case fakeLinkKind:
		mode = fs.ModeSymlink | n.mode
	}
	return entryStats{mode: mode, size: n.size, modTime: n.mtime, uid: n.uid, gid: n.gid}
}

// 命令与原语账本。
type fakeCommand struct {
	command string
	args    []string
}

type fakeChmodCall struct {
	path string
	mode fs.FileMode
}

type fakeChownCall struct {
	path string
	uid  int
	gid  int
}

type fakeRenameCall struct {
	from string
	to   string
}

// hookableHost 原语函数字段容器：测试可整体替换单个原语注入时序钩子。
type hookableHost struct {
	readdir       func(path string) ([]dirEntry, error)
	lstat         func(path string) (entryStats, error)
	stat          func(path string) (entryStats, error)
	realpath      func(path string) (string, error)
	renamePath    func(from, to string) error
	mkdir         func(path string, mode fs.FileMode) error
	rmPath        func(path string) error
	runCp         func(args []string) error
	runMv         func(args []string) error
	runTar        func(args []string) error
	chmodNoFollow func(path string, mode fs.FileMode) error
	chownNoFollow func(path string, uid, gid int) error
	homeDir       func() string
}

func (h *hookableHost) Readdir(path string) ([]dirEntry, error) { return h.readdir(path) }
func (h *hookableHost) Lstat(path string) (entryStats, error)   { return h.lstat(path) }
func (h *hookableHost) Stat(path string) (entryStats, error)    { return h.stat(path) }
func (h *hookableHost) Realpath(path string) (string, error)    { return h.realpath(path) }
func (h *hookableHost) RenamePath(from, to string) error        { return h.renamePath(from, to) }
func (h *hookableHost) Mkdir(path string, mode fs.FileMode) error {
	return h.mkdir(path, mode)
}
func (h *hookableHost) RmPath(path string) error   { return h.rmPath(path) }
func (h *hookableHost) RunCp(args []string) error  { return h.runCp(args) }
func (h *hookableHost) RunMv(args []string) error  { return h.runMv(args) }
func (h *hookableHost) RunTar(args []string) error { return h.runTar(args) }
func (h *hookableHost) ChmodNoFollow(path string, mode fs.FileMode) error {
	return h.chmodNoFollow(path, mode)
}
func (h *hookableHost) ChownNoFollow(path string, uid, gid int) error {
	return h.chownNoFollow(path, uid, gid)
}
func (h *hookableHost) HomeDir() string { return h.homeDir() }

// fakeFilesHost 完整内存宿主：树 + 账本 + 可替换原语。
type fakeFilesHost struct {
	*hookableHost
	root       *fakeNode
	commands   []fakeCommand
	chmodCalls []fakeChmodCall
	chownCalls []fakeChownCall
	renames    []fakeRenameCall
}

// segmentsOf 切路径段（与 fake 的路径解析同口径）。
func segmentsOf(path string) []string {
	return strings.FieldsFunc(path, func(r rune) bool { return r == '/' })
}

func parentPathOf(path string) string {
	segments := segmentsOf(path)
	if len(segments) == 0 {
		return "/"
	}
	segments = segments[:len(segments)-1]
	if len(segments) == 0 {
		return "/"
	}
	return "/" + strings.Join(segments, "/")
}

func leafOfPath(path string) string {
	segments := segmentsOf(path)
	if len(segments) == 0 {
		return ""
	}
	return segments[len(segments)-1]
}

// joinFakePaths 相对链接目标的拼接归一化：以 parentPath 为基准消化 `.` 与 `..`
// （对齐内核语义）。
func joinFakePaths(parentPath, target string) string {
	var out []string
	for _, part := range append(segmentsOf(parentPath), segmentsOf(target)...) {
		if part == "" || part == "." {
			continue
		}
		if part == ".." {
			if len(out) > 0 {
				out = out[:len(out)-1]
			}
			continue
		}
		out = append(out, part)
	}
	if len(out) == 0 {
		return "/"
	}
	return "/" + strings.Join(out, "/")
}

// resolve 路径解析：中间组件的符号链接一律跟随，最终组件按 followFinal（lstat 语义
// 则不跟随）。查无返回 nil；链接层数过深回 ELOOP。
func (h *fakeFilesHost) resolve(path string, followFinal bool) (*fakeNode, error) {
	return h.resolveWithHops(path, followFinal, 0)
}

func (h *fakeFilesHost) resolveWithHops(path string, followFinal bool, hops int) (*fakeNode, error) {
	segments := segmentsOf(path)
	current := h.root
	resolved := []string{}
	for index := 0; index < len(segments); index++ {
		isFinal := index == len(segments)-1
		if current.kind != fakeDirKind {
			return nil, nil
		}
		next := current.child(segments[index])
		if next == nil {
			return nil, nil
		}
		if next.kind == fakeLinkKind && (!isFinal || followFinal) {
			if hops >= 10 {
				return nil, syscall.ELOOP
			}
			parentPath := "/"
			if len(resolved) > 0 {
				parentPath = "/" + strings.Join(resolved, "/")
			}
			targetPath := next.target
			if !strings.HasPrefix(targetPath, "/") {
				targetPath = joinFakePaths(parentPath, targetPath)
			}
			rest := strings.Join(segments[index+1:], "/")
			merged := targetPath
			if rest != "" {
				merged = targetPath + "/" + rest
			}
			if merged == "" {
				merged = "/"
			}
			return h.resolveWithHops(merged, followFinal, hops+1)
		}
		resolved = append(resolved, segments[index])
		current = next
	}
	return current, nil
}

// realpathOf 解析全部符号链接后的规范路径：断链与缺失回 ENOENT（对齐 node 语义）。
func (h *fakeFilesHost) realpathOf(path string, hops int) (string, error) {
	if hops > 10 {
		return "", syscall.ELOOP
	}
	segments := segmentsOf(path)
	current := h.root
	for index := 0; index < len(segments); index++ {
		if current.kind != fakeDirKind {
			return "", syscall.ENOENT
		}
		next := current.child(segments[index])
		if next == nil {
			return "", syscall.ENOENT
		}
		if next.kind == fakeLinkKind {
			resolvedDir := segments[:index]
			targetPath := next.target
			if !strings.HasPrefix(targetPath, "/") {
				base := "/"
				if len(resolvedDir) > 0 {
					base = "/" + strings.Join(resolvedDir, "/")
				}
				targetPath = joinFakePaths(base, targetPath)
			}
			targetCanonical, err := h.realpathOf(targetPath, hops+1)
			if err != nil {
				return "", err
			}
			mergedSegments := append(segmentsOf(targetCanonical), segments[index+1:]...)
			merged := strings.Join(mergedSegments, "/")
			if merged == "" {
				return "/", nil
			}
			return h.realpathOf("/"+merged, hops+1)
		}
		current = next
	}
	if len(segments) == 0 {
		return "/", nil
	}
	return "/" + strings.Join(segments, "/"), nil
}

func cloneFakeNode(node *fakeNode) *fakeNode {
	if node.kind != fakeDirKind {
		copyNode := *node
		return &copyNode
	}
	children := make([]fakeNamedNode, 0, len(node.children))
	for _, child := range node.children {
		children = append(children, fakeNamedNode{name: child.name, node: cloneFakeNode(child.node)})
	}
	copyNode := *node
	copyNode.children = children
	return &copyNode
}

func sumFakeTree(node *fakeNode) int64 {
	if node.kind != fakeDirKind {
		return node.size
	}
	var total int64
	for _, child := range node.children {
		total += sumFakeTree(child.node)
	}
	return total
}

// createFakeFilesHost 装配内存宿主：原语函数全部闭包到树与账本上。
func createFakeFilesHost(root *fakeNode) *fakeFilesHost {
	host := &fakeFilesHost{root: root}
	hooks := &hookableHost{
		readdir: func(path string) ([]dirEntry, error) {
			node, err := host.resolve(path, true)
			if err != nil {
				return nil, err
			}
			if node == nil {
				return nil, syscall.ENOENT
			}
			if node.kind != fakeDirKind {
				return nil, syscall.ENOTDIR
			}
			out := make([]dirEntry, 0, len(node.children))
			for _, child := range node.children {
				out = append(out, dirEntry{name: child.name})
			}
			return out, nil
		},
		lstat: func(path string) (entryStats, error) {
			node, err := host.resolve(path, false)
			if err != nil {
				return entryStats{}, err
			}
			if node == nil {
				return entryStats{}, syscall.ENOENT
			}
			return node.stats(), nil
		},
		stat: func(path string) (entryStats, error) {
			node, err := host.resolve(path, true)
			if err != nil {
				return entryStats{}, err
			}
			if node == nil {
				return entryStats{}, syscall.ENOENT
			}
			return node.stats(), nil
		},
		realpath: func(path string) (string, error) {
			return host.realpathOf(path, 0)
		},
		renamePath: func(from, to string) error {
			host.renames = append(host.renames, fakeRenameCall{from: from, to: to})
			node, err := host.resolve(from, false)
			if err != nil {
				return err
			}
			fromParent, err := host.resolve(parentPathOf(from), true)
			if err != nil {
				return err
			}
			toParent, err := host.resolve(parentPathOf(to), true)
			if err != nil {
				return err
			}
			if node == nil || fromParent == nil || toParent == nil || fromParent.kind != fakeDirKind || toParent.kind != fakeDirKind {
				return syscall.ENOENT
			}
			toLeaf := leafOfPath(to)
			existing := toParent.child(toLeaf)
			// rename(2)：newpath 是符号链接时替换链接本身（不跟随）；
			// 目录不能被非目录覆盖（ENOTDIR），非空目录不能被覆盖（ENOTEMPTY）。
			if node.kind == fakeDirKind && existing != nil && existing.kind != fakeDirKind {
				return syscall.ENOTDIR
			}
			if node.kind != fakeDirKind && existing != nil && existing.kind == fakeDirKind {
				return syscall.EISDIR
			}
			if existing != nil && existing.kind == fakeDirKind && len(existing.children) > 0 {
				return syscall.ENOTEMPTY
			}
			fromParent.removeChild(leafOfPath(from))
			toParent.removeChild(toLeaf)
			toParent.setChild(toLeaf, node)
			return nil
		},
		mkdir: func(path string, mode fs.FileMode) error {
			parent, err := host.resolve(parentPathOf(path), true)
			if err != nil {
				return err
			}
			if parent == nil || parent.kind != fakeDirKind {
				return syscall.ENOENT
			}
			if parent.child(leafOfPath(path)) != nil {
				return syscall.EEXIST
			}
			parent.setChild(leafOfPath(path), fakeDirNodeWith(fakeNodeOverrides{mode: mode}))
			return nil
		},
		rmPath: func(path string) error {
			parent, err := host.resolve(parentPathOf(path), true)
			if err != nil {
				return err
			}
			if parent == nil || parent.kind != fakeDirKind {
				return nil // force 语义：缺失不报错
			}
			// node 的 rm 与 rm(1) 同款：符号链接只摘链接本身，目录递归删除。
			parent.removeChild(leafOfPath(path))
			return nil
		},
		runCp: func(args []string) error {
			host.commands = append(host.commands, fakeCommand{command: "cp", args: args})
			if len(args) != 3 || args[0] != "-a" {
				return fmt.Errorf("cp: 不支持的参数形状 %s", strings.Join(args, " "))
			}
			src, dest := args[1], args[2]
			node, err := host.resolve(src, false)
			if err != nil {
				return err
			}
			destParent, err := host.resolve(parentPathOf(dest), true)
			if err != nil {
				return err
			}
			if node == nil || destParent == nil || destParent.kind != fakeDirKind {
				return syscall.ENOENT
			}
			leaf := leafOfPath(dest)
			existing := destParent.child(leaf)
			size := node.size
			if node.kind == fakeDirKind {
				size = sumFakeTree(node)
			}
			// 目标侧语义对齐 GNU cp（coreutils 9.4 实测）：目标名是符号链接时跟随——
			// 指向已存在的普通文件即写穿（链接保留、被指向文件的内容被改写），
			// 指向目录则拷进该目录，断链直接拒绝（not writing through dangling symlink）。
			if existing != nil && existing.kind == fakeLinkKind {
				target, terr := host.resolve(existing.target, true)
				if terr != nil {
					return terr
				}
				if target != nil && target.kind == fakeFileKind {
					target.size = size
					target.mode = node.mode
					return nil
				}
				if target != nil && target.kind == fakeDirKind {
					if target.child(leafOfPath(src)) != nil {
						return fmt.Errorf("cp: 目标已存在 %s/%s", dest, leafOfPath(src))
					}
					target.setChild(leafOfPath(src), cloneFakeNode(node))
					return nil
				}
				return fmt.Errorf("cp: not writing through dangling symlink %s", dest)
			}
			if existing != nil && existing.kind == fakeDirKind {
				if existing.child(leafOfPath(src)) != nil {
					return fmt.Errorf("cp: 目标已存在 %s/%s", dest, leafOfPath(src))
				}
				existing.setChild(leafOfPath(src), cloneFakeNode(node))
				return nil
			}
			destParent.setChild(leaf, cloneFakeNode(node))
			return nil
		},
		runMv: func(args []string) error {
			host.commands = append(host.commands, fakeCommand{command: "mv", args: args})
			if len(args) != 3 || args[0] != "-T" {
				return fmt.Errorf("mv: 不支持的参数形状 %s", strings.Join(args, " "))
			}
			src, dest := args[1], args[2]
			node, err := host.resolve(src, false)
			if err != nil {
				return err
			}
			srcParent, err := host.resolve(parentPathOf(src), true)
			if err != nil {
				return err
			}
			destParent, err := host.resolve(parentPathOf(dest), true)
			if err != nil {
				return err
			}
			if node == nil || srcParent == nil || destParent == nil || srcParent.kind != fakeDirKind || destParent.kind != fakeDirKind {
				return syscall.ENOENT
			}
			if destParent.child(leafOfPath(dest)) != nil {
				return fmt.Errorf("mv: 目标已存在 %s", dest)
			}
			srcParent.removeChild(leafOfPath(src))
			destParent.setChild(leafOfPath(dest), node)
			return nil
		},
		runTar: func(args []string) error {
			host.commands = append(host.commands, fakeCommand{command: "tar", args: args})
			if len(args) != 6 || args[0] != "-czf" || args[2] != "-C" || args[4] != "--" {
				return fmt.Errorf("tar: 不支持的参数形状 %s", strings.Join(args, " "))
			}
			archive, baseDir, name := args[1], args[3], args[5]
			sourcePath := name
			if baseDir != "/" {
				sourcePath = baseDir + "/" + name
			}
			source, err := host.resolve(sourcePath, false)
			if err != nil {
				return err
			}
			archiveParent, err := host.resolve(parentPathOf(archive), true)
			if err != nil {
				return err
			}
			if source == nil || archiveParent == nil || archiveParent.kind != fakeDirKind {
				return syscall.ENOENT
			}
			leaf := leafOfPath(archive)
			existing := archiveParent.child(leaf)
			size := source.size
			if source.kind == fakeDirKind {
				size = sumFakeTree(source)
			}
			// 目标侧语义对齐 GNU tar（1.35 实测）：以 O_CREAT|O_TRUNC 打开归档路径，
			// 该名是符号链接时写穿到链接目标（断链则在链接指向处创建文件），链接本身保留。
			if existing != nil && existing.kind == fakeLinkKind {
				target, terr := host.resolve(existing.target, true)
				if terr != nil {
					return terr
				}
				if target != nil && target.kind == fakeFileKind {
					target.size = size
					target.mode = 0o644
					return nil
				}
				if target != nil {
					return fmt.Errorf("tar: 不能写入目录 %s", archive)
				}
				targetParent, terr := host.resolve(parentPathOf(existing.target), true)
				if terr != nil {
					return terr
				}
				if targetParent == nil || targetParent.kind != fakeDirKind {
					return syscall.ENOENT
				}
				targetParent.setChild(leafOfPath(existing.target), fakeFileNode(size, fakeNodeOverrides{mode: 0o644}))
				return nil
			}
			if existing != nil && existing.kind == fakeDirKind {
				return fmt.Errorf("tar: 不能写入目录 %s", archive)
			}
			archiveParent.setChild(leaf, fakeFileNode(size, fakeNodeOverrides{mode: 0o644}))
			return nil
		},
		chmodNoFollow: func(path string, mode fs.FileMode) error {
			host.chmodCalls = append(host.chmodCalls, fakeChmodCall{path: path, mode: mode})
			node, err := host.resolve(path, false)
			if err != nil {
				return err
			}
			if node == nil {
				return syscall.ENOENT
			}
			if node.kind == fakeLinkKind {
				return syscall.ELOOP
			}
			node.mode = mode
			return nil
		},
		chownNoFollow: func(path string, uid, gid int) error {
			host.chownCalls = append(host.chownCalls, fakeChownCall{path: path, uid: uid, gid: gid})
			node, err := host.resolve(path, false)
			if err != nil {
				return err
			}
			if node == nil {
				return syscall.ENOENT
			}
			if node.kind == fakeLinkKind {
				return syscall.ELOOP
			}
			node.uid = uid
			node.gid = gid
			return nil
		},
		homeDir: func() string { return "/root" },
	}
	host.hookableHost = hooks
	return host
}

// nodeAt 按路径取节点（默认跟随最终组件符号链接）。
func (h *fakeFilesHost) nodeAt(path string, followFinal ...bool) *fakeNode {
	follow := true
	if len(followFinal) > 0 {
		follow = followFinal[0]
	}
	node, err := h.resolve(path, follow)
	if err != nil {
		return nil
	}
	return node
}

// writeCommands 写命令账本（服务侧 getent 走 accounts fake 不进账本）：
// 断言「零命令」时用它。
func (h *fakeFilesHost) writeCommands() []fakeCommand {
	return h.commands
}

// childNamesOf fake 目录的直接子项名（断言暂存目录已清理用）。
func (h *fakeFilesHost) childNamesOf(path string) []string {
	node := h.nodeAt(path, true)
	if node == nil {
		return nil
	}
	names := make([]string, 0, len(node.children))
	for _, child := range node.children {
		names = append(names, child.name)
	}
	return names
}

// seedContainerTree 容器形态的种子树：覆盖 mock 的演示场景 + 写禁区两侧 + 符号链接 +
// 搜索剪枝对象。
func seedContainerTree() *fakeNode {
	return fakeDirNode(
		d("etc", fakeDirNode(
			d("nginx", fakeDirNode(
				d("nginx.conf", fakeFileNode(1478)),
				d("conf.d", fakeDirNode(d("elysian.conf", fakeFileNode(1834)))),
			)),
			d("ssh", fakeDirNode(d("sshd_config", fakeFileNode(3402, fakeNodeOverrides{mode: 0o600})))),
		)),
		d("var", fakeDirNode(
			d("log", fakeDirNode(
				d("syslog", fakeFileNode(219530, fakeNodeOverrides{mode: 0o640})),
				d("auth.log", fakeFileNode(200)),
				d("foreign", fakeFileNode(50, fakeNodeOverrides{uid: 12345})),
				d("nginx", fakeDirNode(d("access.log", fakeFileNode(8241)))),
				d("current", fakeLinkNode("/var/log/nothere")),
			)),
			d("www", fakeDirNode(d("index.html", fakeFileNode(512)), d("style.css", fakeFileNode(128)))),
			d("lib", fakeDirNode(d("elysian", fakeDirNode(d("data", fakeDirNode(d("metrics.sqlite", fakeFileNode(4096)))))))),
		)),
		d("tmp", fakeDirNode()),
		d("root", fakeDirNode(
			d(".ssh", fakeDirNode(d("authorized_keys", fakeFileNode(394, fakeNodeOverrides{mode: 0o600})))),
			d(".Elysian", fakeDirNode(d("data", fakeDirNode(d("metrics.sqlite", fakeFileNode(2048)))))),
			d(".bun", fakeDirNode(d("cache.bin", fakeFileNode(30)))),
			d("keys-link", fakeLinkNode("/root/.ssh")),
		)),
		d("app", fakeDirNode(d("src", fakeDirNode(d("index.ts", fakeFileNode(5)))))),
		d("srv", fakeDirNode(
			d("app", fakeDirNode(
				d("index.ts", fakeFileNode(7)),
				d("node_modules", fakeDirNode(d("pkg", fakeDirNode(d("index.js", fakeFileNode(20)))))),
			)),
			d("deploy.sh", fakeFileNode(11)),
		)),
		d("proc", fakeDirNode(d("cpuinfo", fakeFileNode(0)))),
		d("work", fakeDirNode(
			d("report.txt", fakeFileNode(15, fakeNodeOverrides{mode: 0o600, uid: 33, mtime: fakeTargetMtime})),
			// 活链接：按指向呈现（mode 600 / www-data / 15 字节 / 目标时间戳），
			// 不是链接自身的 777 / root / 路径字节数。
			d("report-link", fakeLinkNode("/work/report.txt")),
			// 断链：回退 lstat 按链接自身呈现（与 list 的降级同款）。
			d("dangling-link", fakeLinkNode("/work/nothere")),
			// 指向自身父目录的活链接：遍历若跟随就会成环，lstat 口径必须不展开它。
			d("loop", fakeLinkNode("/work")),
			// 相对目标的链接：在 /work 下解析为 /work/rel.txt；换个目录复制过去就会
			// 断链（真实 cp 保留相对目标）。
			d("rel.txt", fakeFileNode(7, fakeNodeOverrides{mode: 0o644})),
			d("rel-link.txt", fakeLinkNode("rel.txt")),
		)),
		d("home", fakeDirNode(
			d("deploy", fakeDirNode(
				d(".ssh", fakeDirNode(d("authorized_keys", fakeFileNode(394, fakeNodeOverrides{uid: 1000})))),
				d("deploy.sh", fakeFileNode(4820, fakeNodeOverrides{mode: 0o755, uid: 1000})),
			)),
		)),
	)
}

// d 命名子项的构造助手（保插入序）。
func d(name string, node *fakeNode) fakeNamedNode {
	return fakeNamedNode{name: name, node: node}
}

// createHostWithoutRootSsh 造一个 /root/.ssh 空缺的宿主：父目录 /root 放行、派生出的
// 名字恰好补齐禁区路径的场景，只在这条禁区路径空缺时可构造（它已存在时
// deriveUniqueName 会换成副本名）。
func createHostWithoutRootSsh() *fakeFilesHost {
	root := seedContainerTree()
	root.child("root").removeChild(".ssh")
	return createFakeFilesHost(root)
}

// createHugeHost 超预算目录：walkMaxNodes+1 个文件，任何受限遍历都触顶。
func createHugeHost() *fakeFilesHost {
	children := make([]fakeNamedNode, 0, walkMaxNodes+1)
	for index := 0; index <= walkMaxNodes; index++ {
		children = append(children, d(fmt.Sprintf("f%d", index), fakeFileNode(1)))
	}
	return createFakeFilesHost(fakeDirNode(d("big", fakeDirNode(children...)), d("tmp", fakeDirNode())))
}

// plantSymlink 在 fake 树里把某个名字抢注成符号链接（模拟容器内敌对进程），
// target 为绝对路径。前提：父目录已存在。
func plantSymlink(host *fakeFilesHost, path, target string) {
	parent := host.nodeAt(parentPathOf(path), true)
	if parent == nil || parent.kind != fakeDirKind {
		panic("plantSymlink: 父目录不存在（" + path + "）")
	}
	parent.removeChild(leafOfPath(path))
	parent.setChild(leafOfPath(path), fakeLinkNode(target))
}

// plantSymlinkAfterFirstReaddir 抢注时机一：占用检查（第一次 readdir）返回之后立刻
// 抢注——目标名在「检查未占用」与「命令执行」之间的窗口里被换成符号链接。
// 返回「抢注是否真的发生」的探针，用例据此断言窗口确被触发（避免空转绿灯）。
func plantSymlinkAfterFirstReaddir(host *fakeFilesHost, path, target string) func() bool {
	original := host.readdir
	planted := false
	host.readdir = func(dirPath string) ([]dirEntry, error) {
		entries, err := original(dirPath)
		if !planted {
			planted = true
			plantSymlink(host, path, target)
		}
		return entries, err
	}
	return func() bool { return planted }
}

// plantSymlinkAfterLstat 抢注时机二：发布前的 lstat 复核之后才抢注（最坏窗口）——
// 安全性不得依赖复核本身，复核与 rename(2) 之间的抢注仍不许写穿。同样返回抢注探针。
func plantSymlinkAfterLstat(host *fakeFilesHost, path, target string) func() bool {
	original := host.lstat
	planted := false
	host.lstat = func(candidate string) (entryStats, error) {
		stats, err := original(candidate)
		if !planted && candidate == path {
			planted = true
			plantSymlink(host, path, target)
		}
		return stats, err
	}
	return func() bool { return planted }
}

// swapDirAfterFirstRealpath 抢注时机三：目标目录锚点捕获（复核里第一次成功 realpath
// 它）之后立刻把它整体换成指向 target 的符号链接——模拟「复核通过后、命令执行前」
// 目录被敌对进程换链。返回「换链是否真的发生」的探针（探针没有触发点、planted 为
// false 即红，避免空转绿灯）。
func swapDirAfterFirstRealpath(host *fakeFilesHost, dirPath, target string) func() bool {
	original := host.realpath
	planted := false
	host.realpath = func(path string) (string, error) {
		resolved, err := original(path)
		if err == nil && !planted && path == dirPath {
			planted = true
			plantSymlink(host, dirPath, target)
		}
		return resolved, err
	}
	return func() bool { return planted }
}

// fakeSystemAccounts getent 账号通道的内存 fake：记录按名字升序（对齐 TS fake 的
// getent 输出排序），PasswdByName 模拟「按名过滤取首条」。
type fakeSystemAccounts struct {
	records []seam.PasswdRecord
}

func newFakeSystemAccounts() *fakeSystemAccounts {
	return &fakeSystemAccounts{records: []seam.PasswdRecord{
		{Name: "deploy", UID: 1000, GID: 1000, Gecos: "", Home: "/home/deploy", Shell: "/bin/bash"},
		{Name: "root", UID: 0, GID: 0, Gecos: "", Home: "/root", Shell: "/bin/bash"},
		{Name: "www-data", UID: 33, GID: 33, Gecos: "", Home: "/home/www-data", Shell: "/bin/bash"},
	}}
}

func (a *fakeSystemAccounts) PasswdAll(ctx context.Context) ([]seam.PasswdRecord, error) {
	return a.records, nil
}

func (a *fakeSystemAccounts) PasswdByName(ctx context.Context, name string) (*seam.PasswdRecord, error) {
	for _, record := range a.records {
		if record.Name == name {
			found := record
			return &found, nil
		}
	}
	return nil, nil // 查无结果（对齐退出码 2 归一为空输出）
}

// newTestService 用内存宿主构造真实服务编排。
func newTestService(host *fakeFilesHost) *filesService {
	return newService(host, newFakeSystemAccounts())
}

// sortedStrings 排序副本（对齐 TS 测试里的 .sort()）。
func sortedStrings(items []string) []string {
	sorted := append([]string(nil), items...)
	sort.Strings(sorted)
	return sorted
}

// errMessage 取错误文案（nil 回空串，测试断言用）。
func errMessage(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// errIsInvalidRequest 判定错误是否 400 语义（shared.InvalidRequestError）。
func errIsInvalidRequest(err error) bool {
	var invalid *shared.InvalidRequestError
	return errors.As(err, &invalid)
}
