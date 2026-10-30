package security

import (
	"bufio"
	"compress/gzip"
	"container/heap"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"elysian/server/internal/shared"
)

// 统计扫描与列表窗口独立；内存只保留最近 2000 条，不整包读系统日志。
const sshHistoryBytes = 128 << 20

type sshHistory struct {
	Records []SshLoginRecord
	Stats   SshLoginStats
	Info    *SshLogInfo
}
type sshRecordHeap []SshLoginRecord

func (h sshRecordHeap) Len() int { return len(h) }
func (h sshRecordHeap) Less(i, j int) bool {
	if h[i].At == h[j].At {
		return h[i].ID < h[j].ID
	}
	return h[i].At < h[j].At
}
func (h sshRecordHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *sshRecordHeap) Push(x any)   { *h = append(*h, x.(SshLoginRecord)) }
func (h *sshRecordHeap) Pop() any     { old := *h; x := old[len(old)-1]; *h = old[:len(old)-1]; return x }

type sshHistoryBuilder struct {
	now, start  time.Time
	rows        sshRecordHeap
	stats       SshLoginStats
	earliest    time.Time
	untimed     bool
	seenUntimed map[string]string
}

func newHistoryBuilder(now time.Time, seen map[string]string) *sshHistoryBuilder {
	local := now.Local()
	start := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.Local).AddDate(0, 0, -6)
	return &sshHistoryBuilder{now: now, start: start, seenUntimed: seen}
}
func (b *sshHistoryBuilder) add(line ParsedLoginLine, id, at string) {
	if at == "" && line.At != nil {
		at = *line.At
	}
	if at == "" {
		b.untimed = true
		at = b.seenUntimed[id]
		if at == "" {
			at = formatIsoMillis(b.now)
			b.seenUntimed[id] = at
		}
	}
	stamp, ok := parseIsoTimeOk(at)
	if !ok {
		return
	}
	if b.earliest.IsZero() || stamp.Before(b.earliest) {
		b.earliest = stamp
	}
	if stamp.Before(b.start) || stamp.After(b.now) {
		return
	}
	row := SshLoginRecord{ID: id, At: at, IP: line.IP, Port: line.Port, User: line.User, Result: line.Result}
	today := b.start.AddDate(0, 0, 6)
	yesterday := today.AddDate(0, 0, -1)
	if !stamp.Before(today) {
		countLogin(&b.stats.Today, line.Result)
	} else if !stamp.Before(yesterday) {
		countLogin(&b.stats.Yesterday, line.Result)
	}
	countLogin(&b.stats.Last7Days, line.Result)
	heap.Push(&b.rows, row)
	if len(b.rows) > SSH_LOG_TAIL_LINES {
		heap.Pop(&b.rows)
	}
}
func (b *sshHistoryBuilder) finish(source string, err error) sshHistory {
	rows := []SshLoginRecord(b.rows)
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].At == rows[j].At {
			return rows[i].ID > rows[j].ID
		}
		return rows[i].At > rows[j].At
	})
	info := &SshLogInfo{Source: source, Status: "ready", SampledAt: formatIsoMillis(b.now)}
	warning := ""
	if b.earliest.IsZero() || b.earliest.After(b.start) {
		warning = "统计仅包含系统当前保留的近七天日志，无法确认更早历史的完整性。"
		info.Status = "partial"
	}
	if b.untimed {
		warning += "部分日志没有时间戳，使用本进程首次观察时间。"
		info.Status = "partial"
	}
	if err != nil {
		warning += "日志读取未完成：" + err.Error()
		info.Status = "partial"
		if len(rows) == 0 {
			info.Status = "unavailable"
		}
	}
	if warning != "" {
		info.Warning = &warning
	}
	return sshHistory{Records: rows, Stats: b.stats, Info: info}
}
func sshLogID(source string) string {
	sum := sha256.Sum256([]byte(source))
	return "login-" + hex.EncodeToString(sum[:12])
}

