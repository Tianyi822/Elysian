package logs

import (
	"fmt"
	"os"
	"sync"
	"time"

	"elysian/server/internal/paths"
	"elysian/server/internal/seam"
)

/*
 * 日志服务的编排层（logsService.ts 等价物）：列表、清空留痕、写运行/登录/操作日志、
 * 巡检（per-category 维护锁 + 在途合并 + 惰性定时器）。
 *
 * Service 实现 seam.Logs（Runtime/RecordOperation）与域内完整接口 ServiceAPI；
 * RecordOperation 含运行日志镜像（`操作：<action>（成功|失败）`），与 TS recordPanelOperation
 * 的两段落盘同构，审计中间件与 WS 升级显式出口共用。
 */

// logSweepInterval 巡检定时器间隔：每 5 分钟一次。
const logSweepInterval = 5 * time.Minute

// sweepReason 巡检触发原因（after-clear 不写巡检摘要行）。
type sweepReason string

const (
	sweepReasonAfterClear sweepReason = "after-clear"
	sweepReasonTimer      sweepReason = "timer"
	sweepReasonManual     sweepReason = "manual"
	sweepReasonFirstWrite sweepReason = "first-write"
	sweepReasonAfterRoll  sweepReason = "after-roll"
)

// sweepResult service 层巡检结果（含完成时刻）。
type sweepResult struct {
	deletedByAge  int
	deletedBySize int
	freedBytes    int64
	totalBytes    int64
	trimmedBySize bool
	failed        int
	at            string
}

// LoginRecord 登录日志写入入参（审计中间件 → 服务）。
type LoginRecord struct {
	IP        string
	UserAgent string
	Status    string
}

// ServiceAPI 路由与审计中间件需要的完整服务接口（seam.Logs 的域内扩口）。
type ServiceAPI interface {
	seam.Logs
	RuntimeLog(query logListQuery) (RuntimeLogListReport, error)
	OperationLog(query operationLogListQuery) (OperationLogListReport, error)
	LoginLog(query loginLogListQuery) (LoginLogListReport, error)
	Clear(category string) (LogClearReport, error)
	RecordLogin(input LoginRecord)
	RunSweep(category string, reason sweepReason) sweepResult
}

// sweepStateEntry 进程内某类别最近一次巡检状态（内存态、不落盘）。
type sweepStateEntry struct {
	lastSweepAt   *string
	trimmedBySize bool
}

// sweepCall 在途巡检（同类别并发合并为同一结果）。
type sweepCall struct {
	done   chan struct{}
	result sweepResult
}

// Service 编排层服务。
type Service struct {
	store      logStore
	now        func() time.Time
	startTimer func(onTick func(), interval time.Duration)

	stateMu     sync.Mutex
	sweepState  map[string]sweepStateEntry
	pending     map[string]*sweepCall
	timerFired  map[string]bool
	maintenance map[string]*sync.Mutex
}

// NewService 构造服务；now 为 nil 用 time.Now，startTimer 为 nil 用默认 ticker。
func NewService(store logStore, now func() time.Time, startTimer func(onTick func(), interval time.Duration)) *Service {
	if now == nil {
		now = time.Now
	}
	if startTimer == nil {
		startTimer = defaultStartTimer
	}
	categories := []string{categoryRuntime, categoryOperation, categoryLogin}
	svc := &Service{
		store:       store,
		now:         now,
		startTimer:  startTimer,
		sweepState:  map[string]sweepStateEntry{},
		pending:     map[string]*sweepCall{},
		timerFired:  map[string]bool{},
		maintenance: map[string]*sync.Mutex{},
	}
	for _, category := range categories {
		svc.sweepState[category] = sweepStateEntry{}
		svc.maintenance[category] = &sync.Mutex{}
	}
	return svc
}

// defaultStartTimer 惰性注册的巡检定时器：goroutine + ticker，不阻塞进程退出
// （TS setInterval + unref 的 Go 对应物）。
func defaultStartTimer(onTick func(), interval time.Duration) {
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for range ticker.C {
			onTick()
		}
	}()
}

// storage 类别维度的存储统计（sweep 字段取该类别进程内状态）。
func (s *Service) storage(category string) LogStorageStats {
	s.stateMu.Lock()
	state := s.sweepState[category]
	s.stateMu.Unlock()
	return s.store.Storage(state.lastSweepAt, state.trimmedBySize)
}

// Log 写一条运行日志（seam.Logs.Runtime 的域内名）。
func (s *Service) Log(level, source, message string) {
	s.store.InsertRuntime(runtimeInsert{
		At:      isoTime(s.now()),
		Level:   level,
		Source:  source,
		Message: message,
	})
}

// Runtime seam.Logs：写一条运行日志。
func (s *Service) Runtime(level, source, message string) {
	s.Log(level, source, message)
}

