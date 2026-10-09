// include.go 是 include 插件的主体（对应 include/src/index.ts）：配置文件
// 读写循环（dirtyRead/dirtyWrite/_drain/_loop）、补丁与账本的应用/调和/路由、
// 匿名条目 id 稳定化与 YAML/JSON 解析写回。机制层（journal/patch）在同包
// journal.go/patch.go。
//
// JS 表达式求值（!js 标签与插值）不移植（差异清单第 4 条）：!js 解析为
// JsExpr 不透明值，写回时原样输出。文件操作经 FileOps 接缝（默认包 os，
// 测试经它注入 rename 失败与只读）。退避等待走注入时钟（方案 2.0）。
package include

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"gopkg.in/yaml.v3"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/kardia/loader"
)

// —— 常量（index.ts:58-59 与文件类型表）——

const (
	// renameRetries 对应 RENAME_RETRIES：瞬态 rename 错误的重试上限。
	renameRetries = 10
	// renameBackoff 对应 RENAME_BACKOFF：退避基值 20ms，按 (n+1) 递增。
	renameBackoff = 20 * time.Millisecond
	jsonType      = "application/json"
	yamlType      = "application/yaml"
)

// fileTypes 对应 index.ts:23-27 的扩展名表。
var fileTypes = map[string]string{
	".json": jsonType,
	".yaml": yamlType,
	".yml":  yamlType,
}

// JsExpr 是 YAML !js 标签（tag:yaml.org,2002:js）的不透明值：不求值，
// 解析与写回往返保真（差异清单第 4 条）。
type JsExpr struct{ Expr string }

// RuntimeConfigError 明确拒绝需要 JS 求值的执行路径；文件解析与写回仍保真。
func (JsExpr) RuntimeConfigError() error {
	return errors.New("Go 插件运行时不支持执行 !js 表达式")
}

func (JsExpr) MarshalJSON() ([]byte, error) {
	return nil, errors.New("JSON 配置不支持 !js 标签，请使用 YAML 保存")
}

// ConfigFileError 对应 index.ts:36-42：配置文件在某阶段无法就绪。
// Stage 取 read/parse/validate（协议值）。
type ConfigFileError struct {
	Stage string
	Path  string
	Cause error
}

func (e *ConfigFileError) Error() string {
	stage := e.Stage
	switch stage {
	case "read":
		stage = "读取"
	case "parse":
		stage = "解析"
	case "validate":
		stage = "校验"
	}
	return fmt.Sprintf("无法%s配置文件 %s：%v", stage, e.Path, e.Cause)
}

// Unwrap 暴露原因（ENOENT 判定经 errors.Is/As）。
func (e *ConfigFileError) Unwrap() error { return e.Cause }

// staleWriteError 对应 index.ts:44-47：重命名前发现文件已被外部改动。
type staleWriteError struct{}

func (*staleWriteError) Error() string { return "写入窗口内配置文件已被外部修改" }

// Config 对应 Include.Config（index.ts:73-79）。
type Config struct {
	Path       string                 `yaml:"path"`
	Initial    []*loader.EntryOptions `yaml:"initial"`
	Patches    []PatchOptions         `yaml:"patches"`
	EnableLogs *bool                  `yaml:"enableLogs"`
	Extras     map[string]any         `yaml:",inline"`
}

// CloneConfig 为 loader 的不可变快照显式复制补丁私有字段。
func (c Config) CloneConfig() any { return cloneConfig(c) }

// Plugin 以插件形态装载 include（static inject = ['loader']）。
var Plugin = &kardia.Plugin{
	Name:   "@cordisjs/plugin-include",
	Inject: kardia.InjectMap{"loader": nil},
	Apply:  newInclude,
}

// FileOps 是文件操作接缝（默认实现包 os；write.spec 的失败注入经它替换
// Rename，sync 的只读用例经它替换 Writable）。
type FileOps interface {
	ReadFile(path string) ([]byte, error)
	WriteFile(path string, data []byte) error
	Rename(oldpath, newpath string) error
	Remove(path string) error
	// Writable 等价 access(path, W_OK)：以只写试开实现。
	Writable(path string) bool
}

// osFileOps 是 FileOps 的默认实现。
type osFileOps struct{}

func (osFileOps) ReadFile(path string) ([]byte, error) { return os.ReadFile(path) }

func (osFileOps) WriteFile(path string, data []byte) error {
	return os.WriteFile(path, data, 0o644)
}

func (osFileOps) Rename(oldpath, newpath string) error { return os.Rename(oldpath, newpath) }

func (osFileOps) Remove(path string) error { return os.Remove(path) }

func (osFileOps) Writable(path string) bool {
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		return false
	}
	return f.Close() == nil
}

// snapshot 对应 index.ts:31-34：最后一次读到或写成的文件状态。
type snapshot struct {
	content string
	data    []*loader.EntryOptions
}

// includeByTree 登记子树指针到 Include 实例的反查表：TS 里 Include 继承
// EntryTree（同一对象，as Include 即可），Go 的嵌入无法从 *EntryTree 上溯，
// 经此表取回服务本体（契约外的补充导出，见 deviations）。
var (
	includeByTreeMu sync.Mutex
	includeByTree   = map[*loader.EntryTree]*Include{}
)

// IncludeOf 返回挂载在某条目下的 include 服务实例。
func IncludeOf(tree *loader.EntryTree) *Include {
	inc := includeInstance(tree)
	if inc == nil {
		return nil
	}
	inc.mu.Lock()
	stopping := inc.stopTask != nil
	inc.mu.Unlock()
	if stopping {
		return nil
	}
	return inc
}

// includeInstance 供父树收尾等待已经开始停止的子 include，不作为可用服务返回。
func includeInstance(tree *loader.EntryTree) *Include {
	if tree == nil {
		return nil
	}
	includeByTreeMu.Lock()
	defer includeByTreeMu.Unlock()
	return includeByTree[tree]
}

// anonymousEntry 对应 index.ts:49-52：文件留给匿名条目的 id 记录
// （parent 为空串表示根）。
type anonymousEntry struct {
	parent  string
	options *loader.EntryOptions
}

