package containerapps

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"elysian/server/internal/config"
	"elysian/server/internal/paths"
	"elysian/server/internal/shared"
)

// registryFileName 登记表文件名，落在 ~/.Elysian/config/ 下，与 databases.json、
// websites.json 同一类别：登记表是面板自管事实，文件实体不是。
const registryFileName = "container-apps.json"

// maxDisplayNameLength 展示名长度上限。
const maxDisplayNameLength = 80

// displayNamePattern \u5c55\u793a\u540d\uff1a\u4e2d\u82f1\u6587\u3001\u6570\u5b57\u3001\u7a7a\u683c\u3001\u70b9\u3001\u4e0b\u5212\u7ebf\u4e0e\u8fde\u5b57\u7b26\uff0c\u9996\u5b57\u7b26\u4e0d\u5f97\u662f\u5206\u9694\u7b26\u3002
// Go \u7684 regexp \u662f RE2\uff0c\u7801\u70b9\u5199 `\x{...}` \u800c\u4e0d\u662f `\u...`\u3002
var displayNamePattern = regexp.MustCompile(`^[A-Za-z0-9\x{4e00}-\x{9fa5}][A-Za-z0-9\x{4e00}-\x{9fa5} ._-]{0,79}$`)

// Record 一个工作区的登记事实。文件清单**不入登记表**：文件真相只有磁盘一处，
// 列目录时现扫，避免清单与实际内容漂移成两份互相矛盾的事实。
type Record struct {
	Slug        string `json:"slug"`
	DisplayName string `json:"displayName"`
	CreatedAt   string `json:"createdAt"`
	Directory   string `json:"directory"`
}

// Registry 工作区登记表：内存互斥 + 原子写文件。
type Registry struct {
	// MountRoot 是绑定挂载根，工作区实体目录挂在它下面（与 docker 域同源取值）。
	MountRoot string
	// RegistryPath 覆盖登记表文件路径；测试用。
	RegistryPath string

	mu             sync.Mutex
	workspaceLocks sync.Map
}