// RecordOperation seam.Logs：写操作日志 + 运行日志镜像；内部失败只进 stderr。
// seam 的 Method/Path 是裸 string（空串表缺省），入库转为 NULL。
func (s *Service) RecordOperation(rec seam.OperationRecord) {
	var method *string
	if rec.Method != "" {
		method = &rec.Method
	}
	var path *string
	if rec.Path != "" {
		path = &rec.Path
	}
	var httpStatus *int64
	if rec.HTTPStatus != nil {
		status := int64(*rec.HTTPStatus)
		httpStatus = &status
	}
	safeWrite(func() {
		s.store.InsertOperation(operationInsert{
			At:         isoTime(s.now()),
			Category:   rec.Category,
			Action:     rec.Action,
			Target:     rec.Target,
			Summary:    derefString(rec.Summary, ""),
			Result:     rec.Result,
			Method:     method,
			Path:       path,
			HTTPStatus: httpStatus,
		})
	})
	safeWrite(func() {
		level := "info"
		outcome := "成功"
		if rec.Result != "success" {
			level = "warning"
			outcome = "失败"
		}
		s.store.InsertRuntime(runtimeInsert{
			At:      isoTime(s.now()),
			Level:   level,
			Source:  operationLogSource,
			Message: fmt.Sprintf("操作：%s（%s）", rec.Action, outcome),
		})
	})
}

// RecordLogin 写登录日志：ip 归一、归属地推导、UA 单行化（空 → 未知）。
func (s *Service) RecordLogin(input LoginRecord) {
	ip := NormalizePeerAddress(input.IP)
	userAgent := NormalizeSingleLine(input.UserAgent, logUserAgentMaxLen)
	if userAgent == "" {
		userAgent = unknownAddress
	}
	s.store.InsertLogin(loginInsert{
		At:        isoTime(s.now()),
		IP:        ip,
		Location:  LoginLocationOf(ip),
		UserAgent: userAgent,
		Status:    input.Status,
	})
}

// logSweepResult 写巡检摘要运行日志（after-clear 一概不写）。
func (s *Service) logSweepResult(category string, reason sweepReason, result sweepResult) {
	if reason == sweepReasonAfterClear {
		return
	}
	deleted := result.deletedByAge + result.deletedBySize
	level := "info"
	if deleted > 0 || result.failed > 0 {
		level = "warning"
	}
	s.Log(level, "logs.retention",
		fmt.Sprintf("保留巡检完成：删除 %d、释放 %s", deleted, FormatLogBytes(result.freedBytes)))
	if result.failed > 0 {
		s.Log("warning", "logs.retention",
			fmt.Sprintf("保留巡检有 %d 项失败（详见服务端 stderr 与目录权限）", result.failed))
	}
	policy := retentionPolicyOf(category)
	if result.totalBytes > policy.maxTotalBytes {
		s.Log("warning", "logs.retention",
			fmt.Sprintf(
				"%s仍超出总量上限：当前 %s、上限 %s（只剩活动分片或静默窗口内的文件，已停止删除）",
				sweepCategoryLabel(category), FormatLogBytes(result.totalBytes), FormatLogBytes(policy.maxTotalBytes),
			))
	}
}

// sweepLocked 持类别维护锁执行一次巡检：更新内存 sweepState，再按 reason 写摘要。
func (s *Service) sweepLocked(category string, reason sweepReason) sweepResult {
	raw := s.store.Sweep(category, s.now())
	at := isoTime(s.now())
	result := sweepResult{
		deletedByAge:  raw.DeletedByAge,
		deletedBySize: raw.DeletedBySize,
		freedBytes:    raw.FreedBytes,
		totalBytes:    raw.TotalBytes,
		trimmedBySize: raw.TrimmedBySize,
		failed:        raw.Failed,
		at:            at,
	}
	s.stateMu.Lock()
	s.sweepState[category] = sweepStateEntry{lastSweepAt: &at, trimmedBySize: result.trimmedBySize}
	s.stateMu.Unlock()
	s.logSweepResult(category, reason, result)
	return result
}

// RunSweep 触发巡检：同类别在途直接复用同一结果；定时器每类别只在第一次触发时注册。
// （生产现状：除 clear 内部的 after-clear 外无调用方，定时器因此不会启动——照抄 TS 行为。）
func (s *Service) RunSweep(category string, reason sweepReason) sweepResult {
	s.stateMu.Lock()
	if call := s.pending[category]; call != nil {
		s.stateMu.Unlock()
		<-call.done
		return call.result
	}
	call := &sweepCall{done: make(chan struct{})}
	s.pending[category] = call
	if !s.timerFired[category] {
		s.timerFired[category] = true
		interval := logSweepInterval
		s.startTimer(func() { s.RunSweep(category, sweepReasonTimer) }, interval)
	}
	s.stateMu.Unlock()

	s.maintenance[category].Lock()
	call.result = s.sweepLocked(category, reason)
	s.maintenance[category].Unlock()
	close(call.done)

	s.stateMu.Lock()
	if s.pending[category] == call {
		delete(s.pending, category)
	}
	s.stateMu.Unlock()
	return call.result
}