// Include 对应 TS Include：一个配置文件驱动的条目树。
type Include struct {
	*loader.EntryTree
	// Filename 是解析后的配置文件绝对路径。
	Filename string
	// 文件操作接缝受 mu 保护；通过 SetFileOps 注入。
	files FileOps

	mu              sync.Mutex
	config          Config
	savedConfig     any
	configRevision  uint64
	fileType        string
	cache           *snapshot
	journal         *Journal
	inflight        *Journal
	anonymous       map[string]*anonymousEntry
	dirtyRead       bool
	dirtyWrite      bool
	draining        chan struct{}
	pendingTree     []*loader.EntryOptions // 只保留最新意向（nil=无，空切片是合法树）
	pendingRevision uint64
	pendingVersion  uint64
	revision        uint64
	applyErr        error
	drainErr        error
	stopTask        chan struct{}
	stopErr         error
	off             func() bool
	applyTask       chan struct{}
	disposed        bool
	seq             int
}

// New 对应 TS Include 构造器（index.ts:105-128）：解析文件名与类型、建树、
// 补齐 insert id、登记 internal/update 监听。enableLogs 未
// 显式设置时沿用外层树（index.ts:107）。
func New(ctx *kardia.Context, cfg Config) (*Include, error) {
	if cfg.Path == "" {
		return nil, fmt.Errorf("include 配置缺少 path")
	}
	enableLogs := false
	if cfg.EnableLogs != nil {
		enableLogs = *cfg.EnableLogs
	} else if e := loader.EntryOfFiber(ctx.Fiber()); e != nil && e.Parent() != nil && e.Parent().Tree() != nil {
		enableLogs = e.Parent().Tree().EnableLogs()
	}
	filename, err := resolveFilename(ctx.BaseURL(), cfg.Path)
	if err != nil {
		return nil, err
	}
	ext := strings.ToLower(filepath.Ext(filename))
	fileType, ok := fileTypes[ext]
	if !ok {
		return nil, fmt.Errorf("不支持的配置文件扩展名 %q", ext)
	}

	// tree.ts:32-33 的 baseUrl 层 + index.ts:114 的目录覆盖：以配置文件
	// 所在目录为树 ctx 的最终 baseUrl（先落定再建根组，等价 TS 构造后原地
	// 赋值对根组的可见性）
	treeCtx := ctx.Extend(kardia.ExtendMeta{BaseURL: ctx.BaseURL(), HasBaseURL: true})
	treeCtx = treeCtx.Extend(kardia.ExtendMeta{BaseURL: filepath.Dir(filename), HasBaseURL: true})
	tree := loader.NewTree(treeCtx)
	tree.SetEnableLogs(enableLogs)

	inc := &Include{
		EntryTree:   tree,
		Filename:    filename,
		files:       osFileOps{},
		config:      cloneConfig(cfg),
		savedConfig: cloneConfigValue(cfg),
		fileType:    fileType,
		journal:     NewJournal(),
		anonymous:   map[string]*anonymousEntry{},
	}
	tree.SetCommit(inc.commit)
	includeByTreeMu.Lock()
	includeByTree[tree] = inc
	includeByTreeMu.Unlock()

	EnsureInsertIDs(inc.config.Patches, inc.hasEntry, loader.RandomID)

	// index.ts:117-123：配置更新时若 path 不变则热应用（否决自身重启，
	// 以 _scheduleApply 的树调和取代）
	inc.off, err = ctx.On(kardia.StringEvent("internal/update"), func(ev *kardia.EventCtx) (any, error) {
		if ev.Next == nil || len(ev.Args) == 0 {
			return nil, nil
		}
		next, err := NormalizeConfig(ev.Args[0])
		if err != nil {
			return nil, err
		}
		inc.mu.Lock()
		samePath := next.Path == inc.config.Path
		inc.mu.Unlock()
		if !samePath {
			return ev.Next()
		}
		EnsureInsertIDs(next.Patches, inc.hasEntry, loader.RandomID)
		inc.mu.Lock()
		if inc.disposed {
			inc.mu.Unlock()
			return nil, errors.New("include 已停止")
		}
		inc.config = cloneConfig(next)
		inc.savedConfig = cloneConfigValue(ev.Args[0])
		inc.configRevision++
		inc.revision++
		inc.mu.Unlock()
		inc.scheduleApply()
		return true, inc.waitApply(ev.Context)
	})
	if err != nil {
		inc.unregister()
		return nil, err
	}

	return inc, nil
}

// newInclude 是插件的 Apply：构造服务、执行 init 生成器首段（读取或回落
// initial）、返回 stop 清理器。TS 在 yield 之后残余的 `await this._applyTask`
// 在此改为同步等待首个树应用收敛：让 fiber 的惯性覆盖首次应用，调用方
// （loader.await / fiber.Await）由此获得确定性就绪语义（见 deviations）。
func newInclude(ctx *kardia.Context, config any) (kardia.Disposable, error) {
	cfg, err := NormalizeConfig(config)
	if err != nil {
		return nil, err
	}
	inc, err := New(ctx, cfg)
	if err != nil {
		return nil, err
	}
	inc.mu.Lock()
	inc.savedConfig = cloneConfigValue(config)
	inc.mu.Unlock()
	if err := inc.bootstrap(ctx.Lifetime()); err != nil {
		_ = inc.Stop(context.Background())
		return nil, err
	}
	if err := inc.waitApply(ctx.Lifetime()); err != nil {
		_ = inc.Stop(context.Background())
		return nil, err
	}
	return func(dctx context.Context) error { return inc.Stop(dctx) }, nil
}

// bootstrap 对应 init 生成器的首段（index.ts:134-152）：读取失败且仅当
// ENOENT 时回落 initial（写盘后重读）。
func (inc *Include) bootstrap(ctx context.Context) error {
	if err := inc.read(ctx); err != nil {
		var cfe *ConfigFileError
		if errors.As(err, &cfe) && cfe.Stage == "read" && errors.Is(cfe.Cause, fs.ErrNotExist) {
			if inc.config.Initial == nil {
				return fmt.Errorf("找不到配置文件：%s", inc.Filename)
			}
			initial := cloneList(inc.config.Initial)
			EnsureIDs(initial, inc.hasEntry, loader.RandomID)
			text, err := inc.dump(initial)
			if err != nil {
				return err
			}
			if err := inc.writeText(ctx, text, nil); err != nil {
				return err
			}
			if err := inc.read(ctx); err != nil {
				return err
			}
		} else {
			return err
		}
	}
	return nil
}

