package include

import (
	"strings"
	"testing"

	"elysian/server/internal/agent/kardia/loader"
)

// —— 测试辅助 ——

func sptr(s string) *string { return &s }

func bptr(b bool) *bool { return &b }

func entry(id, name string) *loader.EntryOptions {
	return &loader.EntryOptions{ID: id, Name: name}
}

func groupEntry(id string, config []*loader.EntryOptions) *loader.EntryOptions {
	return &loader.EntryOptions{ID: id, Name: "@cordisjs/plugin-group", Group: bptr(true), Config: config}
}

func allFileOwned(string, *string) bool { return true }

func mustGet(t *testing.T, j *Journal, id string) *JournalRecord {
	t.Helper()
	rec, ok := j.Get(id)
	if !ok {
		t.Fatalf("账本中应有条目 %q", id)
	}
	return rec
}

// —— DiffOptions 与值等价 ——

// 场景取自 sync「coalesces consecutive writes」：连续改 config 只留下最新差异。
func TestDiffOptions(t *testing.T) {
	legacy := &loader.EntryOptions{ID: "a", Name: "./p", Disabled: bptr(false), Config: map[string]any{"v": 1}}
	options := &loader.EntryOptions{ID: "a2", Name: "./p", Config: map[string]any{"v": 2}}
	changes := DiffOptions(legacy, options)
	if _, ok := changes["id"]; ok {
		t.Fatal("id 不应参与 diff")
	}
	if _, ok := changes["name"]; ok {
		t.Fatal("未变化的 name 不应出现在 diff 中")
	}
	if v, ok := changes["disabled"]; !ok || v != nil {
		t.Fatalf("被删除的 disabled 应记为 nil，实际 (%v, %v)", v, ok)
	}
	if v, ok := changes["config"]; !ok || !valueEqual(v, map[string]any{"v": 2}) {
		t.Fatalf("config 差异应取 options 侧，实际 (%v, %v)", v, ok)
	}
}

func TestValueEqual(t *testing.T) {
	cases := []struct {
		name string
		a, b any
		want bool
	}{
		{"nil 互通", nil, nil, true},
		{"nil 与空串不同", nil, "", false},
		{"数字跨整型浮点", int64(1), float64(1), true},
		{"数字不等", 1, 2, false},
		{"无符号与有符号", uint(2), int64(2), true},
		{"负数与无符号", int64(-1), uint(1), false},
		{"NaN 不等", nanValue(), nanValue(), false},
		{"bool 与 *bool 互通", true, bptr(true), true},
		{"bool 不等", true, false, false},
		{"map 深比", map[string]any{"v": 1}, map[string]any{"v": 1}, true},
		{"map 多键不等", map[string]any{"v": 1}, map[string]any{"v": 1, "w": 2}, false},
		{"数组深比", []any{1, "x"}, []any{1, "x"}, true},
		{"数组长度不等", []any{1}, []any{1, 2}, false},
		{"空切片不等于 nil", []any{}, nil, false},
		{"条目与条目", entry("a", "./p"), entry("a", "./p"), true},
		{"条目与原生 map", entry("a", "./p"), map[string]any{"id": "a", "name": "./p"}, true},
		{"条目与不同条目", entry("a", "./p"), entry("a", "./q"), false},
	}
	for _, c := range cases {
		if got := valueEqual(c.a, c.b); got != c.want {
			t.Errorf("%s：期望 %v，实际 %v", c.name, c.want, got)
		}
	}
}

// nanValue 构造运行时 NaN：常量除零在编译期非法，须经变量把除法落到
// 运行时（1/0 得 +Inf，再乘 0 得 NaN）。
func nanValue() float64 {
	var zero float64
	return 1 / zero * zero
}

// —— MergeRecords / MergeJournal ——

