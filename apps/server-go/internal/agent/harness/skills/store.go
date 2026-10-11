package skills

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

type savedImport struct {
	ImportTask
	Input     ImportInput `json:"input"`
	Canonical string      `json:"canonical"`
}
type document struct {
	Version int           `json:"version"`
	Skills  []Skill       `json:"skills"`
	Imports []savedImport `json:"imports"`
}
type Store struct {
	mu               sync.Mutex
	configPath, root string
	options          Options
	doc              document
	closed           bool
	unavailable      bool
	cancel           map[string]context.CancelFunc
	wg               sync.WaitGroup
	slot             chan struct{}
	lock             *os.File
	write            func(string, document) (bool, error)
}

func Open(configPath, packageRoot string, options Options) (*Store, error) {
	defaults := DefaultLimits()
	if options.Limits == (Limits{}) {
		options.Limits = defaults
	}
	if options.Limits.PackageBytes <= 0 || options.Limits.PackageBytes > defaults.PackageBytes || options.Limits.ArchiveBytes <= 0 || options.Limits.ArchiveBytes > defaults.ArchiveBytes || options.Limits.Files <= 0 || options.Limits.Files > defaults.Files || options.Limits.Queue <= 0 || options.Limits.Queue > defaults.Queue || options.Limits.ImportHistory > defaults.ImportHistory || options.Limits.Timeout <= 0 || options.Limits.Timeout > defaults.Timeout {
		return nil, problem(400, "invalid-limits", "技能导入限额无效")
	}
	// 导入历史保留条数允许缺省（≤0 时取默认值），调用方沿用旧构造不必感知新字段。
	if options.Limits.ImportHistory <= 0 {
		options.Limits.ImportHistory = defaults.ImportHistory
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.Git == nil {
		options.Git = fetchGit
	}
	if !filepath.IsAbs(configPath) || !filepath.IsAbs(packageRoot) {
		return nil, problem(400, "invalid-path", "技能配置和包目录必须使用绝对路径")
	}
	for _, name := range []string{filepath.Dir(configPath), packageRoot, filepath.Join(packageRoot, ".staging"), filepath.Join(packageRoot, "packages")} {
		dir, err := openDirectory(name, true)
		if err != nil {
			return nil, err
		}
		dir.Close()
	}
	dir, err := openDirectory(filepath.Dir(configPath), false)
	if err != nil {
		return nil, err
	}
	fd, err := unix.Openat(int(dir.Fd()), filepath.Base(configPath)+".lock", unix.O_RDWR|unix.O_CREAT|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	dir.Close()
	if err != nil {
		return nil, storageError()
	}
	lock := os.NewFile(uintptr(fd), "skill-lock")
	if err = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		lock.Close()
		return nil, problem(503, "skill-store-busy", "技能存储已由其他进程持有")
	}
	s := &Store{configPath: configPath, root: packageRoot, options: options, doc: document{Version: 1, Skills: []Skill{}, Imports: []savedImport{}}, cancel: map[string]context.CancelFunc{}, slot: make(chan struct{}, 1), lock: lock, write: writeDocument}
	raw, err := readBounded(configPath, 16<<20)
	if err == nil {
		decoder := json.NewDecoder(strings.NewReader(string(raw)))
		decoder.DisallowUnknownFields()
		if err = decoder.Decode(&s.doc); err != nil || s.doc.Version != 1 {
			s.unlock()
			return nil, problem(503, "invalid-skill-config", "技能配置文件格式或版本无效")
		}
		var trailing any
		if err = decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
			s.unlock()
			return nil, problem(503, "invalid-skill-config", "技能配置文件包含多余内容")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		s.unlock()
		return nil, storageError()
	}
	if err = s.validateDocument(); err != nil {
		s.unlock()
		return nil, err
	}
	recovered := false
	for i := range s.doc.Imports {
		task := &s.doc.Imports[i]
		if task.State == StateQueued || task.State == StateRunning {
			task.State = StateInterrupted
			task.EndedAt = s.stamp()
			task.Error = &Failure{Code: "import-interrupted", Message: "技能导入因面板重启中断，请重新提交"}
			recovered = true
		}
	}
	if recovered {
		if _, err = s.write(configPath, s.doc); err != nil {
			s.unlock()
			return nil, err
		}
	}
	return s, nil
}
func (s *Store) validateDocument() error {
	seen := map[string]int{}
	for _, skill := range s.doc.Skills {
		if !skillIDPattern.MatchString(skill.ID) || skill.Revision != seen[skill.ID]+1 || !digestPattern.MatchString(skill.Digest) {
			return problem(503, "invalid-skill-config", "技能配置包含无效修订")
		}
		seen[skill.ID] = skill.Revision
	}
	requests := map[string]bool{}
	ids := map[string]bool{}
	for _, task := range s.doc.Imports {
		if !importIDPattern.MatchString(task.ID) || !requestPattern.MatchString(task.RequestID) || ids[task.ID] || requests[task.RequestID] {
			return problem(503, "invalid-skill-config", "技能导入记录无效")
		}
		ids[task.ID] = true
		requests[task.RequestID] = true
		switch task.State {
		case StateQueued, StateRunning, StateSucceeded, StateFailed, StateCancelled, StateInterrupted:
		default:
			return problem(503, "invalid-skill-config", "技能导入状态无效")
		}
	}
	return nil
}

var skillIDPattern = regexp.MustCompile(`^skill-[a-f0-9]{32}$`)
var importIDPattern = regexp.MustCompile(`^import-[a-f0-9]{32}$`)
var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var requestPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

func (s *Store) stamp() string { return s.options.Now().UTC().Format(time.RFC3339Nano) }
func clone[T any](value T) T {
	raw, _ := json.Marshal(value)
	var result T
	_ = json.Unmarshal(raw, &result)
	return result
}
func (s *Store) save(next document) error {
	// 每次落盘前先滚动收缩导入历史：写盘上限只拒绝增长，若历史只增不减，
	// 触顶后除删除外没有任何自助恢复入口，收缩必须先于写入成为常态。
	s.pruneImports(&next)
	committed, err := s.write(s.configPath, next)
	if committed {
		s.doc = next
		// 按落盘后的文档回收无引用包目录；单个删除失败不阻断落盘，下次保存重试。
		s.prunePackages(next)
	}
	if err != nil && !isCapacityRejection(err) {
		s.unavailable = true
	}
	return err
}

// packageGracePeriod 是包目录的无引用保护期：导入先把包改名落位、再持锁登记，
// 失败的导入也按设计留下无引用内容；保护期覆盖这两条无引用窗口，超期后由
// 下一次落盘回收。导入时限 5 分钟，一小时留足余量。
const packageGracePeriod = time.Hour

// prunePackages 删除不再被任何技能修订引用、且落位超过保护期的包目录。
// 内容按整体摘要共享，回收只以文档引用为准；仅处理符合摘要命名形状的目录，
// 目录不可读或单个删除失败都静默跳过，不阻断落盘。
func (s *Store) prunePackages(next document) {
	packagesRoot := filepath.Join(s.root, "packages")
	dir, err := openDirectory(packagesRoot, false)
	if err != nil {
		return
	}
	names, err := dir.Readdirnames(-1)
	dir.Close()
	if err != nil {
		return
	}
	referenced := make(map[string]bool, len(next.Skills))
	for _, skill := range next.Skills {
		referenced[skill.Digest] = true
	}
	deadline := s.options.Now().Add(-packageGracePeriod)
	for _, name := range names {
		if !digestPattern.MatchString(name) || referenced[name] {
			continue
		}
		info, err := os.Lstat(filepath.Join(packagesRoot, name))
		if err != nil || !info.IsDir() || info.ModTime().After(deadline) {
			continue
		}
		_ = os.RemoveAll(filepath.Join(packagesRoot, name))
	}
}

// pruneImports 按条数滚动保留导入记录：从最旧开始只淘汰已达终态的历史，
// queued/running 任务永不淘汰；超限而最旧记录未终态时暂缓收缩，待其终态后的下一次落盘继续。
func (s *Store) pruneImports(next *document) {
	for len(next.Imports) > s.options.Limits.ImportHistory {
		if next.Imports[0].State == StateQueued || next.Imports[0].State == StateRunning {
			return
		}
		next.Imports = next.Imports[1:]
	}
}

// isCapacityRejection 判定确定性的登记容量拒绝：该错误在写盘前产生，没有存储不确定性，
// 不应像存储故障那样把整个存储置为不可用，连只读操作也一并拒绝。
func isCapacityRejection(err error) bool {
	var known *Error
	return errors.As(err, &known) && known.Code == "skill-config-limit"
}
func (s *Store) check() error {
	if s.closed {
		return problem(503, "skill-store-closed", "技能存储已关闭")
	}
	if s.unavailable {
		return storageError()
	}
	return nil
}
func (s *Store) unlock() {
	if s.lock != nil {
		_ = unix.Flock(int(s.lock.Fd()), unix.LOCK_UN)
		_ = s.lock.Close()
		s.lock = nil
	}
}

func (s *Store) List() ([]Skill, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return nil, err
	}
	latest := map[string]Skill{}
	for _, item := range s.doc.Skills {
		latest[item.ID] = item
	}
	items := make([]Skill, 0, len(latest))
	for _, item := range latest {
		items = append(items, clone(item))
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Manifest.Name < items[j].Manifest.Name })
	return items, nil
}
func (s *Store) get(id string, revision int, allowDisabled bool) (Skill, error) {
	var latest *Skill
	for i := range s.doc.Skills {
		if s.doc.Skills[i].ID == id {
			latest = &s.doc.Skills[i]
		}
	}
	if latest == nil {
		return Skill{}, problem(404, "skill-not-found", "技能不存在")
	}
	if !allowDisabled && !latest.Enabled {
		return Skill{}, problem(409, "skill-disabled", "技能已停用")
	}
	if revision == 0 {
		return clone(*latest), nil
	}
	for _, item := range s.doc.Skills {
		if item.ID == id && item.Revision == revision {
			return clone(item), nil
		}
	}
	return Skill{}, problem(404, "skill-revision-not-found", "技能修订不存在")
}
func (s *Store) Get(id string, revision int, allowDisabled bool) (Skill, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return Skill{}, err
	}
	return s.get(id, revision, allowDisabled)
}
func (s *Store) SetEnabled(id string, expectedRevision int, enabled bool) (Skill, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return Skill{}, err
	}
	item, err := s.get(id, 0, true)
	if err != nil {
		return item, err
	}
	if item.Revision != expectedRevision {
		return Skill{}, problem(409, "skill-revision-conflict", "技能修订已变化，请重新读取")
	}
	if item.Enabled == enabled {
		return item, nil
	}
	item.Revision++
	item.Enabled = enabled
	item.CreatedAt = s.stamp()
	next := clone(s.doc)
	next.Skills = append(next.Skills, item)
	if err = s.save(next); err != nil {
		return Skill{}, err
	}
	return clone(item), nil
}