// Stop 对应 index.ts:154-165：停止后续应用意向、冲刷未落盘变更（这也是
// 失败写入留在账本里的内容的最后一次机会）、最后撤下整棵树。
func (inc *Include) Stop(ctx context.Context) error {
	inc.mu.Lock()
	ch := inc.stopTask
	if ch == nil {
		ch = make(chan struct{})
		inc.stopTask = ch
		inc.pendingTree = nil
		inc.mu.Unlock()
		// IncludeOf 即刻停止提供实例，内部反查保留到共享停止任务完成。
		inc.Ctx.Tasks().Go(func() {
			sealErr := inc.EntryTree.Seal(context.Background())
			// 子 include 的补丁归属父配置，必须先让这些已接受的内部提交入账。
			var childErrors []error
			entries := inc.EntryTree.Entries()
			for i := len(entries) - 1; i >= 0; i-- {
				child := includeInstance(entries[i].Subtree())
				if child != nil && child != inc {
					if err := child.Stop(context.Background()); err != nil {
						childErrors = append(childErrors, err)
					}
				}
			}
			inc.mu.Lock()
			inc.disposed = true
			inc.pendingTree = nil
			inc.dirtyWrite = inc.dirtyWrite || inc.journal.Len() > 0
			inc.mu.Unlock()
			inc.EntryTree.SetCommit(nil)
			if inc.off != nil {
				inc.off()
			}
			inc.drain()
			flushErr := inc.Flush(context.Background())
			stopErr := inc.EntryTree.Close(context.Background())
			inc.unregister()
			inc.mu.Lock()
			inc.stopErr = errors.Join(sealErr, errors.Join(childErrors...), flushErr, stopErr)
			close(ch)
			inc.mu.Unlock()
		})
	} else {
		inc.mu.Unlock()
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-ch:
	}
	inc.mu.Lock()
	defer inc.mu.Unlock()
	return inc.stopErr
}

func (inc *Include) unregister() {
	inc.EntryTree.SetCommit(nil)
	includeByTreeMu.Lock()
	delete(includeByTree, inc.EntryTree)
	includeByTreeMu.Unlock()
}

// SetFileOps 替换文件访问接缝；已开始的单次操作继续使用其快照。
func (inc *Include) SetFileOps(files FileOps) {
	if files == nil {
		files = osFileOps{}
	}
	inc.mu.Lock()
	inc.files = files
	inc.mu.Unlock()
}

func (inc *Include) fileOps() FileOps {
	inc.mu.Lock()
	defer inc.mu.Unlock()
	return inc.files
}

func (inc *Include) waitApply(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	for {
		inc.mu.Lock()
		ch, err := inc.applyTask, inc.applyErr
		inc.mu.Unlock()
		if ch == nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ch:
		}
	}
}