func TestMergeRecordsFold(t *testing.T) {
	older := &JournalRecord{
		Kind:     KindUpsert,
		Created:  true,
		Parent:   rooted(sptr("g")),
		Position: 0,
		Changes:  map[string]any{"disabled": true},
	}
	newer := &JournalRecord{
		Kind:     KindUpsert,
		Created:  false,
		Parent:   rooted(sptr("h")),
		Position: 2,
		Changes:  map[string]any{"disabled": nil, "config": map[string]any{"v": 2}},
	}
	merged := MergeRecords(older, newer)
	if merged.Kind != KindUpsert {
		t.Fatalf("合并后应为 upsert，实际 %s", merged.Kind)
	}
	if !merged.Created {
		t.Fatal("created 应保留先前的 true")
	}
	if parentName(merged.Parent) != "h" || merged.Position != 2 {
		t.Fatalf("迁移应覆盖父组与位置，实际 (%q, %d)", parentName(merged.Parent), merged.Position)
	}
	if v, ok := merged.Changes["disabled"]; !ok || v != nil {
		t.Fatalf("后续记录的键应覆盖先前（nil=删除），实际 (%v, %v)", v, ok)
	}
	if v, ok := merged.Changes["config"]; !ok || !valueEqual(v, map[string]any{"v": 2}) {
		t.Fatalf("新增键应并入，实际 (%v, %v)", v, ok)
	}

	// 未迁移的后续记录保留先前的位置信息
	stay := &JournalRecord{Kind: KindUpsert, Created: false, Position: 5, Changes: map[string]any{"name": "./q"}}
	merged2 := MergeRecords(older, stay)
	if merged2.Position != 0 || parentName(merged2.Parent) != "g" {
		t.Fatalf("未迁移时应保留先前位置，实际 (%q, %d)", parentName(merged2.Parent), merged2.Position)
	}
}

func TestMergeRecordsRemoveCancelsCreated(t *testing.T) {
	created := &JournalRecord{Kind: KindUpsert, Created: true, Changes: map[string]any{"name": "./p"}}
	if merged := MergeRecords(created, &JournalRecord{Kind: KindRemove}); merged != nil {
		t.Fatal("创建后未写盘即移除应相互抵消")
	}
	updated := &JournalRecord{Kind: KindUpsert, Created: false, Changes: map[string]any{"name": "./p"}}
	if merged := MergeRecords(updated, &JournalRecord{Kind: KindRemove}); merged == nil || merged.Kind != KindRemove {
		t.Fatal("非创建的更新被移除应留下 remove 记录")
	}
}

func TestMergeRecordsAfterRemove(t *testing.T) {
	remove := &JournalRecord{Kind: KindRemove}
	newer := &JournalRecord{
		Kind:     KindUpsert,
		Created:  true,
		Parent:   rooted(sptr("g")),
		Position: 1,
		Changes:  map[string]any{"name": "./p"},
	}
	merged := MergeRecords(remove, newer)
	if merged.Kind != KindUpsert || merged.Created {
		t.Fatal("移除后再出现应视为更新（created=false）")
	}
	if parentName(merged.Parent) != "g" || merged.Position != 1 {
		t.Fatalf("应保留新记录的位置，实际 (%q, %d)", parentName(merged.Parent), merged.Position)
	}
	if v, ok := merged.Changes["name"]; !ok || v != "./p" {
		t.Fatalf("应保留新记录的变更，实际 (%v, %v)", v, ok)
	}
}

