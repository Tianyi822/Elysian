package metrics

import (
	"path/filepath"
	"testing"
)

func openTestStore(t *testing.T) *Store {
	t.Helper()
	store, err := OpenStore(filepath.Join(t.TempDir(), "metrics.sqlite"))
	if err != nil {
		t.Fatalf("打开测试指标库：%v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func pointAt(ts int64, value float64) SamplePoint {
	return SamplePoint{
		TS: ts, CPU: value, Memory: value, NetworkIo: value, NetworkRx: value, NetworkTx: value,
		DiskIo: value, DiskRead: value, DiskWrite: value,
	}
}

// minuteStart 帮测试对齐整分钟边界。
func minuteStart(ts int64) int64 { return minuteStartMs(ts) }

func TestInsertAndQueryRawWindow(t *testing.T) {
	store := openTestStore(t)
	now := minuteStart(1_700_000_000_000) + 30_000
	store.InsertRaw(pointAt(now-10_000, 1))
	store.InsertRaw(pointAt(now-5_000, 2))
	store.InsertRaw(pointAt(now, 3))
	points := store.Query("5m", now)
	if len(points) != 3 {
		t.Fatalf("5m 窗口应有 3 点，实际 %d", len(points))
	}
	if points[0].TS != now-10_000 || points[2].TS != now {
		t.Fatalf("应按 ts 升序：%+v", points)
	}
	if points[1].CPU != 2 {
		t.Fatalf("字段应原样取回：%+v", points[1])
	}
}

func TestQueryExcludesOutOfWindow(t *testing.T) {
	store := openTestStore(t)
	now := int64(1_700_000_000_000)
	store.InsertRaw(pointAt(now-10*60_000, 1)) // 10 分钟前：出 5m 窗、在 30m 窗
	if points := store.Query("5m", now); len(points) != 0 {
		t.Fatalf("5m 窗口应为空，实际 %d", len(points))
	}
	if points := store.Query("30m", now); len(points) != 1 {
		t.Fatalf("30m 窗口应有 1 点，实际 %d", len(points))
	}
}

func TestMinuteRollupFeedsLongRangeQuery(t *testing.T) {
	store := openTestStore(t)
	minute := minuteStart(1_700_000_000_000)
	// 同一分钟内三点（值 1/2/3，均值 2），随后翻分钟触发 rollup。
	store.InsertRaw(pointAt(minute+1_000, 1))
	store.InsertRaw(pointAt(minute+2_000, 2))
	store.InsertRaw(pointAt(minute+3_000, 3))
	store.RollupMinuteIfNeeded(minute + 61_000)
	points := store.Query("5h", minute+61_000)
	if len(points) != 1 {
		t.Fatalf("1m 聚合应有 1 行，实际 %d", len(points))
	}
	if points[0].TS != minute || points[0].CPU != 2 {
		t.Fatalf("分钟均值不符（ts=%d cpu=%v）", points[0].TS, points[0].CPU)
	}
}

func TestLongRangeFallsBackToRawDownsample(t *testing.T) {
	store := openTestStore(t)
	minute := minuteStart(1_700_000_000_000)
	// samples_1m 为空（从未 rollup）：5h 查询应回落 raw 按分钟均值。
	store.InsertRaw(pointAt(minute+1_000, 4))
	store.InsertRaw(pointAt(minute+2_000, 6))
	points := store.Query("5h", minute+3_000)
	if len(points) != 1 {
		t.Fatalf("raw 兜底应聚成 1 行，实际 %d", len(points))
	}
	if points[0].TS != minute || points[0].CPU != 5 {
		t.Fatalf("兜底均值应为 5（ts=%d cpu=%v）", points[0].TS, points[0].CPU)
	}
}

func TestPruneHonorsRetention(t *testing.T) {
	store := openTestStore(t)
	now := int64(1_700_000_000_000)
	store.InsertRaw(pointAt(now-2*msPerHour, 1)) // 2 小时前：raw 过期，但 1m 聚合仍在 7 天窗口内保留
	store.InsertRaw(pointAt(now-30*60_000, 2))   // 30 分钟前：raw 与 1m 都保留
	store.InsertRaw(pointAt(now-8*msPerDay, 3))  // 8 天前：raw 与 1m 都过期
	store.RollupMinuteIfNeeded(now)              // 冲刷最后的分钟桶（8 天前那行落 1m 后即被清理）
	store.Prune(now)
	if points := store.Query("30m", now); len(points) != 1 {
		t.Fatalf("raw 只剩 30 分钟前一点，实际 %d", len(points))
	}
	if points := store.Query("7d", now); len(points) != 2 {
		t.Fatalf("1m 应保留 2 小时前与 30 分钟前两行（8 天前已清），实际 %d", len(points))
	}
}

func TestQueryInvalidRangeReturnsEmpty(t *testing.T) {
	store := openTestStore(t)
	store.InsertRaw(pointAt(1, 1))
	if points := store.Query("bogus", 1000); len(points) != 0 {
		t.Fatalf("非法 range 应空数组，实际 %d", len(points))
	}
}

func TestStorePersistsAcrossReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "metrics.sqlite")
	store, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	store.InsertRaw(pointAt(1_700_000_000_000, 7))
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	points := reopened.Query("5m", 1_700_000_000_000+1_000)
	if len(points) != 1 || points[0].CPU != 7 {
		t.Fatalf("重开后应取回既有数据：%+v", points)
	}
}

func TestTimeRangeDurationMs(t *testing.T) {
	for key, want := range map[string]int64{"5m": 5 * msPerMinute, "30m": 30 * msPerMinute, "1h": msPerHour, "5h": 5 * msPerHour, "7d": 7 * msPerDay} {
		got, ok := timeRangeDurationMs(key)
		if !ok || got != want {
			t.Fatalf("%s 应为 %dms，实际 %d（%v）", key, want, got, ok)
		}
	}
	if _, ok := timeRangeDurationMs("1w"); ok {
		t.Fatal("未登记的 range 应非法")
	}
}