// Flush 对应 index.ts:171-176：等待全部待决读取与写入完成（含写成的树
// 调和）。与 Refresh 不同，本方法等待写。
func (inc *Include) Flush(ctx context.Context) error {
	for {
		inc.mu.Lock()
		draining, apply := inc.draining, inc.applyTask
		if draining == nil && (inc.dirtyRead || inc.dirtyWrite) {
			inc.mu.Unlock()
			inc.drain()
			continue
		}
		err := errors.Join(inc.drainErr, inc.applyErr)
		inc.mu.Unlock()
		if draining == nil && apply == nil {
			return err
		}
		if draining != nil {
			select {
			case <-draining:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		if apply != nil {
			select {
			case <-apply:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
}

// Refresh 对应 index.ts:179-183：重读文件并与树调和（等待写完成）。
func (inc *Include) Refresh(ctx context.Context) error {
	inc.mu.Lock()
	if inc.stopTask != nil || inc.disposed {
		inc.mu.Unlock()
		return errors.New("include 已停止")
	}
	inc.dirtyRead = true
	inc.mu.Unlock()
	inc.drain()
	return inc.Flush(ctx)
}

// commit 是 EntryTree.CommitFn 的实现（index.ts:186-192）：树侧变更入账
// 并触发写循环。
func (inc *Include) commit(change loader.EntryChange) {
	inc.mu.Lock()
	if inc.disposed {
		inc.mu.Unlock()
		return
	}
	Record(inc.journal, change, change.Parent)
	inc.revision++
	inc.dirtyWrite = true
	inc.mu.Unlock()
	inc.drain()
	// 配置通知不能阻塞 loader 的提交队列，监听者允许回读或等待 Flush。
	inc.Ctx.Tasks().Go(func() {
		if err := inc.Ctx.Emit(kardia.StringEvent("loader/config-update")); err != nil {
			inc.Ctx.Logger().Error(err)
		}
	})
}

// drain 对应 _drain（index.ts:194-199）：写循环的单航班启动。
func (inc *Include) drain() {
	inc.mu.Lock()
	if inc.draining != nil || (!inc.dirtyRead && !inc.dirtyWrite) {
		inc.mu.Unlock()
		return
	}
	ch := make(chan struct{})
	inc.draining = ch
	inc.drainErr = nil
	inc.mu.Unlock()
	inc.Ctx.Tasks().Go(func() { inc.loop(ch) })
}

// loop 在同一临界区检查待处理标志并释放单航班，避免退出窗口丢失唤醒。
func (inc *Include) loop(ch chan struct{}) {
	for {
		inc.mu.Lock()
		read, write := inc.dirtyRead, inc.dirtyWrite
		if !read && !write {
			inc.draining = nil
			close(ch)
			inc.mu.Unlock()
			return
		}
		if read {
			inc.dirtyRead = false
		} else {
			inc.dirtyWrite = false
		}
		inc.mu.Unlock()
		var err error
		if read {
			err = inc.read(context.Background())
		} else {
			err = inc.write(context.Background())
		}
		if err == nil {
			continue
		}
		if read {
			inc.Ctx.Logger().Warn(err)
		} else {
			inc.Ctx.Logger().Error(err)
		}
		inc.mu.Lock()
		inc.drainErr = errors.Join(inc.drainErr, err)
		// 读取失败时不依据未知文件状态写盘，保留账本供下一次显式刷新或停止。
		if read && !inc.dirtyRead {
			inc.dirtyWrite = false
			inc.draining = nil
			close(ch)
			inc.mu.Unlock()
			return
		}
		inc.mu.Unlock()
	}
}

// read 对应 _read（index.ts:228-265）：读文件、解析、稳定匿名 id、与既有
// 账本三方调和（文件获胜）、更新缓存并调度树应用。
func (inc *Include) read(ctx context.Context) error {
	content, err := inc.fileOps().ReadFile(inc.Filename)
	if err != nil {
		return &ConfigFileError{Stage: "read", Path: inc.Filename, Cause: err}
	}
	inc.mu.Lock()
	cached := inc.cache
	inc.mu.Unlock()
	if cached != nil && cached.content == string(content) {
		return nil
	}
	entries, err := inc.parse(content)
	if err != nil {
		return err
	}
	inc.assignIDs(entries)

	inc.mu.Lock()
	var conflicts []Conflict
	if cached != nil {
		index := NewPatchIndex(inc.config.Patches)
		base := Flatten(cached.data, nil)
		theirs := Flatten(entries, nil)
		conflicts = Reconcile(inc.journal, base, theirs, index.FileOwned)
	}
	inc.cache = &snapshot{content: string(content), data: entries}
	inc.revision++
	hasJournal := inc.journal.Len() > 0
	inc.mu.Unlock()
	for _, c := range conflicts {
		inc.Ctx.Logger().Error(fmt.Sprintf("配置文件 %s 冲突：条目 %s %s；以文件为准", inc.Filename, c.ID, c.Reason))
	}
	inc.scheduleApply()
	if hasJournal {
		inc.mu.Lock()
		inc.dirtyWrite = true
		inc.mu.Unlock()
	}
	return nil
}

// parse 解析并校验顶层形状（阶段错误以 *ConfigFileError 报告）。
func (inc *Include) parse(content []byte) ([]*loader.EntryOptions, error) {
	var data any
	var err error
	if inc.fileType == jsonType {
		data, err = parseJSONDoc(content)
	} else {
		data, err = parseYAMLDoc(content)
	}
	if err != nil {
		return nil, &ConfigFileError{Stage: "parse", Path: inc.Filename, Cause: err}
	}
	if data == nil {
		return nil, &ConfigFileError{Stage: "validate", Path: inc.Filename, Cause: errors.New("配置文件必须是顶层数组")}
	}
	entries, err := loader.ParseEntries(data)
	if err != nil {
		return nil, &ConfigFileError{Stage: "validate", Path: inc.Filename, Cause: err}
	}
	return entries, nil
}

// write 对应 _write（index.ts:267-344）：批量换出账本、路由到文件/补丁、
// 写前只读检查、临时文件 + rename 落盘；失败回灌账本。
func (inc *Include) write(ctx context.Context) error {
	inc.mu.Lock()
	cached := inc.cache
	journalLen := inc.journal.Len()
	inc.mu.Unlock()
	if cached == nil || journalLen == 0 {
		return nil
	}
	current, err := inc.fileOps().ReadFile(inc.Filename)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			inc.mu.Lock()
			n := inc.journal.Len()
			inc.mu.Unlock()
			inc.Ctx.Logger().Warn(fmt.Sprintf("配置文件 %s 不存在，%d 项待写变更保留在内存中", inc.Filename, n))
			return nil
		}
		return err
	}
	if string(current) != cached.content {
		// 有他人写入：先读后写，稍后回来
		inc.mu.Lock()
		inc.dirtyRead = true
		inc.dirtyWrite = true
		inc.mu.Unlock()
		return nil
	}

	// 快照换出：写入期间上报的变更属于下一轮
	inc.mu.Lock()
	batch := inc.journal
	inc.journal = NewJournal()
	inc.inflight = batch
	inc.mu.Unlock()
	restore := func() {
		inc.mu.Lock()
		inc.journal.Each(func(id string, rec *JournalRecord) {
			MergeJournal(batch, id, rec)
		})
		inc.journal = batch
		inc.inflight = nil
		inc.mu.Unlock()
	}

	data := cloneList(cached.data)
	inc.mu.Lock()
	patches := clonePatches(inc.config.Patches)
	cfg := cloneConfig(inc.config)
	saved := cloneConfigValue(inc.savedConfig)
	cfgRevision := inc.configRevision
	inc.mu.Unlock()
	var patched bool
	data, patched = RouteJournal(batch, data, patches, inc.warn)
	if patched {
		cfg.Patches = patches
		next := configToNative(cfg)
		if owner := loader.EntryOfFiber(inc.Ctx.Fiber()); owner != nil {
			if err := owner.SaveConfig(saved, next); err != nil {
				restore()
				if errors.Is(err, loader.ErrStaleRevision) {
					inc.mu.Lock()
					stopped := inc.disposed
					if !stopped {
						inc.dirtyWrite = true
					}
					inc.mu.Unlock()
					if stopped {
						return err
					}
					return nil
				}
				return err
			}
		} else {
			inc.Ctx.Logger().Warn(fmt.Sprintf("补丁在运行时发生变更但无法持久化：%s", inc.Filename))
		}
		inc.mu.Lock()
		if inc.configRevision != cfgRevision {
			inc.mu.Unlock()
			restore()
			inc.mu.Lock()
			inc.dirtyWrite = true
			inc.mu.Unlock()
			return nil
		}
		inc.config.Patches = patches
		inc.savedConfig = next
		inc.configRevision++
		inc.revision++
		inc.mu.Unlock()
	}

	// 文件本身无事可写（仅补丁变更，或分配给已在缓存中的匿名条目的 id）
	if valueEqual(data, cached.data) {
		inc.mu.Lock()
		inc.inflight = nil
		inc.mu.Unlock()
		inc.scheduleApply()
		return nil
	}
	text, err := inc.dump(data)
	if err != nil {
		restore()
		return err
	}

	if !inc.fileOps().Writable(inc.Filename) {
		restore()
		inc.mu.Lock()
		n := inc.journal.Len()
		inc.mu.Unlock()
		inc.Ctx.Logger().Warn(fmt.Sprintf("配置文件 %s 为只读，%d 项待写变更保留在内存中", inc.Filename, n))
		return nil
	}

	if err := inc.writeText(ctx, text, &cached.content); err != nil {
		restore()
		var swe *staleWriteError
		if errors.As(err, &swe) {
			inc.mu.Lock()
			inc.dirtyRead = true
			inc.dirtyWrite = true
			inc.mu.Unlock()
			return nil
		}
		inc.mu.Lock()
		n := inc.journal.Len()
		inc.mu.Unlock()
		inc.Ctx.Logger().Warn(fmt.Sprintf("写入配置文件 %s 失败：%d 项待写变更保留在内存中", inc.Filename, n))
		return err
	}
	inc.mu.Lock()
	inc.cache = &snapshot{content: text, data: data}
	inc.inflight = nil
	inc.revision++
	inc.mu.Unlock()
	inc.scheduleApply()
	return nil
}

// writeText 对应 _writeText（index.ts:351-372）：经临时文件与 rename 写入，
// 读者永远不会看到半截文件；给定 expected 时（及每次重试前）校验文件仍
// 持有该内容，否则按 StaleWriteError 放弃。瞬态错误（EACCES/EPERM/EBUSY）
// 最多重试 10 次，退避 20ms×(n+1) 走注入时钟。
func (inc *Include) writeText(ctx context.Context, text string, expected *string) error {
	files := inc.fileOps()
	inc.mu.Lock()
	seq := inc.seq
	inc.seq++
	inc.mu.Unlock()
	dir, base := filepath.Split(inc.Filename)
	tmp := filepath.Join(dir, fmt.Sprintf(".%s.%d.%d.tmp", base, os.Getpid(), seq))
	if err := files.WriteFile(tmp, []byte(text)); err != nil {
		return err
	}
	cleanup := func() { _ = files.Remove(tmp) }
	for attempt := 0; ; attempt++ {
		if expected != nil {
			current, err := files.ReadFile(inc.Filename)
			if err != nil || string(current) != *expected {
				cleanup()
				return &staleWriteError{}
			}
		}
		if err := files.Rename(tmp, inc.Filename); err == nil {
			return nil
		} else if attempt >= renameRetries || !isTransientRenameError(err) {
			cleanup()
			return err
		}
		if serr := inc.Ctx.Clock().Sleep(ctx, renameBackoff*time.Duration(attempt+1)); serr != nil {
			cleanup()
			return serr
		}
	}
}

// isTransientRenameError 对应 index.ts:67-70：Windows 上被杀毒软件等短暂
// 占用的目标文件会让 rename 以 EACCES/EPERM/EBUSY 失败，通常毫秒级释放；
// 有界重试在所有平台都足够廉价。
func isTransientRenameError(err error) bool {
	return errors.Is(err, syscall.EACCES) ||
		errors.Is(err, syscall.EPERM) ||
		errors.Is(err, syscall.EBUSY)
}

// dump 把条目列表写成文件文本（YAML 键序按 sortKeys：id、name、其余
// 字母序、config 最后；JSON 以两空格缩进）。
func (inc *Include) dump(data []*loader.EntryOptions) (string, error) {
	if inc.fileType == jsonType {
		return dumpJSONEntries(data)
	}
	return dumpYAMLEntries(data)
}

// scheduleApply 对应 _scheduleApply（index.ts:426-441）：把补丁与账本叠到
// 缓存解析上，只保留最新意向，由单航班的应用任务逐份落到根组。
func (inc *Include) scheduleApply() {
	for {
		inc.mu.Lock()
		stopped := inc.stopTask != nil || inc.disposed
		inc.mu.Unlock()
		if stopped {
			return
		}
		treeRevision, err := inc.EntryTree.SnapshotRevision(context.Background())
		if err != nil {
			inc.mu.Lock()
			inc.applyErr = err
			inc.mu.Unlock()
			return
		}
		inc.mu.Lock()
		if inc.stopTask != nil || inc.disposed || inc.cache == nil {
			inc.mu.Unlock()
			return
		}
		revision := inc.revision
		cached := cloneList(inc.cache.data)
		patches := clonePatches(inc.config.Patches)
		journal := NewJournal()
		if inc.inflight != nil {
			inc.inflight.Each(func(id string, rec *JournalRecord) { MergeJournal(journal, id, cloneRecord(rec)) })
		}
		inc.journal.Each(func(id string, rec *JournalRecord) { MergeJournal(journal, id, cloneRecord(rec)) })
		inc.mu.Unlock()
		var warnings []string
		warn := func(format string, args ...any) { warnings = append(warnings, fmt.Sprintf(format, args...)) }
		tree := ApplyPatches(cached, patches, warn)
		tree = ApplyJournal(tree, journal, nil, warn)
		inc.mu.Lock()
		if inc.stopTask != nil || inc.disposed {
			inc.mu.Unlock()
			return
		}
		if revision != inc.revision {
			inc.mu.Unlock()
			continue
		}
		inc.pendingTree, inc.pendingRevision, inc.pendingVersion = tree, treeRevision, revision
		inc.applyErr = nil
		start := inc.applyTask == nil
		var ch chan struct{}
		if start {
			ch = make(chan struct{})
			inc.applyTask = ch
			inc.applyErr = nil
		}
		inc.mu.Unlock()
		for _, message := range warnings {
			inc.warn("%s", message)
		}
		if start {
			inc.Ctx.Tasks().Go(func() { inc.runApply(ch) })
		}
		return
	}
}

func (inc *Include) runApply(ch chan struct{}) {
	for {
		inc.mu.Lock()
		tree, revision, version := inc.pendingTree, inc.pendingRevision, inc.pendingVersion
		inc.pendingTree = nil
		if tree == nil {
			inc.applyTask = nil
			close(ch)
			inc.mu.Unlock()
			return
		}
		inc.mu.Unlock()
		err := inc.Root.UpdateRevision(context.Background(), tree, revision)
		if errors.Is(err, loader.ErrStaleRevision) {
			inc.scheduleApply()
			continue
		}
		inc.mu.Lock()
		obsolete := version != inc.revision
		stopping := inc.stopTask != nil
		if !obsolete && !(stopping && (errors.Is(err, loader.ErrTreeClosed) || errors.Is(err, context.Canceled))) {
			inc.applyErr = err
		}
		inc.mu.Unlock()
		if obsolete {
			inc.scheduleApply()
			continue
		}
		if err != nil && !(stopping && (errors.Is(err, loader.ErrTreeClosed) || errors.Is(err, context.Canceled))) {
			inc.Ctx.Logger().Error(err)
		}
	}
}

// assignIDs 对应 _assignIds（index.ts:386-424）：文件留给匿名的条目在此
// （loader 见到之前）获得 id；与上一轮同父同内容者沿用旧 id（编辑邻居不
// 重启它），其余发新 id。已分配的 id 留在内存中直至下次写盘随行。
func (inc *Include) assignIDs(data []*loader.EntryOptions) {
	used := map[string]bool{}
	type pendingItem struct {
		options *loader.EntryOptions
		parent  string
	}
	var pending []pendingItem
	var walk func(entries []*loader.EntryOptions, parent string)
	walk = func(entries []*loader.EntryOptions, parent string) {
		for _, options := range entries {
			if options == nil {
				continue
			}
			if options.ID != "" {
				used[options.ID] = true
			} else {
				pending = append(pending, pendingItem{options: options, parent: parent})
			}
			if options.Group != nil && *options.Group {
				if list, ok := listOf(options); ok {
					nested := parent
					if options.ID != "" {
						nested = options.ID
					}
					walk(list, nested)
				}
			}
		}
	}
	walk(data, "")

	inc.mu.Lock()
	previous := make(map[string]*anonymousEntry, len(inc.anonymous))
	for key, value := range inc.anonymous {
		previous[key] = value
	}
	inc.mu.Unlock()
	fresh := map[string]*anonymousEntry{}
	for _, item := range pending {
		id := ""
		for candidate, info := range previous {
			if info.parent != item.parent || !entryEqual(info.options, item.options) {
				continue
			}
			id = candidate
			delete(previous, candidate)
			break
		}
		if id == "" {
			for {
				id = loader.RandomID()
				if !used[id] && !inc.hasEntry(id) {
					break
				}
			}
		}
		used[id] = true
		fresh[id] = &anonymousEntry{parent: item.parent, options: cloneEntry(item.options)}
		loader.SetKey(item.options, "id", id)
	}
	inc.mu.Lock()
	inc.anonymous = fresh
	inc.mu.Unlock()
}

// hasEntry 报告树内是否已有该 id 的条目（EnsureIDs/EnsureInsertIDs 的
// 查重回调）。
func (inc *Include) hasEntry(id string) bool {
	_, err := inc.Resolve(id)
	return err == nil
}

// warn 是机制层的告警通道（index.ts:130-132 的 root logger）。
func (inc *Include) warn(format string, args ...any) {
	inc.Ctx.Root().Logger("loader").Warn(fmt.Sprintf(format, args...))
}

// —— 配置形态归一 ——

// NormalizeConfig 把任意形态的 include 配置归一为 Config：接受 Config
// 本体与原生 map（文件解析/测试构造产物，含 patches/initial 的原生列表）。
func NormalizeConfig(v any) (Config, error) {
	switch c := v.(type) {
	case Config:
		return cloneConfig(c), nil
	case *Config:
		if c != nil {
			return cloneConfig(*c), nil
		}
	case map[string]any:
		cfg := Config{}
		if value, exists := c["path"]; exists {
			var ok bool
			cfg.Path, ok = value.(string)
			if !ok {
				return Config{}, errors.New("include path 必须是字符串")
			}
		}
		if raw, exists := c["initial"]; exists && raw != nil {
			list, err := loader.ParseEntries(raw)
			if err != nil {
				return Config{}, fmt.Errorf("include initial 无效：%w", err)
			}
			cfg.Initial = list
		}
		if value, exists := c["patches"]; exists && value != nil {
			switch raw := value.(type) {
			case []PatchOptions:
				cfg.Patches = clonePatches(raw)
			case []any:
				cfg.Patches = make([]PatchOptions, 0, len(raw))
				for _, item := range raw {
					m, ok := item.(map[string]any)
					if !ok {
						return Config{}, errors.New("include patches 的成员必须是对象")
					}
					patch, err := patchFromMap(m)
					if err != nil {
						return Config{}, err
					}
					cfg.Patches = append(cfg.Patches, patch)
				}
			default:
				return Config{}, errors.New("include patches 必须是数组")
			}
		}
		if value, exists := c["enableLogs"]; exists && value != nil {
			logs, ok := value.(bool)
			if !ok {
				return Config{}, errors.New("include enableLogs 必须是布尔值")
			}
			cfg.EnableLogs = &logs
		}
		cfg.Extras = map[string]any{}
		for key, value := range c {
			switch key {
			case "path", "initial", "patches", "enableLogs":
				continue
			}
			cfg.Extras[key] = copyPlainValue(value)
		}
		return cfg, nil
	}
	return Config{}, fmt.Errorf("include 配置形态不受支持：%T", v)
}

// patchFromMap 把原生 map 组装成补丁（具名键之外全入 override 表）。
func patchFromMap(m map[string]any) (PatchOptions, error) {
	var p PatchOptions
	for _, key := range []string{"id", "name"} {
		if raw, exists := m[key]; exists && raw != nil {
			value, ok := raw.(string)
			if !ok {
				return p, fmt.Errorf("include 补丁 %s 必须是字符串", key)
			}
			if value != "" {
				if key == "id" {
					p.ID = &value
				} else {
					p.Name = &value
				}
			}
		}
	}
	if raw, exists := m["insert"]; exists && raw != nil {
		list, err := loader.ParseEntries(raw)
		if err != nil {
			return p, fmt.Errorf("include 补丁 insert 无效：%w", err)
		}
		p.Insert = list
	}
	for key, value := range m {
		switch key {
		case "id", "name", "insert":
			continue
		}
		p.SetOverride(key, normalizeValue(key, copyPlainValue(value)))
	}
	return p, nil
}

// clonePatches 深拷贝补丁列表（structuredClone 的等价物；override 表与
// insert 列表逐项重建）。
func clonePatches(patches []PatchOptions) []PatchOptions {
	if patches == nil {
		return nil
	}
	out := make([]PatchOptions, len(patches))
	for i, p := range patches {
		out[i].ID = copyStrPtr(p.ID)
		out[i].Name = copyStrPtr(p.Name)
		out[i].Insert = cloneList(p.Insert)
		overrides := make(map[string]any, len(p.overrides))
		for k, v := range p.overrides {
			overrides[k] = copyPlainValue(v)
		}
		out[i].overrides = overrides
	}
	return out
}

func copyStrPtr(s *string) *string {
	if s == nil {
		return nil
	}
	c := *s
	return &c
}

// copyPlainValue 深复制补丁值，并尊重自定义配置的 CloneConfig 接口。
func copyPlainValue(v any) any { return cloneConfigValue(v) }

// resolveFilename 以目录形态的 BaseURL 解析相对路径；file URL 仅在入口解码。
func resolveFilename(base, path string) (string, error) {
	decode := func(value string) (string, error) {
		if !strings.HasPrefix(value, "file:") {
			if strings.Contains(value, "://") {
				return "", errors.New("配置路径只支持本地文件或 file URL")
			}
			return value, nil
		}
		u, err := url.Parse(value)
		if err != nil {
			return "", fmt.Errorf("配置路径 URL 无效：%w", err)
		}
		if u.Host != "" && u.Host != "localhost" {
			return "", errors.New("配置路径仅支持本机 file URL")
		}
		if u.RawQuery != "" || u.Fragment != "" {
			return "", errors.New("配置路径 URL 不支持查询参数或片段")
		}
		return u.Path, nil
	}
	resolved, err := decode(path)
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(resolved) {
		directory, err := decode(base)
		if err != nil {
			return "", err
		}
		resolved = filepath.Join(directory, resolved)
	}
	absolute, err := filepath.Abs(resolved)
	if err != nil {
		return "", fmt.Errorf("无法解析配置文件绝对路径：%w", err)
	}
	return filepath.Clean(absolute), nil
}

func cloneConfig(c Config) Config {
	c.Initial = cloneList(c.Initial)
	c.Patches = clonePatches(c.Patches)
	if c.EnableLogs != nil {
		logs := *c.EnableLogs
		c.EnableLogs = &logs
	}
	if c.Extras != nil {
		out := make(map[string]any, len(c.Extras))
		for key, value := range c.Extras {
			out[key] = copyPlainValue(value)
		}
		c.Extras = out
	}
	return c
}

// —— YAML 解析与写回 ——

// parseYAMLDoc 解析 YAML 文档为原生值（!js 标签成为 JsExpr）。
func parseYAMLDoc(content []byte) (any, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(content, &doc); err != nil {
		return nil, err
	}
	node := &doc
	if node.Kind == 0 {
		return nil, nil
	}
	if node.Kind == yaml.DocumentNode {
		if len(node.Content) == 0 {
			return nil, nil
		}
		node = node.Content[0]
	}
	return nodeToValue(node)
}

// nodeToValue 递归转换 yaml.Node：映射→map[string]any、序列→[]any、
// 标量按 tag 分派（!js 成为 JsExpr）。
func nodeToValue(n *yaml.Node) (any, error) { return nodeValueAtDepth(n, 0) }

func nodeValueAtDepth(n *yaml.Node, depth int) (any, error) {
	if n == nil || depth > 128 {
		return nil, errors.New("YAML 嵌套过深或存在循环别名")
	}
	switch n.Kind {
	case yaml.DocumentNode:
		if len(n.Content) == 0 {
			return nil, nil
		}
		return nodeValueAtDepth(n.Content[0], depth+1)
	case yaml.SequenceNode:
		out := make([]any, 0, len(n.Content))
		for _, child := range n.Content {
			v, err := nodeValueAtDepth(child, depth+1)
			if err != nil {
				return nil, err
			}
			out = append(out, v)
		}
		return out, nil
	case yaml.MappingNode:
		m := make(map[string]any, len(n.Content)/2)
		for i := 0; i+1 < len(n.Content); i += 2 {
			key := n.Content[i]
			if key.Kind != yaml.ScalarNode || key.Tag != "!!str" {
				return nil, errors.New("YAML 配置对象的键必须是字符串")
			}
			if _, exists := m[key.Value]; exists {
				return nil, fmt.Errorf("YAML 配置包含重复键 %q", key.Value)
			}
			v, err := nodeValueAtDepth(n.Content[i+1], depth+1)
			if err != nil {
				return nil, err
			}
			m[n.Content[i].Value] = v
		}
		return m, nil
	case yaml.ScalarNode:
		return scalarNodeValue(n)
	case yaml.AliasNode:
		return nodeValueAtDepth(n.Alias, depth+1)
	default:
		return nil, fmt.Errorf("无法识别的 YAML 节点形态：%d", n.Kind)
	}
}

// scalarNodeValue 按标量 tag 分派：!!null/!!bool/!!int/!!float/!js/字符串。
func scalarNodeValue(n *yaml.Node) (any, error) {
	switch n.Tag {
	case "!!null":
		return nil, nil
	case "!!bool":
		switch strings.ToLower(n.Value) {
		case "true":
			return true, nil
		case "false":
			return false, nil
		}
		return nil, fmt.Errorf("无法识别的布尔值 %q", n.Value)
	case "!!int", "!!float":
		var value any
		if err := n.Decode(&value); err != nil {
			return nil, fmt.Errorf("无效的 YAML 数字 %q：%w", n.Value, err)
		}
		return value, nil
	case "!js", "tag:yaml.org,2002:js":
		return JsExpr{Expr: n.Value}, nil
	case "!!str", "!!timestamp":
		return n.Value, nil
	default:
		return nil, fmt.Errorf("不支持的 YAML 标签 %q", n.Tag)
	}
}

// dumpYAMLEntries 以 yaml.Node 手工排序键序后输出（js-yaml sortKeys 的
// 等价物：id、name、其余字母序、config 最后；嵌套映射键按字典序——
// Go map 无序，取确定序）。
func dumpYAMLEntries(entries []*loader.EntryOptions) (string, error) {
	if err := validateSerializable(entries, 0); err != nil {
		return "", err
	}
	root := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
	for _, e := range entries {
		root.Content = append(root.Content, entryToNode(e))
	}
	var b strings.Builder
	enc := yaml.NewEncoder(&b)
	enc.SetIndent(2)
	if err := enc.Encode(root); err != nil {
		return "", fmt.Errorf("无法序列化 YAML 配置：%w", err)
	}
	if err := enc.Close(); err != nil {
		return "", err
	}
	return b.String(), nil
}

// entryToNode 按 sortKeys 键序构建条目映射节点。
func entryToNode(e *loader.EntryOptions) *yaml.Node {
	m := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	if e == nil {
		return m
	}
	add := func(key string, val any) {
		m.Content = append(m.Content, stringNode(key), valueToNode(val))
	}
	if value, ok := loader.GetKey(e, "id"); ok {
		add("id", value)
	}
	if value, ok := loader.GetKey(e, "name"); ok {
		add("name", value)
	}
	var rest []string
	for _, key := range loader.KeysOf(e) {
		if key != "id" && key != "name" && key != "config" {
			rest = append(rest, key)
		}
	}
	sort.Strings(rest)
	for _, key := range rest {
		v, _ := loader.GetKey(e, key)
		add(key, v)
	}
	if value, ok := loader.GetKey(e, "config"); ok {
		add("config", value)
	}
	return m
}

func stringNode(s string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: s}
}

// valueToNode 把任意配置值转为 yaml 节点（*EntryOptions 列表递归为条目
// 映射；JsExpr 原样写回 !js 标签）。
func valueToNode(v any) *yaml.Node {
	switch t := v.(type) {
	case nil:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!null", Value: "null"}
	case bool:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: strconv.FormatBool(t)}
	case string:
		return stringNode(t)
	case int:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.Itoa(t)}
	case int8:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.FormatInt(int64(t), 10)}
	case int16:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.FormatInt(int64(t), 10)}
	case int32:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.FormatInt(int64(t), 10)}
	case int64:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.FormatInt(t, 10)}
	case uint:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.FormatUint(uint64(t), 10)}
	case uint64:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.FormatUint(t, 10)}
	case float32:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!float", Value: strconv.FormatFloat(float64(t), 'g', -1, 64)}
	case float64:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!float", Value: strconv.FormatFloat(t, 'g', -1, 64)}
	case Config:
		return valueToNode(configToNative(t))
	case *loader.EntryOptions:
		return entryToNode(t)
	case JsExpr:
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!js", Value: t.Expr}
	case *bool:
		if t == nil {
			return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!null", Value: "null"}
		}
		return valueToNode(*t)
	case map[string]any:
		m := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		keys := make([]string, 0, len(t))
		for key := range t {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			m.Content = append(m.Content, stringNode(key), valueToNode(t[key]))
		}
		return m
	case []any:
		s := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
		for _, item := range t {
			s.Content = append(s.Content, valueToNode(item))
		}
		return s
	case []*loader.EntryOptions:
		s := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
		for _, item := range t {
			s.Content = append(s.Content, entryToNode(item))
		}
		return s
	case *[]*loader.EntryOptions:
		if t == nil {
			return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!null", Value: "null"}
		}
		return valueToNode(*t)
	default:
		rv := reflect.ValueOf(v)
		switch rv.Kind() {
		case reflect.Map:
			m := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
			keys := rv.MapKeys()
			sort.Slice(keys, func(i, j int) bool { return keys[i].String() < keys[j].String() })
			for _, key := range keys {
				m.Content = append(m.Content, stringNode(key.String()), valueToNode(rv.MapIndex(key).Interface()))
			}
			return m
		case reflect.Slice, reflect.Array:
			n := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
			for i := 0; i < rv.Len(); i++ {
				n.Content = append(n.Content, valueToNode(rv.Index(i).Interface()))
			}
			return n
		case reflect.Uint8, reflect.Uint16, reflect.Uint32:
			return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.FormatUint(rv.Uint(), 10)}
		}
		panic(fmt.Sprintf("未校验的序列化配置值：%T", v))
	}
}