// LockWorkspace serializes HTTP edits, Agent edits, deletion and build submission.
func (r *Registry) LockWorkspace(ctx context.Context, slug string) (func(), error) {
	if err := ValidateSlug(slug); err != nil {
		return nil, err
	}
	value, _ := r.workspaceLocks.LoadOrStore(slug, make(chan struct{}, 1))
	gate := value.(chan struct{})
	select {
	case gate <- struct{}{}:
		var once sync.Once
		return func() { once.Do(func() { <-gate }) }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// registryPath 解析登记表位置。
func (r *Registry) registryPath() string {
	if r.RegistryPath != "" {
		return r.RegistryPath
	}
	return filepath.Join(paths.ConfigDir, registryFileName)
}

// rootDir 建出工作区根目录（0700：里面是运维者自己放的配置，不给同机其他账号读）。
func (r *Registry) rootDir() string { return WorkspaceRoot(r.MountRoot) }

// ensureRoot 创建工作区根目录。
func (r *Registry) ensureRoot() error {
	return os.MkdirAll(r.rootDir(), 0700)
}

// load 读登记表；文件不存在视作空表（首次使用），但**内容损坏一律整体失败**，
// 不静默当成空表——那会让用户以为自己的工作区被删了。
func (r *Registry) load() ([]Record, error) {
	b, err := os.ReadFile(r.registryPath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []Record{}, nil
		}
		return nil, err
	}
	var records []Record
	if err = json.Unmarshal(b, &records); err != nil {
		return nil, fmt.Errorf("容器工作区登记表损坏，请在服务器上检查 %s", r.registryPath())
	}
	for i, record := range records {
		if err = ValidateSlug(record.Slug); err != nil {
			return nil, fmt.Errorf("容器工作区登记表第 %d 条记录的标识无效", i+1)
		}
		if record.Directory == "" || record.CreatedAt == "" {
			return nil, fmt.Errorf("容器工作区登记表第 %d 条记录缺少必要字段", i+1)
		}
	}
	sort.SliceStable(records, func(i, j int) bool { return records[i].Slug < records[j].Slug })
	return records, nil
}

// save 原子写登记表。
func (r *Registry) save(records []Record) error {
	if records == nil {
		records = []Record{}
	}
	return config.AtomicJSON(r.registryPath(), records)
}

// List 列出全部工作区，按标识排序。
func (r *Registry) List() ([]Record, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.load()
}

// Create 新建工作区：校验标识、拒绝重名、建目录、追加登记。
// 输入不合法一律 shared.InvalidRequest（400），不落到 500 服务端故障。
func (r *Registry) Create(slug, displayName string, now time.Time) (Record, error) {
	if err := ValidateSlug(slug); err != nil {
		return Record{}, shared.InvalidRequest(err.Error())
	}
	if strings.TrimSpace(displayName) == "" {
		displayName = slug
	}
	if len(displayName) > maxDisplayNameLength {
		return Record{}, shared.InvalidRequest(fmt.Sprintf("工作区展示名不得超过 %d 个字符", maxDisplayNameLength))
	}
	if !displayNamePattern.MatchString(displayName) {
		return Record{}, shared.InvalidRequest("工作区展示名包含不允许的字符")
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	records, err := r.load()
	if err != nil {
		return Record{}, err
	}
	for _, existing := range records {
		if existing.Slug == slug {
			return Record{}, &AlreadyExistsError{Slug: slug}
		}
	}
	if err = r.ensureRoot(); err != nil {
		return Record{}, err
	}
	dir := WorkspaceDir(r.MountRoot, slug)
	// 目录已存在但登记表里没有记录时不接管：那批文件的来历不明，静默收编等于
	// 把别人的目录当成面板工作区删掉。让用户先自己在宿主上处理。
	// 这是请求与磁盘现状冲突，回 409 而不是 500 服务端故障。
	if _, statErr := os.Stat(dir); statErr == nil {
		return Record{}, &shared.InvalidRequestError{
			Status:  http.StatusConflict,
			Message: fmt.Sprintf("目录 %s 已存在但不属于面板工作区，请先在服务器上确认它再新建同名工作区", dir),
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return Record{}, statErr
	}
	if err = os.Mkdir(dir, 0700); err != nil {
		return Record{}, err
	}
	record := Record{Slug: slug, DisplayName: displayName, CreatedAt: now.UTC().Format(time.RFC3339), Directory: dir}
	records = append(records, record)
	if err = r.save(records); err != nil {
		// 登记失败就把刚建的空目录撤掉，不留无人认领的目录。
		_ = os.Remove(dir)
		return Record{}, err
	}
	return record, nil
}

// lookup 取单条记录。
func (r *Registry) lookup(slug string) (Record, error) {
	records, err := r.load()
	if err != nil {
		return Record{}, err
	}
	for _, record := range records {
		if record.Slug == slug {
			return record, nil
		}
	}
	return Record{}, &NotFoundError{Slug: slug}
}

// Lookup 按标识取工作区。
func (r *Registry) Lookup(slug string) (Record, error) {
	if err := ValidateSlug(slug); err != nil {
		return Record{}, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.lookup(slug)
}

// Delete 删除工作区：连目录一起删。调用方必须已经向用户逐字展示过将被删除的绝对路径
// 并取得二次确认——这里不做任何回收站或保留。
func (r *Registry) Delete(slug string) error {
	if err := ValidateSlug(slug); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	records, err := r.load()
	if err != nil {
		return err
	}
	index := -1
	for i, candidate := range records {
		if candidate.Slug == slug {
			index = i
			break
		}
	}
	if index < 0 {
		return &NotFoundError{Slug: slug}
	}
	// 只删算出来的工作区目录，且必须仍在工作区根之下——RemoveAll 是不可逆动作，
	// 这里宁可多一道断言。
	dir := WorkspaceDir(r.MountRoot, slug)
	root := WorkspaceRoot(r.MountRoot)
	if dir == root || !strings.HasPrefix(dir, root+string(os.PathSeparator)) {
		return fmt.Errorf("工作区目录超出范围，拒绝删除")
	}
	if err = os.RemoveAll(dir); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	records = append(records[:index], records[index+1:]...)
	return r.save(records)
}

// Directory 供路由层解析某工作区的绝对目录（含存在性校验）。
func (r *Registry) Directory(slug string) (string, error) {
	record, err := r.Lookup(slug)
	if err != nil {
		return "", err
	}
	dir := WorkspaceDir(r.MountRoot, record.Slug)
	info, err := os.Stat(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", &NotFoundError{Slug: slug}
		}
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("工作区路径不是目录")
	}
	return dir, nil
}

// NotFoundError 工作区不存在；路由映射 404。
type NotFoundError struct{ Slug string }

// Error 实现 error；消息是 API 契约（中文，逐字）。
func (e *NotFoundError) Error() string { return "容器工作区不存在：" + e.Slug }

// AlreadyExistsError 标识已被占用；路由映射 409。
type AlreadyExistsError struct{ Slug string }

// Error 实现 error；消息是 API 契约（中文，逐字）。
func (e *AlreadyExistsError) Error() string {
	return "工作区名称已存在，请换一个：" + e.Slug
}