func TestMergeJournalSetDeleteOrder(t *testing.T) {
	j := NewJournal()
	MergeJournal(j, "a", &JournalRecord{Kind: KindRemove})
	MergeJournal(j, "b", &JournalRecord{Kind: KindRemove})
	// 同 id 重复写入保持原位
	MergeJournal(j, "a", &JournalRecord{Kind: KindRemove})
	var order []string
	j.Each(func(id string, rec *JournalRecord) { order = append(order, id) })
	if len(order) != 2 || order[0] != "a" || order[1] != "b" {
		t.Fatalf("插入序应为 [a b]，实际 %v", order)
	}
	// 移除后再次出现：折叠为 created=false 的 upsert，仍在账内
	MergeJournal(j, "a", &JournalRecord{Kind: KindUpsert, Created: true, Changes: map[string]any{}})
	if j.Len() != 2 {
		t.Fatalf("remove 后随 upsert 不应出账，实际剩 %d 条", j.Len())
	}
	if mustGet(t, j, "a").Created {
		t.Fatal("移除后再出现不应保留 created 标记")
	}
	j.Delete("a")
	j.Delete("b")
	if j.Len() != 0 {
		t.Fatalf("清空后账本应为空，实际 %d 条", j.Len())
	}
}

// —— Record ——

func TestRecordVariants(t *testing.T) {
	opts := &loader.EntryOptions{ID: "a", Name: "./p", Config: map[string]any{"v": 1}}
	group := &loader.EntryGroup{}

	// 创建：created=true、整份配置（除 id）入账、父组与位置如实记录
	j := NewJournal()
	Record(j, loader.EntryChange{ID: "a", Group: group, Options: opts}, sptr("g"))
	rec := mustGet(t, j, "a")
	if rec.Kind != KindUpsert || !rec.Created {
		t.Fatal("新条目应为 created 的 upsert")
	}
	if parentName(rec.Parent) != "g" || rec.Position != 0 {
		t.Fatalf("应记父组 g 与位置 0，实际 (%q, %d)", parentName(rec.Parent), rec.Position)
	}
	if v, ok := rec.Changes["name"]; !ok || v != "./p" {
		t.Fatalf("创建应整份入账（除 id），name 实际 (%v, %v)", v, ok)
	}
	if _, ok := rec.Changes["id"]; ok {
		t.Fatal("创建入账不应含 id")
	}

	// 未迁移的更新：Parent 为 nil（undefined），只记差异
	legacy := &loader.EntryOptions{ID: "a", Name: "./p", Config: map[string]any{"v": 1}}
	opts2 := &loader.EntryOptions{ID: "a", Name: "./p", Config: map[string]any{"v": 3}}
	group2 := &loader.EntryGroup{}
	j = NewJournal()
	Record(j, loader.EntryChange{ID: "a", Group: group2, Options: opts2, Legacy: legacy}, sptr("g"))
	rec = mustGet(t, j, "a")
	if rec.Created {
		t.Fatal("更新不应标记 created")
	}
	if rec.Parent != nil {
		t.Fatalf("未迁移应记 nil，实际 %q", parentName(rec.Parent))
	}
	if len(rec.Changes) != 1 {
		t.Fatalf("只应记差异键，实际 %v", rec.Changes)
	}
	if v, ok := rec.Changes["config"]; !ok || !valueEqual(v, map[string]any{"v": 3}) {
		t.Fatalf("config 差异应入账，实际 (%v, %v)", v, ok)
	}

	// 迁移的更新：from 非空时如实记父组
	j = NewJournal()
	Record(j, loader.EntryChange{ID: "a", Group: group2, Options: opts2, Legacy: legacy, From: &loader.EntryGroup{}}, sptr("h"))
	if parentName(mustGet(t, j, "a").Parent) != "h" {
		t.Fatal("迁移更新应记新父组 h")
	}

	// 移除
	j = NewJournal()
	Record(j, loader.EntryChange{ID: "a", Group: group}, nil)
	rec = mustGet(t, j, "a")
	if rec.Kind != KindRemove {
		t.Fatalf("options 缺失应记 remove，实际 %s", rec.Kind)
	}
}

// —— Flatten ——