// —— JSON 解析与写回 ——

// parseJSONDoc 解析 JSON 文档为原生值。
func parseJSONDoc(content []byte) (any, error) {
	var v any
	if err := json.Unmarshal(content, &v); err != nil {
		return nil, err
	}
	return v, nil
}

// dumpJSONEntries 以两空格缩进输出条目列表（JSON.stringify(data, null, 2)）。
func dumpJSONEntries(entries []*loader.EntryOptions) (string, error) {
	if err := validateSerializable(entries, 0); err != nil {
		return "", err
	}
	data, err := json.MarshalIndent(entriesToNative(entries), "", "  ")
	if err != nil {
		return "", fmt.Errorf("无法序列化 JSON 配置：%w", err)
	}
	return string(data), nil
}

// entriesToNative 把条目列表转为原生值（具名字段 + 其余键）。
func entriesToNative(entries []*loader.EntryOptions) []any {
	out := make([]any, 0, len(entries))
	for _, e := range entries {
		if e == nil {
			continue
		}
		m := map[string]any{}
		for _, key := range loader.KeysOf(e) {
			v, _ := loader.GetKey(e, key)
			switch t := v.(type) {
			case *bool:
				if t != nil {
					m[key] = *t
				}
			case []*loader.EntryOptions:
				m[key] = entriesToNative(t)
			case Config:
				m[key] = configToNative(t)
			default:
				m[key] = v
			}
		}
		out = append(out, m)
	}
	return out
}