// Delete 永久删除一个技能的全部修订登记（按最新修订做 CAS）。
// 这是登记容量触顶后的板内自助恢复入口：删除产出的是更小的登记文件，
// 因此在写盘上限拒绝增长之后仍可落盘。已把该技能固定进环境的会话在派发读取时
// 会得到 skill-not-found，等价于最强形式的永久撤销。
// 包目录按内容摘要共享去重且可能与进行中的导入竞争，本入口不删除磁盘上的包内容。
func (s *Store) Delete(id string, expectedRevision int) (Skill, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return Skill{}, err
	}
	item, err := s.get(id, 0, true)
	if err != nil {
		return item, err
	}
	if item.Revision != expectedRevision {
		return Skill{}, problem(409, "skill-revision-conflict", "技能修订已变化，请重新读取")
	}
	next := clone(s.doc)
	remaining := make([]Skill, 0, len(next.Skills))
	for _, entry := range next.Skills {
		if entry.ID != id {
			remaining = append(remaining, entry)
		}
	}
	next.Skills = remaining
	if err = s.save(next); err != nil {
		return Skill{}, err
	}
	return clone(item), nil
}
func (s *Store) ReadFile(ctx context.Context, id string, revision int, name string, maxBytes int64) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	name, err := cleanRelative(name)
	if err != nil {
		return nil, err
	}
	if maxBytes <= 0 || maxBytes > s.options.Limits.PackageBytes {
		return nil, problem(400, "invalid-limit", "技能读取限额无效")
	}
	skill, err := s.Get(id, revision, true)
	if err != nil {
		return nil, err
	}
	var file *File
	for i := range skill.Files {
		if skill.Files[i].Path == name {
			file = &skill.Files[i]
			break
		}
	}
	if file == nil {
		return nil, problem(404, "skill-file-not-found", "技能文件不存在")
	}
	if file.Size > maxBytes {
		return nil, problem(413, "skill-size-limit", "技能文件超过读取限额")
	}
	raw, err := readBounded(filepath.Join(s.root, "packages", skill.Digest, filepath.FromSlash(name)), maxBytes)
	if err != nil {
		return nil, storageError()
	}
	hash := sha256.Sum256(raw)
	if hex.EncodeToString(hash[:]) != file.Digest {
		return nil, problem(503, "skill-content-changed", "技能包内容与不可变修订不一致")
	}
	return raw, nil
}
func (s *Store) GetImport(id string) (ImportTask, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return ImportTask{}, err
	}
	for _, task := range s.doc.Imports {
		if task.ID == id {
			return clone(task.ImportTask), nil
		}
	}
	return ImportTask{}, problem(404, "import-not-found", "技能导入任务不存在")
}
func (s *Store) ListImports(cursor string, limit int) (ImportPage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	page := ImportPage{Items: []ImportTask{}}
	if err := s.check(); err != nil {
		return page, err
	}
	if limit == 0 {
		limit = 50
	}
	if limit < 1 || limit > 200 {
		return page, problem(400, "invalid-limit", "技能导入分页大小无效")
	}
	offset := 0
	var err error
	if cursor != "" {
		offset, err = strconv.Atoi(cursor)
		if err != nil || offset < 0 || offset > len(s.doc.Imports) {
			return page, problem(400, "invalid-cursor", "技能导入分页游标无效")
		}
	}
	for i := len(s.doc.Imports) - 1 - offset; i >= 0; i-- {
		if len(page.Items) == limit {
			page.HasMore = true
			page.NextCursor = strconv.Itoa(offset + limit)
			break
		}
		page.Items = append(page.Items, clone(s.doc.Imports[i].ImportTask))
	}
	return page, nil
}
func (s *Store) CancelImport(id string) (ImportTask, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return ImportTask{}, err
	}
	next := clone(s.doc)
	for i := range next.Imports {
		task := &next.Imports[i]
		if task.ID != id {
			continue
		}
		if task.State != StateQueued && task.State != StateRunning {
			return clone(task.ImportTask), nil
		}
		if task.CancelRequestedAt == "" {
			task.CancelRequestedAt = s.stamp()
			if task.State == StateQueued {
				task.State = StateCancelled
				task.EndedAt = s.stamp()
			}
			if err := s.save(next); err != nil {
				return ImportTask{}, err
			}
		}
		if cancel := s.cancel[id]; cancel != nil {
			cancel()
		}
		return clone(task.ImportTask), nil
	}
	return ImportTask{}, problem(404, "import-not-found", "技能导入任务不存在")
}