func TestFlattenNested(t *testing.T) {
	a := entry("a", "./p")
	b := entry("b", "./p")
	c := entry("c", "./p")
	inner := []*loader.EntryOptions{b}
	g := groupEntry("g", inner)
	// 无 id 的组：其成员按根登记（parent 为 null）
	anon := &loader.EntryOptions{Name: "./grp", Group: bptr(true), Config: []*loader.EntryOptions{c}}
	data := []*loader.EntryOptions{a, g, anon}

	flat := Flatten(data, nil)
	fa := flat["a"]
	if fa == nil || fa.Position != 0 || parentName(fa.Parent) != "" {
		t.Fatalf("根条目 a 应在位置 0、父组为根，实际 %+v", fa)
	}
	fb := flat["b"]
	if fb == nil || fb.Position != 0 || parentName(fb.Parent) != "g" {
		t.Fatalf("嵌套条目 b 应记父组 g，实际 %+v", fb)
	}
	if fb.List == nil || len(*fb.List) != 1 || (*fb.List)[0] != b {
		t.Fatal("b 的 List 快照应指向其所在列表")
	}
	fc := flat["c"]
	if fc == nil || parentName(fc.Parent) != "" {
		t.Fatalf("无 id 组的成员应按根登记，实际 %+v", fc)
	}
	if flat["g"] == nil {
		t.Fatal("组自身也应被索引")
	}
}

// —— ApplyChanges ——

func TestApplyChanges(t *testing.T) {
	o := entry("a", "./p")
	changes := map[string]any{
		"disabled": bptr(true),
		"name":     nil,
		"custom":   "x",
	}
	ApplyChanges(o, changes, nil)
	if o.Disabled == nil || !*o.Disabled {
		t.Fatal("disabled 应被写入")
	}
	if o.Name != "" {
		t.Fatalf("nil 值应删除键，name 实际 %q", o.Name)
	}
	if v, ok := loader.GetKey(o, "custom"); !ok || v != "x" {
		t.Fatalf("未知键应落入 Extras，实际 (%v, %v)", v, ok)
	}

	// filter 语义与 journal.ts:109-118 一致：返回 false 才拦截；放行的键
	// （含 nil 删除）照常应用
	o2 := entry("a", "./p")
	ApplyChanges(o2, changes, func(key string) bool { return key != "disabled" })
	if o2.Disabled != nil {
		t.Fatal("被 filter 拦截的 disabled 不应应用")
	}
	if o2.Name != "" {
		t.Fatalf("放行的 nil 值应删除键，name 实际 %q", o2.Name)
	}
}

// —— Detach / Place ——

func TestDetachNested(t *testing.T) {
	a := entry("a", "./p")
	b := entry("b", "./p")
	g := groupEntry("g", []*loader.EntryOptions{b})
	data := []*loader.EntryOptions{a, g}

	if _, got := Detach(data, "zzz"); got != nil {
		t.Fatal("未命中应返回 nil")
	}
	if _, got := Detach(data, "b"); got != b {
		t.Fatal("应返回被移除的条目")
	}
	list, ok := listOf(g)
	if !ok || len(list) != 0 {
		t.Fatalf("嵌套移除应经父组 Config 回传，实际长度 %d", len(list))
	}
}

func TestPlaceVariants(t *testing.T) {
	a := entry("a", "./p")
	b := entry("b", "./p")
	g := groupEntry("g", []*loader.EntryOptions{b})
	x := entry("x", "./q")
	data := []*loader.EntryOptions{a, g}

	if _, ok := Place(data, x, sptr("g"), 99); !ok {
		t.Fatal("组内插入应成功")
	}
	list, _ := listOf(g)
	if len(list) != 2 || list[1] != x {
		t.Fatalf("越界位置应收敛到末尾，实际 %v", list)
	}

	if _, ok := Place(data, entry("y", "./q"), sptr("a"), 0); ok {
		t.Fatal("非组条目应拒绝插入")
	}
	if _, ok := Place(data, entry("y", "./q"), sptr("nope"), 0); ok {
		t.Fatal("不存在的父组应拒绝插入")
	}

	// 无成员列表的组：插入时创建列表
	g2 := groupEntry("g2", nil)
	data2 := []*loader.EntryOptions{g2}
	if _, ok := Place(data2, x, sptr("g2"), 0); !ok {
		t.Fatal("空组插入应成功")
	}
	if list, ok := listOf(g2); !ok || len(list) != 1 || list[0] != x {
		t.Fatalf("空组应回建成员列表，实际 %v", list)
	}
}