// configToNative 把 Config 序列化为原生 map。TS 的 config 本就是普通对象
// （index.ts:298-303 直接 fiber.update(this.config)）；Go 的结构体形态须经
// 此逆序列化回写父条目——否则结构体落进 valueToNode 的兜底分支被
// fmt.Sprint 成字符串，写盘后条目 config 变成 string。
func configToNative(c Config) map[string]any {
	m := map[string]any{}
	for key, value := range c.Extras {
		m[key] = copyPlainValue(value)
	}
	if c.Path != "" {
		m["path"] = c.Path
	}
	if c.Initial != nil {
		m["initial"] = entriesToNative(c.Initial)
	}
	if len(c.Patches) > 0 {
		patches := make([]any, 0, len(c.Patches))
		for _, p := range c.Patches {
			patches = append(patches, patchToNative(p))
		}
		m["patches"] = patches
	}
	if c.EnableLogs != nil {
		m["enableLogs"] = *c.EnableLogs
	}
	return m
}

// patchToNative 把补丁序列化为原生 map（键集与 patchFromMap 对应：
// id/name/insert 加其余 override 键）。
func patchToNative(p PatchOptions) map[string]any {
	m := map[string]any{}
	if p.ID != nil && *p.ID != "" {
		m["id"] = *p.ID
	}
	if p.Name != nil && *p.Name != "" {
		m["name"] = *p.Name
	}
	if len(p.Insert) > 0 {
		m["insert"] = entriesToNative(p.Insert)
	}
	for _, key := range p.OverrideKeys() {
		v, _ := p.GetOverride(key)
		m[key] = v
	}
	return m
}