func scanSshLines(ctx context.Context, reader io.Reader, consume func(string, int)) error {
	limited := &io.LimitedReader{R: reader, N: sshHistoryBytes + 1}
	scanner := bufio.NewScanner(limited)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	index := 0
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return err
		}
		index++
		consume(scanner.Text(), index)
	}
	if limited.N <= 0 {
		return fmt.Errorf("日志超过单次 %d MiB 读取上限", sshHistoryBytes>>20)
	}
	return scanner.Err()
}
func readSshJournal(ctx context.Context, b *sshHistoryBuilder) error {
	cmd, cmdCtx, cancel := shared.SystemCommand(ctx, "journalctl", "--no-pager", "--quiet", "--all", "-o", "json", "--since", b.start.Format(time.RFC3339), "--until", b.now.Format(time.RFC3339), "-t", "sshd", "-t", "sshd-session")
	defer cancel()
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err = cmd.Start(); err != nil {
		return fmt.Errorf("无法读取系统 SSH journal：%w", err)
	}
	readErr := scanSshLines(cmdCtx, pipe, func(raw string, index int) {
		var entry struct {
			Message string `json:"MESSAGE"`
			Time    string `json:"__REALTIME_TIMESTAMP"`
			Cursor  string `json:"__CURSOR"`
		}
		if json.Unmarshal([]byte(raw), &entry) != nil {
			return
		}
		micro, e := strconv.ParseInt(entry.Time, 10, 64)
		if e != nil {
			return
		}
		lines := parseSshLogLines(entry.Message, formatIsoMillis(b.now))
		for _, line := range lines {
			id := entry.Cursor
			if id == "" {
				id = entry.Time + ":" + strconv.Itoa(index) + ":" + entry.Message
			}
			b.add(line, sshLogID(id), formatIsoMillis(time.UnixMicro(micro)))
		}
	})
	if readErr != nil {
		cancel()
	}
	waitErr := cmd.Wait()
	if readErr != nil {
		return readErr
	}
	if waitErr != nil {
		return fmt.Errorf("系统 SSH journal 不可读：%w", shared.SystemCommandError(cmdCtx, waitErr))
	}
	if len(b.rows) == 0 {
		probe, probeCtx, stop := shared.SystemCommand(ctx, "journalctl", "--no-pager", "--quiet", "-n", "1", "-o", "json", "--output-fields=__CURSOR")
		defer stop()
		output, probeErr := probe.Output()
		if probeErr != nil {
			return fmt.Errorf("系统 journal 不可读：%w", shared.SystemCommandError(probeCtx, probeErr))
		}
		if strings.TrimSpace(string(output)) == "" {
			return fmt.Errorf("系统没有可读取的 journal 日志，请检查 journald 或认证日志服务")
		}
	}
	return nil
}
func readSshLogFiles(ctx context.Context, b *sshHistoryBuilder, files []string) error {
	var errs []string
	readable := false
	for _, path := range files {
		f, err := os.Open(path)
		if err != nil {
			errs = append(errs, err.Error())
			continue
		}
		var reader io.Reader = f
		var gz *gzip.Reader
		if strings.HasSuffix(path, ".gz") {
			gz, err = gzip.NewReader(f)
			if err != nil {
				f.Close()
				errs = append(errs, err.Error())
				continue
			}
			reader = gz
		}
		readable = true
		err = scanSshLines(ctx, reader, func(raw string, index int) {
			for _, line := range parseSshLogLines(raw, formatIsoMillis(b.now)) {
				b.add(line, sshLogID(path+":"+strconv.Itoa(index)+":"+line.Source), "")
			}
		})
		if gz != nil {
			_ = gz.Close()
		}
		_ = f.Close()
		if err != nil {
			errs = append(errs, err.Error())
		}
		if ctx.Err() != nil {
			break
		}
	}
	if !readable && len(errs) == 0 {
		return fmt.Errorf("未找到可读取的 SSH 认证日志")
	}
	if len(errs) > 0 {
		return fmt.Errorf("%s", strings.Join(errs, "；"))
	}
	return nil
}
func newSshHistoryReader(bare bool, d *sshHostDeps) func() sshHistory {
	var mu sync.Mutex
	var cached sshHistory
	var cachedAt time.Time
	seen := map[string]string{}
	return func() sshHistory {
		mu.Lock()
		defer mu.Unlock()
		now := parseIsoTime(d.nowIso())
		if cached.Info != nil && now.Sub(cachedAt) >= 0 && now.Sub(cachedAt) < 5*time.Second {
			return cached
		}
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		b := newHistoryBuilder(now, seen)
		source := "panel-file"
		var err error
		if bare {
			source = "journal"
			err = readSshJournal(ctx, b)
			if len(b.rows) == 0 {
				files, _ := filepath.Glob("/var/log/auth.log*")
				if len(files) == 0 {
					files, _ = filepath.Glob("/var/log/secure*")
				}
				sort.Strings(files)
				if len(files) > 0 {
					b = newHistoryBuilder(now, seen)
					source = "auth-file"
					err = readSshLogFiles(ctx, b, files)
				}
			}
		} else {
			err = readSshLogFiles(ctx, b, []string{dPath(d).sshdLog})
		}
		cached = b.finish(source, err)
		cachedAt = parseIsoTime(d.nowIso())
		// 防止无时间戳来源的首次观察映射随轮转无限增长。
		if len(seen) > 10000 {
			next := map[string]string{}
			for _, row := range cached.Records {
				if at, ok := seen[row.ID]; ok {
					next[row.ID] = at
				}
			}
			seen = next
		}
		return cached
	}
}
func dPath(d *sshHostDeps) sshPaths { return sshDepsPaths(d.pathsOverride) }
