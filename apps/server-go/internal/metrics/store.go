package metrics

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	_ "modernc.org/sqlite" // 驱动注册：metrics.sqlite 两张采样表（纯 Go，无 CGO）
)

// 保留策略与时间窗常量（metricsStore.ts 等价物）：raw 存 5 秒原始点保 1 小时，
// 1m 存分钟均值保 7 天；窗长 ≤1 小时的查询走 raw，其余走 1m。
const (
	msPerMinute         = int64(60_000)
	msPerHour           = int64(3_600_000)
	msPerDay            = int64(86_400_000)
	rawRetentionMs      = msPerHour
	minuteRetentionMs   = 7 * msPerDay
	rawQueryMaxWindowMs = msPerHour
)

// samplesSchema 与 dev 侧 TS 建库逐字一致：存量 metrics.sqlite 直接续用。
const samplesSchema = `
CREATE TABLE IF NOT EXISTS samples_raw (
  ts INTEGER PRIMARY KEY,
  cpu REAL NOT NULL,
  memory REAL NOT NULL,
  network_io REAL NOT NULL,
  network_rx REAL NOT NULL DEFAULT 0,
  network_tx REAL NOT NULL DEFAULT 0,
  disk_io REAL NOT NULL,
  disk_read REAL NOT NULL DEFAULT 0,
  disk_write REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS samples_1m (
  ts INTEGER PRIMARY KEY,
  cpu REAL NOT NULL,
  memory REAL NOT NULL,
  network_io REAL NOT NULL,
  network_rx REAL NOT NULL DEFAULT 0,
  network_tx REAL NOT NULL DEFAULT 0,
  disk_io REAL NOT NULL,
  disk_read REAL NOT NULL DEFAULT 0,
  disk_write REAL NOT NULL DEFAULT 0
);`

// directionalColumns 老库（无方向列时期）迁移清单，同 TS ensureDirectionalColumns。
var directionalColumns = []string{"network_rx", "network_tx", "disk_read", "disk_write"}

// timeRangeDurationMs 合法 range → 窗长毫秒；非法返回 ok=false。
func timeRangeDurationMs(rangeKey string) (int64, bool) {
	switch rangeKey {
	case "5m":
		return 5 * msPerMinute, true
	case "30m":
		return 30 * msPerMinute, true
	case "1h":
		return msPerHour, true
	case "5h":
		return 5 * msPerHour, true
	case "7d":
		return 7 * msPerDay, true
	}
	return 0, false
}

// minuteStartMs 取所在分钟的起点。
func minuteStartMs(ts int64) int64 {
	return ts - ts%msPerMinute
}

// minuteBucket 分钟均值累加器：跨分钟时整桶写入 samples_1m。
type minuteBucket struct {
	minuteStart          int64
	count                int64
	cpu, memory          float64
	networkIo            float64
	networkRx, networkTx float64
	diskIo               float64
	diskRead, diskWrite  float64
}

// Store metrics.sqlite 访问层：单连接＋互斥（与 logs 域同一并发口径），
// 采样 goroutine 写入、HTTP 查询读取共用同一把锁。
type Store struct {
	db     *sql.DB
	mu     sync.Mutex
	bucket *minuteBucket
}

// OpenStore 打开（必要时创建）metrics.sqlite 并确保 schema；父目录 0700。
// 老库缺方向列时按 ALTER TABLE 补齐（幂等）。
func OpenStore(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("创建指标库目录失败：%w", err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("打开指标库失败：%w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxIdleTime(0)
	db.SetConnMaxLifetime(0)
	if _, err := db.Exec(samplesSchema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("初始化指标库 schema 失败：%w", err)
	}
	if err := ensureDirectionalColumns(db); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

// ensureDirectionalColumns 老库迁移：缺哪列补哪列（NOT NULL DEFAULT 0，幂等）。
func ensureDirectionalColumns(db *sql.DB) error {
	for _, table := range []string{"samples_raw", "samples_1m"} {
		rows, err := db.Query("SELECT name FROM pragma_table_info('" + table + "')")
		if err != nil {
			return fmt.Errorf("读取 %s 列清单失败：%w", table, err)
		}
		existing := map[string]bool{}
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				rows.Close()
				return fmt.Errorf("解析 %s 列清单失败：%w", table, err)
			}
			existing[name] = true
		}
		rows.Close()
		for _, column := range directionalColumns {
			if existing[column] {
				continue
			}
			if _, err := db.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s REAL NOT NULL DEFAULT 0", table, column)); err != nil {
				return fmt.Errorf("迁移 %s.%s 失败：%w", table, column, err)
			}
		}
	}
	return nil
}

// Close 关闭数据库连接。
func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