// DeleteImport 删除一条已达终态的导入记录，给管理员提供收缩登记的直接清理入口；
// queued/running 任务不可删除。记录删除后，同一 requestId 重放会开始新导入而非幂等回读。
func (s *Store) DeleteImport(id string) (ImportTask, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return ImportTask{}, err
	}
	next := clone(s.doc)
	for i := range next.Imports {
		task := next.Imports[i]
		if task.ID != id {
			continue
		}
		if task.State == StateQueued || task.State == StateRunning {
			return ImportTask{}, problem(409, "import-not-finished", "导入任务尚未结束，不能删除记录")
		}
		next.Imports = append(next.Imports[:i], next.Imports[i+1:]...)
		if err := s.save(next); err != nil {
			return ImportTask{}, err
		}
		return clone(task.ImportTask), nil
	}
	return ImportTask{}, problem(404, "import-not-found", "技能导入任务不存在")
}
func (s *Store) Close(ctx context.Context) error {
	s.mu.Lock()
	if !s.closed {
		s.closed = true
		for _, cancel := range s.cancel {
			cancel()
		}
	}
	s.mu.Unlock()
	done := make(chan struct{})
	go func() { s.wg.Wait(); close(done) }()
	select {
	case <-done:
		s.mu.Lock()
		defer s.mu.Unlock()
		s.unlock()
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Store) StartImport(ctx context.Context, input ImportInput, zipReader io.Reader) (ImportTask, bool, error) {
	if err := validateInput(input); err != nil {
		return ImportTask{}, false, err
	}
	if err := ctx.Err(); err != nil {
		return ImportTask{}, false, err
	}
	id := randomID("import-")
	stage := filepath.Join(s.root, ".staging", id)
	dir, err := openDirectory(stage, true)
	if err != nil {
		return ImportTask{}, false, err
	}
	dir.Close()
	keep := false
	defer func() {
		if !keep {
			_ = os.RemoveAll(stage)
		}
	}()
	zipDigest := ""
	if input.Source.Kind == "zip" {
		if zipReader == nil {
			return ImportTask{}, false, problem(400, "missing-zip", "ZIP 导入必须提供上传内容")
		}
		f, e := createRegular(filepath.Join(stage, "source.zip"))
		if e != nil {
			return ImportTask{}, false, e
		}
		hash := sha256.New()
		n, e := io.Copy(io.MultiWriter(f, hash), io.LimitReader(contextReader{ctx, zipReader}, s.options.Limits.ArchiveBytes+1))
		if e == nil {
			e = f.Sync()
		}
		closeErr := f.Close()
		if e != nil || closeErr != nil {
			return ImportTask{}, false, problem(400, "zip-upload-failed", "技能 ZIP 上传未完成")
		}
		if n > s.options.Limits.ArchiveBytes {
			return ImportTask{}, false, problem(413, "skill-size-limit", "技能 ZIP 上传超过容量限额")
		}
		zipDigest = hex.EncodeToString(hash.Sum(nil))
	} else if zipReader != nil {
		return ImportTask{}, false, problem(400, "unexpected-zip", "该导入类型不接受 ZIP 上传")
	}
	credential := input.Credential
	input.Credential = ""
	raw, _ := json.Marshal(struct {
		Input ImportInput `json:"input"`
		ZIP   string      `json:"zipDigest,omitempty"`
	}{input, zipDigest})
	canonical := string(raw)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err = s.check(); err != nil {
		return ImportTask{}, false, err
	}
	active := 0
	for _, task := range s.doc.Imports {
		if task.RequestID == input.RequestID {
			if task.Canonical != canonical {
				return ImportTask{}, false, problem(409, "request-conflict", "该请求标识已用于不同的技能导入")
			}
			return clone(task.ImportTask), true, nil
		}
		if task.State == StateQueued || task.State == StateRunning {
			active++
		}
	}
	if active >= s.options.Limits.Queue {
		return ImportTask{}, false, problem(429, "import-queue-full", "技能导入队列已满")
	}
	if input.SkillID != "" {
		item, e := s.get(input.SkillID, 0, true)
		if e != nil {
			return ImportTask{}, false, e
		}
		if item.Revision != input.ExpectedRevision {
			return ImportTask{}, false, problem(409, "skill-revision-conflict", "技能修订已变化，请重新读取")
		}
	}
	task := ImportTask{ID: id, RequestID: input.RequestID, State: StateQueued, Source: input.Source, CreatedAt: s.stamp(), SkillID: input.SkillID}
	next := clone(s.doc)
	next.Imports = append(next.Imports, savedImport{ImportTask: task, Input: input, Canonical: canonical})
	if err = s.save(next); err != nil {
		return ImportTask{}, false, err
	}
	jobCtx, cancel := context.WithTimeout(context.Background(), s.options.Limits.Timeout)
	s.cancel[id] = cancel
	s.wg.Add(1)
	keep = true
	go s.runImport(jobCtx, id, stage, credential)
	return clone(task), false, nil
}