// —— ApplyJournal ——

// 场景取自 sync「removes a nested entry through its composite id」与
// 「coalesces consecutive writes」：移除与建新混合。
func TestApplyJournalRemoveAndCreate(t *testing.T) {
	a := entry("a", "./p")
	b := entry("b", "./p")
	c := entry("c", "./p")
	g := groupEntry("g", []*loader.EntryOptions{b})
	data := []*loader.EntryOptions{a, c, g}

	j := NewJournal()
	MergeJournal(j, "b", &JournalRecord{Kind: KindRemove})
	MergeJournal(j, "c", &JournalRecord{Kind: KindRemove})
	MergeJournal(j, "n", &JournalRecord{
		Kind:     KindUpsert,
		Created:  true,
		Parent:   rooted(sptr("g")),
		Position: 1,
		Changes:  map[string]any{"name": "./p"},
	})
	out := ApplyJournal(data, j, nil, nil)
	if len(out) != 2 || out[0] != a || out[1] != g {
		t.Fatalf("根级移除应经返回值生效，实际 %v 个条目", len(out))
	}
	list, _ := listOf(g)
	if len(list) != 1 || list[0].ID != "n" || list[0].Name != "./p" {
		t.Fatalf("新条目应建进组 g，实际 %v", list)
	}
}

// 场景取自 sync「combines a move in the file with an edit at runtime」：
// 迁移与键级变更同时发生。
func TestApplyJournalRelocate(t *testing.T) {
	a := entry("a", "./p")
	b := &loader.EntryOptions{ID: "b", Name: "./p", Config: map[string]any{"v": 1}}
	g := groupEntry("g", nil)
	data := []*loader.EntryOptions{a, b, g}

	j := NewJournal()
	MergeJournal(j, "b", &JournalRecord{
		Kind:     KindUpsert,
		Parent:   rooted(sptr("g")),
		Position: 0,
		Changes:  map[string]any{"config": map[string]any{"v": 2}},
	})
	out := ApplyJournal(data, j, nil, nil)
	if len(out) != 2 || out[1] != g {
		t.Fatalf("迁移后根列表应只剩 [a g]，实际 %d 个", len(out))
	}
	list, _ := listOf(g)
	if len(list) != 1 || list[0] != b {
		t.Fatal("b 应迁入组 g")
	}
	if !valueEqual(b.Config, map[string]any{"v": 2}) {
		t.Fatalf("迁移随行的键级变更应生效，实际 %v", b.Config)
	}
}

func TestApplyJournalFailedMoveWarnsAndRestores(t *testing.T) {
	a := entry("a", "./p")
	b := &loader.EntryOptions{ID: "b", Name: "./p"}
	g := groupEntry("g", nil)
	data := []*loader.EntryOptions{a, b, g}

	var warned []string
	j := NewJournal()
	MergeJournal(j, "b", &JournalRecord{
		Kind:     KindUpsert,
		Parent:   rooted(sptr("missing")),
		Position: 0,
		Changes:  map[string]any{"disabled": bptr(true)},
	})
	out := ApplyJournal(data, j, nil, func(format string, args ...any) {
		warned = append(warned, format)
	})
	if len(warned) != 1 || !strings.Contains(warned[0], "无法移动条目") {
		t.Fatalf("目标组缺失应告警一次，实际 %v", warned)
	}
	if len(out) != 3 || out[1] != b {
		t.Fatal("失败的迁移应把条目放回原位")
	}
	if b.Disabled == nil || !*b.Disabled {
		t.Fatal("迁移随行的键级变更仍应生效")
	}
}