// Clear 清空单类别：删表 → 运行/操作双留痕 → after-clear 巡检（不写摘要行）。
// 清空失败（store 报错）时不写任何留痕，错误原样上抛（路由层映射 500）。
func (s *Service) Clear(category string) (LogClearReport, error) {
	s.maintenance[category].Lock()
	defer s.maintenance[category].Unlock()

	cleared, err := s.store.Clear(category)
	if err != nil {
		return LogClearReport{}, err
	}
	clearedAt := isoTime(s.now())
	text := fmt.Sprintf("删除 %d 条记录，释放 %s", cleared.RowCount, FormatLogBytes(cleared.TotalBytes))
	s.store.InsertRuntime(runtimeInsert{
		At:      clearedAt,
		Level:   "warning",
		Source:  "logs.clear",
		Message: fmt.Sprintf("%s已清空：%s", platformLogCategoryLabels[category], text),
	})
	action := "清空操作日志"
	if category == categoryRuntime {
		action = "清空运行日志"
	}
	s.store.InsertOperation(operationInsert{
		At:       clearedAt,
		Category: "logs",
		Action:   action,
		Summary:  text,
		Result:   "success",
	})
	s.sweepLocked(category, sweepReasonAfterClear)
	return LogClearReport{
		Category:   category,
		RowCount:   cleared.RowCount,
		TotalBytes: cleared.TotalBytes,
		OldestAt:   cleared.OldestAt,
		ClearedAt:  clearedAt,
	}, nil
}

// RuntimeLog 运行日志列表报告。
func (s *Service) RuntimeLog(query logListQuery) (RuntimeLogListReport, error) {
	page, err := s.store.QueryRuntime(query)
	if err != nil {
		return RuntimeLogListReport{}, err
	}
	if page.Entries == nil {
		page.Entries = []RuntimeLogEntry{}
	}
	return RuntimeLogListReport{
		Entries:      page.Entries,
		Total:        page.Total,
		Truncated:    page.Truncated,
		SkippedLines: 0,
		SkippedFiles: 0,
		Storage:      s.storage(categoryRuntime),
	}, nil
}

// LoginLog 登录日志列表报告（无 storage）。
func (s *Service) LoginLog(query loginLogListQuery) (LoginLogListReport, error) {
	page, err := s.store.QueryLogin(query)
	if err != nil {
		return LoginLogListReport{}, err
	}
	if page.Entries == nil {
		page.Entries = []LoginLogEntry{}
	}
	return LoginLogListReport{
		Entries:      page.Entries,
		Total:        page.Total,
		Truncated:    page.Truncated,
		SkippedLines: 0,
		SkippedFiles: 0,
	}, nil
}

// OperationLog 操作日志列表报告。
func (s *Service) OperationLog(query operationLogListQuery) (OperationLogListReport, error) {
	page, err := s.store.QueryOperation(query)
	if err != nil {
		return OperationLogListReport{}, err
	}
	if page.Entries == nil {
		page.Entries = []OperationLogEntry{}
	}
	return OperationLogListReport{
		Entries:      page.Entries,
		Total:        page.Total,
		Truncated:    page.Truncated,
		SkippedLines: 0,
		SkippedFiles: 0,
		Storage:      s.storage(categoryOperation),
	}, nil
}

// safeWrite 写日志失败只进 stderr，绝不影响业务调用方。
func safeWrite(task func()) {
	defer func() {
		if rec := recover(); rec != nil {
			fmt.Fprintf(os.Stderr, "Elysian 操作日志采集失败：%v\n", rec)
		}
	}()
	task()
}

// derefString 指针取值（缺省回退）。
func derefString(v *string, fallback string) string {
	if v == nil {
		return fallback
	}
	return *v
}

// OpenService 打开+建表+启动分片导入，产出服务（go-plan §3.8 冻结签名）。
// 打开或导入失败时内部降级为不可用实现（查询「日志数据库不可用」→ 500、写入只计
// failedWrites）并落 stderr 诊断，永不向装配返回错误——对齐 logsHostDeps 的降级语义。
func OpenService(dbPath string, now func() time.Time) seam.Logs {
	if now == nil {
		now = time.Now
	}
	var store logStore
	sqlStore, err := openLogStore(dbPath, nil)
	if err == nil {
		store = sqlStore
		ImportPlatformLogs(store, paths.Default.PlatformLogsDir)
	} else {
		fmt.Fprintf(os.Stderr, "Elysian 日志数据库不可用：%v\n", err)
		store = newUnavailableLogStore()
	}
	return NewService(store, now, nil)
}
