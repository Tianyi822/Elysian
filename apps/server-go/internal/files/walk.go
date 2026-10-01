package files

import (
	"errors"
	"io/fs"
	"syscall"
)

/*
 * 受限遍历原语（fileTreeWalk.ts 等价物）：文件管理的大小求和、搜索、复制/压缩预检
 * 与递归 chmod 收集共用。全程 lstat、绝不跟随符号链接——链接既不展开目录（防循环）
 * 也不读目标内容（防 /proc、/sys 陷阱）；深度与节点双上限防失控遍历。虚拟 FS 前缀
 * 目录按调用方要求剪枝（跳过）或报告（抛错，由服务层转成中文业务错误）。
 */

// walkMaxNodes 遍历节点上限：size/预检/收集触顶报错，search 触顶静默截断。
const walkMaxNodes = 50000

// walkMaxDepth 遍历深度上限：目录层次深于此即触顶（正常文件树远浅于此）。
const walkMaxDepth = 64

// 遍历对虚拟 FS 前缀目录与规模触顶的处理模式。
const (
	virtualPrune  byte = iota // 命中即整树跳过（size/search/chmod 收集）
	virtualReject             // 命中即抛 walkVirtualDirError（copy/compress 预检）
)

const (
	limitThrow byte = iota // 触顶抛 walkLimitError
	limitStop              // 触顶停止遍历并标记 truncated（search 的静默截断）
)

// walkLimitError 规模触顶的标记错误：服务层捕获后按操作语境转成中文业务错误。
type walkLimitError struct {
	kind string // "nodes" | "depth"
}

func (e *walkLimitError) Error() string {
	return "遍历规模超出上限（" + e.kind + "）"
}

// walkVirtualDirError 遇到虚拟 FS 前缀目录的报告错误（仅 reject 模式抛出；prune 模式
// 静默跳过）。
type walkVirtualDirError struct {
	hitPath string
}

func (e *walkVirtualDirError) Error() string {
	return "目录位于系统虚拟目录下：" + e.hitPath
}

// walkEntry 遍历回调的条目形状：绝对路径由遍历逐层拼装，中间不含符号链接组件（lstat 不展开）。
type walkEntry struct {
	path  string
	name  string
	stats entryStats
}

// treeWalkDeps 遍历依赖的最小形状（TS TreeWalkDeps）：与 hostDeps 的 readdir/lstat
// 子集同构，测试注入内存 fake。
type treeWalkDeps interface {
	Readdir(path string) ([]dirEntry, error)
	Lstat(path string) (entryStats, error)
}

// walkOptions 遍历行为的全部开关（maxNodes/maxDepth 为 0 时取缺省上限，测试可缩小预算）。
type walkOptions struct {
	virtualDirs byte
	onLimit     byte
	// extraPrune 额外剪枝（仅目录生效）：search 专属的 node_modules 段与工具缓存前缀。
	extraPrune func(entryPath, entryName string) bool
	// onEntry 每个条目的回调（lstat 结果 + 绝对路径）；返回 false 提前结束整个遍历
	//（search 的结果条数上限）。可为 nil。
	onEntry  func(entry walkEntry) bool
	maxNodes int
	maxDepth int
}

// walkOutcome 遍历结果：实际访问过的条目数（不含被剪枝的目录本身）与是否因规模触顶
// 提前停止（onLimit 为 limitStop 时可能为真）。
type walkOutcome struct {
	visited   int
	truncated bool
}