// validateSerializable 拒绝无法表达的值与循环结构，避免错误值被静默字符串化。
func validateSerializable(v any, depth int) error {
	if depth > 128 {
		return errors.New("配置嵌套过深或存在循环引用")
	}
	switch value := v.(type) {
	case nil, bool, string, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64, JsExpr, *bool:
		return nil
	case Config:
		return validateSerializable(configToNative(value), depth+1)
	case *loader.EntryOptions:
		if value == nil {
			return nil
		}
		for _, key := range loader.KeysOf(value) {
			item, _ := loader.GetKey(value, key)
			if err := validateSerializable(item, depth+1); err != nil {
				return fmt.Errorf("配置键 %s：%w", key, err)
			}
		}
		return nil
	case *[]*loader.EntryOptions:
		if value == nil {
			return nil
		}
		return validateSerializable(*value, depth+1)
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Map:
		if rv.Type().Key().Kind() != reflect.String {
			break
		}
		iter := rv.MapRange()
		for iter.Next() {
			if err := validateSerializable(iter.Value().Interface(), depth+1); err != nil {
				return err
			}
		}
		return nil
	case reflect.Slice, reflect.Array:
		for i := 0; i < rv.Len(); i++ {
			if err := validateSerializable(rv.Index(i).Interface(), depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	return fmt.Errorf("配置值不支持序列化：%T", v)
}

func cloneRecord(rec *JournalRecord) *JournalRecord {
	if rec == nil {
		return nil
	}
	out := *rec
	out.Parent = copyStrPtr(rec.Parent)
	out.Changes = make(map[string]any, len(rec.Changes))
	for key, value := range rec.Changes {
		out.Changes[key] = copyPlainValue(value)
	}
	return &out
}

func cloneConfigValue(value any) any {
	switch v := value.(type) {
	case Config:
		return cloneConfig(v)
	case *Config:
		if v == nil {
			return (*Config)(nil)
		}
		c := cloneConfig(*v)
		return &c
	}
	return loader.CloneOptions(&loader.EntryOptions{Config: value}).Config
}