func TestApplyJournalFilter(t *testing.T) {
	a := entry("a", "./p")
	data := []*loader.EntryOptions{a}
	j := NewJournal()
	MergeJournal(j, "a", &JournalRecord{
		Kind:    KindUpsert,
		Changes: map[string]any{"disabled": bptr(true)},
	})

	// 整条目放行、键全拒：变更不落
	out := ApplyJournal(data, j, func(id string, key *string) bool { return key == nil }, nil)
	if out[0].Disabled != nil {
		t.Fatal("键被问询拒绝时不应应用")
	}

	// 整条目拒绝：连移除都不生效
	j2 := NewJournal()
	MergeJournal(j2, "a", &JournalRecord{Kind: KindRemove})
	out2 := ApplyJournal(data, j2, func(id string, key *string) bool { return false }, nil)
	if len(out2) != 1 || out2[0] != a {
		t.Fatal("整条目被拒时移除不应生效")
	}
}

// —— Reconcile ——

func TestReconcileRemoveCases(t *testing.T) {
	// 文件也移除了：静默出账
	j := NewJournal()
	MergeJournal(j, "a", &JournalRecord{Kind: KindRemove})
	base := Flatten([]*loader.EntryOptions{entry("a", "./p")}, nil)
	conflicts := Reconcile(j, base, Flatten(nil, nil), allFileOwned)
	if len(conflicts) != 0 || j.Len() != 0 {
		t.Fatalf("双侧都移除应静默出账，实际冲突 %v、剩 %d 条", conflicts, j.Len())
	}

	// 文件改了、运行时移除：冲突并丢弃移除意图
	j = NewJournal()
	MergeJournal(j, "b", &JournalRecord{Kind: KindRemove})
	base = Flatten([]*loader.EntryOptions{{ID: "b", Name: "./p", Config: map[string]any{"v": 1}}}, nil)
	theirs := Flatten([]*loader.EntryOptions{{ID: "b", Name: "./p", Config: map[string]any{"v": 2}}}, nil)
	conflicts = Reconcile(j, base, theirs, allFileOwned)
	if len(conflicts) != 1 || conflicts[0].ID != "b" || !strings.Contains(conflicts[0].Reason, "文件中已修改，运行时已移除") {
		t.Fatalf("文件修改遇运行时移除应冲突，实际 %v", conflicts)
	}
	if j.Len() != 0 {
		t.Fatal("冲突的移除记录应出账")
	}

	// 文件新增、运行时移除：冲突
	j = NewJournal()
	MergeJournal(j, "c", &JournalRecord{Kind: KindRemove})
	conflicts = Reconcile(j, Flatten(nil, nil), Flatten([]*loader.EntryOptions{entry("c", "./p")}, nil), allFileOwned)
	if len(conflicts) != 1 || !strings.Contains(conflicts[0].Reason, "文件中新增，运行时已移除") {
		t.Fatalf("文件新增遇运行时移除应冲突，实际 %v", conflicts)
	}
}