// InsertRaw 写一条 5 秒原始点（同时累进分钟桶）。
func (s *Store) InsertRaw(point SamplePoint) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.absorbIntoMinuteBucketLocked(point)
	_, _ = s.db.Exec(`INSERT OR REPLACE INTO samples_raw
		(ts, cpu, memory, network_io, network_rx, network_tx, disk_io, disk_read, disk_write)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		point.TS, point.CPU, point.Memory, point.NetworkIo, point.NetworkRx, point.NetworkTx, point.DiskIo, point.DiskRead, point.DiskWrite)
}

// absorbIntoMinuteBucketLocked 累进分钟桶；跨分钟先把旧桶均值写入 samples_1m。
func (s *Store) absorbIntoMinuteBucketLocked(point SamplePoint) {
	start := minuteStartMs(point.TS)
	if s.bucket != nil && s.bucket.minuteStart != start {
		s.flushMinuteBucketLocked()
	}
	if s.bucket == nil {
		s.bucket = &minuteBucket{minuteStart: start}
	}
	b := s.bucket
	b.count++
	b.cpu += point.CPU
	b.memory += point.Memory
	b.networkIo += point.NetworkIo
	b.networkRx += point.NetworkRx
	b.networkTx += point.NetworkTx
	b.diskIo += point.DiskIo
	b.diskRead += point.DiskRead
	b.diskWrite += point.DiskWrite
}

// flushMinuteBucketLocked 把当前分钟桶按均值写入 samples_1m 并清空。
func (s *Store) flushMinuteBucketLocked() {
	b := s.bucket
	if b == nil || b.count == 0 {
		return
	}
	n := float64(b.count)
	_, _ = s.db.Exec(`INSERT OR REPLACE INTO samples_1m
		(ts, cpu, memory, network_io, network_rx, network_tx, disk_io, disk_read, disk_write)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		b.minuteStart, b.cpu/n, b.memory/n, b.networkIo/n, b.networkRx/n, b.networkTx/n, b.diskIo/n, b.diskRead/n, b.diskWrite/n)
	s.bucket = nil
}

// RollupMinuteIfNeeded 当前分钟已翻页时把旧桶落进 samples_1m。
func (s *Store) RollupMinuteIfNeeded(nowMs int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.bucket != nil && s.bucket.minuteStart < minuteStartMs(nowMs) {
		s.flushMinuteBucketLocked()
	}
}

// Prune 按保留策略清过期行：raw 只保 1 小时、1m 只保 7 天。
func (s *Store) Prune(nowMs int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, _ = s.db.Exec("DELETE FROM samples_raw WHERE ts < ?", nowMs-rawRetentionMs)
	_, _ = s.db.Exec("DELETE FROM samples_1m WHERE ts < ?", nowMs-minuteRetentionMs)
}

// Query 按时间窗查询：窗长 ≤1 小时走 samples_raw 原始点，其余走 samples_1m；
// 1m 空窗时用 raw 按分钟均值兜底；ts 升序。
func (s *Store) Query(rangeKey string, nowMs int64) []SamplePoint {
	durationMs, ok := timeRangeDurationMs(rangeKey)
	if !ok {
		return []SamplePoint{}
	}
	windowStart := nowMs - durationMs
	s.mu.Lock()
	defer s.mu.Unlock()
	if durationMs <= rawQueryMaxWindowMs {
		return s.selectSamples("samples_raw", windowStart, nowMs)
	}
	fromMinute := s.selectSamples("samples_1m", windowStart, nowMs)
	if len(fromMinute) > 0 {
		return fromMinute
	}
	return s.downsampleRawByMinute(windowStart, nowMs)
}

// selectSamples 取窗口内的整行（ts 升序）。
func (s *Store) selectSamples(table string, windowStart, nowMs int64) []SamplePoint {
	rows, err := s.db.Query(`SELECT ts, cpu, memory, network_io, network_rx, network_tx, disk_io, disk_read, disk_write
		FROM `+table+` WHERE ts >= ? AND ts <= ? ORDER BY ts ASC`, windowStart, nowMs)
	if err != nil {
		return []SamplePoint{}
	}
	defer rows.Close()
	points := []SamplePoint{}
	for rows.Next() {
		point, err := scanSamplePoint(rows)
		if err != nil {
			return []SamplePoint{}
		}
		points = append(points, point)
	}
	return points
}

// scanSamplePoint 把一行九列扫成采样点。
func scanSamplePoint(rows *sql.Rows) (SamplePoint, error) {
	var point SamplePoint
	err := rows.Scan(&point.TS, &point.CPU, &point.Memory, &point.NetworkIo, &point.NetworkRx, &point.NetworkTx, &point.DiskIo, &point.DiskRead, &point.DiskWrite)
	return point, err
}

// downsampleRawByMinute 1m 空窗兜底：raw 窗口内按分钟分组求均值（ts=分钟起点）。
func (s *Store) downsampleRawByMinute(windowStart, nowMs int64) []SamplePoint {
	raw := s.selectSamples("samples_raw", windowStart, nowMs)
	byMinute := map[int64]*sampleAccumulator{}
	order := []int64{}
	for _, point := range raw {
		key := minuteStartMs(point.TS)
		acc, exists := byMinute[key]
		if !exists {
			acc = &sampleAccumulator{}
			byMinute[key] = acc
			order = append(order, key)
		}
		acc.add(point)
	}
	points := []SamplePoint{}
	for _, key := range order {
		points = append(points, byMinute[key].average(key))
	}
	return points
}

// sampleAccumulator 分钟均值累加器（查询兜底专用，与写入侧分钟桶同口径）。
type sampleAccumulator struct {
	count                int64
	cpu, memory          float64
	networkIo            float64
	networkRx, networkTx float64
	diskIo               float64
	diskRead, diskWrite  float64
}

func (a *sampleAccumulator) add(point SamplePoint) {
	a.count++
	a.cpu += point.CPU
	a.memory += point.Memory
	a.networkIo += point.NetworkIo
	a.networkRx += point.NetworkRx
	a.networkTx += point.NetworkTx
	a.diskIo += point.DiskIo
	a.diskRead += point.DiskRead
	a.diskWrite += point.DiskWrite
}

func (a *sampleAccumulator) average(ts int64) SamplePoint {
	n := float64(a.count)
	return SamplePoint{
		TS:        ts,
		CPU:       a.cpu / n,
		Memory:    a.memory / n,
		NetworkIo: a.networkIo / n,
		NetworkRx: a.networkRx / n,
		NetworkTx: a.networkTx / n,
		DiskIo:    a.diskIo / n,
		DiskRead:  a.diskRead / n,
		DiskWrite: a.diskWrite / n,
	}
}