// walkFileTree 从 startPath 起深度受限地遍历全部后代（迭代 DFS，起点本身不作为条目回调；
// 起点的子项深度为 1）。条目在列举瞬间消失（lstat ENOENT/ENOTDIR）则跳过，其余错误原样返回。
// 节点计数在 lstat 之前检查（超限那条不计入 visited）。
func walkFileTree(deps treeWalkDeps, startPath string, options walkOptions) (walkOutcome, error) {
	maxNodes := options.maxNodes
	if maxNodes == 0 {
		maxNodes = walkMaxNodes
	}
	maxDepth := options.maxDepth
	if maxDepth == 0 {
		maxDepth = walkMaxDepth
	}
	visited := 0
	truncated := false

	// hitLimit 规模触顶：throw 模式回错误；stop 模式标记截断（调用方随后结束遍历）。
	hitLimit := func(kind string) error {
		if options.onLimit == limitThrow {
			return &walkLimitError{kind: kind}
		}
		truncated = true
		return nil
	}

	// 栈元素记录「该目录的直接子项所在的深度」：起点的子项深度为 1。
	type stackItem struct {
		dirPath    string
		childDepth int
	}
	stack := []stackItem{{dirPath: startPath, childDepth: 1}}
	for len(stack) > 0 {
		item := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		dirPath, childDepth := item.dirPath, item.childDepth
		dirents, err := deps.Readdir(dirPath)
		if err != nil {
			return walkOutcome{}, err
		}
		for _, dirent := range dirents {
			if visited >= maxNodes {
				if err := hitLimit("nodes"); err != nil {
					return walkOutcome{}, err
				}
				return walkOutcome{visited: visited, truncated: truncated}, nil
			}
			entryPath := childPathOf(dirPath, dirent.name)
			stats, err := deps.Lstat(entryPath)
			if err != nil {
				if isMissingPathError(err) {
					continue
				}
				return walkOutcome{}, err
			}
			visited++
			if stats.isDir() {
				// 虚拟 FS 与额外剪枝都只对目录生效：文件没有可展开的子树。
				if _, hit := matchPathPrefix(entryPath, virtualFsPrefixes); hit {
					if options.virtualDirs == virtualReject {
						return walkOutcome{}, &walkVirtualDirError{hitPath: entryPath}
					}
					continue
				}
				if options.extraPrune != nil && options.extraPrune(entryPath, dirent.name) {
					continue
				}
				// 目录已到深度上限则无法继续下探：宁可如实触顶，不静默漏算。
				if childDepth >= maxDepth {
					if err := hitLimit("depth"); err != nil {
						return walkOutcome{}, err
					}
					return walkOutcome{visited: visited, truncated: truncated}, nil
				}
				stack = append(stack, stackItem{dirPath: entryPath, childDepth: childDepth + 1})
			}
			if options.onEntry != nil {
				if !options.onEntry(walkEntry{path: entryPath, name: dirent.name, stats: stats}) {
					return walkOutcome{visited: visited, truncated: truncated}, nil
				}
			}
		}
	}
	return walkOutcome{visited: visited, truncated: truncated}, nil
}

// sumDescendantSizes 目录全部后代的大小求和：文件与符号链接按 lstat 字节数累计
// （链接不跟随），目录不累计。
func sumDescendantSizes(deps treeWalkDeps, startPath string) (int64, error) {
	var total int64
	_, err := walkFileTree(deps, startPath, walkOptions{
		virtualDirs: virtualPrune,
		onLimit:     limitThrow,
		onEntry: func(entry walkEntry) bool {
			if !entry.stats.isDir() {
				total += entry.stats.size
			}
			return true
		},
	})
	if err != nil {
		return 0, err
	}
	return total, nil
}

// collectDescendantPaths 收集目录的全部后代路径（递归 chmod 的收集段）：符号链接后代
// 跳过，绝不改到链接目标上。
func collectDescendantPaths(deps treeWalkDeps, startPath string) ([]string, error) {
	var paths []string
	_, err := walkFileTree(deps, startPath, walkOptions{
		virtualDirs: virtualPrune,
		onLimit:     limitThrow,
		onEntry: func(entry walkEntry) bool {
			if !entry.stats.isSymlink() {
				paths = append(paths, entry.path)
			}
			return true
		},
	})
	if err != nil {
		return nil, err
	}
	return paths, nil
}

// isMissingPathError 路径不存在（ENOENT）或中间组件不是目录（ENOTDIR）：多数入口折成
// 「目录不存在」。
func isMissingPathError(err error) bool {
	return errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR)
}

// isLinkLoopError 符号链接环（ELOOP）：跟随语义的 stat/realpath 在环上抛它，lstat
// 不跟随、不受影响。
func isLinkLoopError(err error) bool {
	return errors.Is(err, syscall.ELOOP)
}