func TestReconcileUpsertCases(t *testing.T) {
	// 文件移除了条目、运行时改了它：冲突并出账
	j := NewJournal()
	MergeJournal(j, "a", &JournalRecord{Kind: KindUpsert, Changes: map[string]any{"name": "./q"}})
	base := Flatten([]*loader.EntryOptions{entry("a", "./p")}, nil)
	conflicts := Reconcile(j, base, Flatten(nil, nil), allFileOwned)
	if len(conflicts) != 1 || !strings.Contains(conflicts[0].Reason, "文件中已移除，运行时已修改") {
		t.Fatalf("文件移除遇运行时修改应冲突，实际 %v", conflicts)
	}
	if j.Len() != 0 {
		t.Fatal("冲突记录应出账")
	}

	// 键级冲突：文件与运行时各改各的，文件获胜
	j = NewJournal()
	MergeJournal(j, "a", &JournalRecord{
		Kind:    KindUpsert,
		Created: true,
		Changes: map[string]any{"config": map[string]any{"v": 2}},
	})
	base = Flatten([]*loader.EntryOptions{{ID: "a", Name: "./p", Config: map[string]any{"v": 1}}}, nil)
	theirs := Flatten([]*loader.EntryOptions{{ID: "a", Name: "./p", Config: map[string]any{"v": 3}}}, nil)
	conflicts = Reconcile(j, base, theirs, allFileOwned)
	if len(conflicts) != 1 || !strings.Contains(conflicts[0].Reason, "同时被修改") {
		t.Fatalf("键级双改应冲突，实际 %v", conflicts)
	}
	// created 被清且变更被丢，记录随之出账
	if j.Len() != 0 {
		t.Fatalf("变更清空后应出账，实际剩 %d 条", j.Len())
	}

	// 运行时值与文件一致：不冲突，记录保留
	j = NewJournal()
	MergeJournal(j, "a", &JournalRecord{
		Kind:    KindUpsert,
		Created: true,
		Changes: map[string]any{"config": map[string]any{"v": 3}},
	})
	conflicts = Reconcile(j, base, theirs, allFileOwned)
	if len(conflicts) != 0 {
		t.Fatalf("运行时值与文件一致不应冲突，实际 %v", conflicts)
	}
	rec := mustGet(t, j, "a")
	if rec.Created {
		t.Fatal("见到文件状态后 created 应被清除")
	}
	if len(rec.Changes) != 1 {
		t.Fatalf("一致的变更应保留，实际 %v", rec.Changes)
	}

	// fileOwned 划定范围：补丁持有的键不参与调和
	j = NewJournal()
	MergeJournal(j, "a", &JournalRecord{Kind: KindUpsert, Changes: map[string]any{"config": map[string]any{"v": 2}}})
	none := func(string, *string) bool { return false }
	conflicts = Reconcile(j, base, theirs, none)
	if len(conflicts) != 0 || j.Len() != 1 {
		t.Fatal("非文件持有的条目不应参与调和")
	}
}

func TestReconcileMoveConflictAndCleanup(t *testing.T) {
	// 双侧都移动了条目：冲突，运行时迁移意图作废
	j := NewJournal()
	MergeJournal(j, "a", &JournalRecord{
		Kind:     KindUpsert,
		Parent:   rooted(sptr("g1")),
		Position: 0,
		Changes:  map[string]any{},
	})
	base := Flatten([]*loader.EntryOptions{entry("a", "./p"), groupEntry("g0", nil)}, nil)
	theirs := Flatten([]*loader.EntryOptions{groupEntry("g2", []*loader.EntryOptions{entry("a", "./p")})}, nil)
	conflicts := Reconcile(j, base, theirs, allFileOwned)
	if len(conflicts) != 1 || !strings.Contains(conflicts[0].Reason, "移动") {
		t.Fatalf("双侧移动应冲突，实际 %v", conflicts)
	}
	// 迁移作废后无变更无迁移：记录出账
	if j.Len() != 0 {
		t.Fatalf("空记录应出账，实际剩 %d 条", j.Len())
	}

	// 文件移动与运行时迁移一致（同一个新父组）：不冲突
	j = NewJournal()
	MergeJournal(j, "a", &JournalRecord{
		Kind:    KindUpsert,
		Parent:  rooted(sptr("g2")),
		Changes: map[string]any{"name": "./q"},
	})
	conflicts = Reconcile(j, base, theirs, allFileOwned)
	if len(conflicts) != 0 {
		t.Fatalf("同向迁移不应冲突，实际 %v", conflicts)
	}
	if j.Len() != 1 {
		t.Fatal("仍有变更的记录应保留")
	}
	if parentName(mustGet(t, j, "a").Parent) != "g2" {
		t.Fatal("一致的迁移意图应保留")
	}
}
