// Package include 实现 Cordis include 插件的机制层：树侧变更账本（journal）、
// 配置补丁（patch）以及二者的应用、调和与路由。文件读写与插件生命周期在
// include.go（include主体交付）。
package include

import (
	"elysian/server/internal/agent/kardia"
	"fmt"
	"reflect"
	"sort"

	"elysian/server/internal/agent/kardia/loader"
)

// RecordKind 对应 TS JournalRecord 的 kind 字段："remove"=移除，"upsert"=创建或更新。
type RecordKind string

const (
	// KindRemove 表示条目被从树中移除。
	KindRemove RecordKind = "remove"
	// KindUpsert 表示条目被创建或更新。
	KindUpsert RecordKind = "upsert"
)

// JournalRecord 对应 include/src/journal.ts:5-30：一条尚未落盘的树侧变更。
// Parent 三态：nil=本次变更未迁移；指向 ""=根；其余=父组 id。
// Changes 是相对上报时条目配置的键级增量，值为 nil 表示删除该键。
type JournalRecord struct {
	Kind     RecordKind
	Created  bool
	Parent   *string
	Position int
	Changes  map[string]any
}

// Journal 对应 TS 的 Map<string, JournalRecord>，以有序封装保持插入序遍历。
type Journal struct {
	order []string
	m     map[string]*JournalRecord
}

// NewJournal 建立空账本。
func NewJournal() *Journal {
	return &Journal{m: map[string]*JournalRecord{}}
}

// Len 返回账本条数（对应 TS journal.size）。
func (j *Journal) Len() int {
	return len(j.m)
}

// Get 按 id 取记录。
func (j *Journal) Get(id string) (*JournalRecord, bool) {
	rec, ok := j.m[id]
	return rec, ok
}

// Set 写入记录；id 已存在时原位替换（保持插入序位置）。
func (j *Journal) Set(id string, rec *JournalRecord) {
	if j.m == nil {
		j.m = map[string]*JournalRecord{}
	}
	if _, exists := j.m[id]; !exists {
		j.order = append(j.order, id)
	}
	j.m[id] = rec
}

// Delete 删除记录（不存在时无操作）。
func (j *Journal) Delete(id string) {
	delete(j.m, id)
	for i, key := range j.order {
		if key == id {
			j.order = append(j.order[:i], j.order[i+1:]...)
			return
		}
	}
}

// Each 按插入序遍历账本快照；遍历中删除条目是安全的。
func (j *Journal) Each(fn func(id string, rec *JournalRecord)) {
	ids := append([]string(nil), j.order...)
	for _, id := range ids {
		rec, ok := j.m[id]
		if !ok {
			continue
		}
		fn(id, rec)
	}
}

// DiffOptions 对应 journal.ts:34-42：比较两份条目配置，返回键级差异（不含 id）。
// 值取 options 侧；options 侧缺失的键记为 nil（表示应用时删除）。
func DiffOptions(legacy, options *loader.EntryOptions) map[string]any {
	changes := map[string]any{}
	seen := map[string]bool{}
	for _, key := range append(loader.KeysOf(legacy), loader.KeysOf(options)...) {
		if key == "id" || seen[key] {
			continue
		}
		seen[key] = true
		lv, _ := loader.GetKey(legacy, key)
		ov, _ := loader.GetKey(options, key)
		if valueEqual(lv, ov) {
			continue
		}
		changes[key] = ov
	}
	return changes
}

// MergeRecords 对应 journal.ts:45-62：把同一条目的后续记录折叠进先前记录。
// 返回 nil 表示两条相互抵消（创建后未写盘即被移除，不留痕迹）。
func MergeRecords(older, newer *JournalRecord) *JournalRecord {
	if older == nil {
		return newer
	}
	if newer.Kind == KindRemove {
		// 创建后未写盘即移除的条目不落任何痕迹
		if older.Kind == KindUpsert && older.Created {
			return nil
		}
		return newer
	}
	if older.Kind == KindRemove {
		cp := *newer
		cp.Created = false
		return &cp
	}
	rec := &JournalRecord{
		Kind:    KindUpsert,
		Created: older.Created,
		Parent:  older.Parent,
		Changes: map[string]any{},
	}
	// 仅当后续记录确实迁移了条目时才覆盖位置信息
	if newer.Parent != nil {
		rec.Parent = newer.Parent
		rec.Position = newer.Position
	} else {
		rec.Position = older.Position
	}
	for k, v := range older.Changes {
		rec.Changes[k] = v
	}
	for k, v := range newer.Changes {
		rec.Changes[k] = v
	}
	return rec
}

// MergeJournal 对应 journal.ts:64-71：折叠后写入或删除账本记录。
func MergeJournal(j *Journal, id string, rec *JournalRecord) {
	if merged := MergeRecords(j.m[id], rec); merged != nil {
		j.Set(id, merged)
	} else {
		j.Delete(id)
	}
}

// Record 对应 journal.ts:73-89：把树侧 commit 同步报告的一条变更记入账本。
// parent 两态：nil=根。
func Record(j *Journal, change loader.EntryChange, parent *string) {
	if change.Options == nil {
		MergeJournal(j, change.ID, &JournalRecord{Kind: KindRemove})
		return
	}
	position := change.Position
	if change.Legacy == nil {
		MergeJournal(j, change.ID, &JournalRecord{
			Kind:     KindUpsert,
			Created:  true,
			Parent:   rooted(parent),
			Position: position,
			Changes:  omitOptions(change.Options),
		})
		return
	}
	// from 为空表示条目未迁移，账本记 nil（undefined）
	var relocated *string
	if change.From != nil {
		relocated = rooted(parent)
	}
	MergeJournal(j, change.ID, &JournalRecord{
		Kind:     KindUpsert,
		Created:  false,
		Parent:   relocated,
		Position: position,
		Changes:  DiffOptions(change.Legacy, change.Options),
	})
}

// FlatEntry 对应 journal.ts:91-96：flatten 索引出的一条条目。
// Parent 三态：根为指向 ""。List 是展平时所在列表的堆上快照，仅供检视；
// Go 的值语义下对快照的写不会回写，结构变更须走 Detach/Place/ApplyJournal。
type FlatEntry struct {
	Parent   *string
	Position int
	Options  *loader.EntryOptions
	List     *[]*loader.EntryOptions
}

// Flatten 对应 journal.ts:99-107：按 id 索引所有条目（含嵌套组成员）。
// parent 两态：nil=根。无 id 的条目不入索引；嵌套组无 id 时其成员按根登记。
func Flatten(data []*loader.EntryOptions, parent *string) map[string]*FlatEntry {
	result := map[string]*FlatEntry{}
	flattenInto(result, data, parent)
	return result
}

func flattenInto(result map[string]*FlatEntry, data []*loader.EntryOptions, parent *string) {
	slot := new([]*loader.EntryOptions)
	*slot = data
	for position, options := range data {
		if options == nil {
			continue
		}
		if options.ID != "" {
			result[options.ID] = &FlatEntry{
				Parent:   rooted(parent),
				Position: position,
				Options:  options,
				List:     slot,
			}
		}
		if options.Group != nil && *options.Group {
			if list, ok := entriesOf(options); ok {
				var nested *string
				if options.ID != "" {
					nested = &options.ID
				}
				flattenInto(result, list, nested)
			}
		}
	}
}

// ApplyChanges 对应 journal.ts:109-118：把键级变更应用到条目；
// 值为 nil 表示删除该键；filter 为 nil 时不过滤。
func ApplyChanges(o *loader.EntryOptions, changes map[string]any, filter func(string) bool) {
	for key, value := range changes {
		if filter != nil && !filter(key) {
			continue
		}
		if value == nil {
			loader.SetKey(o, key, nil)
		} else {
			loader.SetKey(o, key, normalizeValue(key, copyPlainValue(value)))
		}
	}
}

// Detach 从所在列表移除条目，并显式返回更新后的根切片和移除的条目。
func Detach(data []*loader.EntryOptions, id string) ([]*loader.EntryOptions, *loader.EntryOptions) {
	flat := Flatten(data, nil)[id]
	if flat == nil {
		return data, nil
	}
	return detachFromContainer(data, flat.Options), flat.Options
}

// Place 把条目插入指定父组并返回更新后的根切片；父组无效时返回 false。
func Place(data []*loader.EntryOptions, o *loader.EntryOptions, parent *string, position int) ([]*loader.EntryOptions, bool) {
	return placeInto(data, o, parent, position)
}

// placeInto 是 Place 的内部形态：根级插入经返回值回传新列表。
func placeInto(data []*loader.EntryOptions, o *loader.EntryOptions, parent *string, position int) ([]*loader.EntryOptions, bool) {
	if parent == nil {
		return spliceInsert(data, position, o), true
	}
	group := Flatten(data, nil)[*parent]
	if group == nil || group.Options == nil || group.Options.Group == nil || !*group.Options.Group {
		return data, false
	}
	list := ensureList(group.Options)
	setList(group.Options, spliceInsert(list, position, o))
	return data, true
}

// ApplyJournal 对应 journal.ts:148-180：把账本就地叠加到 data 上，返回
// （可能更新了长度的）根列表。filter(id, key) 限定哪些变更可以应用——
// key 为 nil 时问询整条目（创建、移除、迁移）；warn 为 nil 时丢弃告警。
func ApplyJournal(data []*loader.EntryOptions, j *Journal, filter func(id string, key *string) bool, warn Warn) []*loader.EntryOptions {
	if filter == nil {
		filter = func(string, *string) bool { return true }
	}
	j.Each(func(id string, rec *JournalRecord) {
		if !filter(id, nil) {
			return
		}
		if rec.Kind == KindRemove {
			if flat := Flatten(data, nil)[id]; flat != nil {
				data = detachFromContainer(data, flat.Options)
			}
			return
		}
		flat := Flatten(data, nil)[id]
		if flat == nil {
			options := &loader.EntryOptions{ID: id}
			ApplyChanges(options, rec.Changes, func(key string) bool { return filter(id, &key) })
			updated, ok := placeInto(data, options, placeParent(rec.Parent), rec.Position)
			if !ok {
				warnf(warn, "无法放置条目 %q：找不到组 %q", id, parentName(rec.Parent))
				return
			}
			data = updated
			return
		}
		ApplyChanges(flat.Options, rec.Changes, func(key string) bool { return filter(id, &key) })
		if rec.Parent != nil && !sameParent(flat.Parent, rec.Parent) {
			data = detachFromContainer(data, flat.Options)
			updated, ok := placeInto(data, flat.Options, placeParent(rec.Parent), rec.Position)
			if !ok {
				warnf(warn, "无法移动条目 %q：找不到组 %q", id, parentName(rec.Parent))
				// 放不进目标组就放回原位（TS 的回退路径，不再告警）
				data, _ = placeInto(data, flat.Options, placeParent(flat.Parent), flat.Position)
				return
			}
			data = updated
		}
	})
	return data
}

// Conflict 对应 journal.ts:182-185：一次三方调和冲突的上报。
type Conflict struct {
	ID     string
	Reason string
}

// Reconcile 对应 journal.ts:195-242：账本对新文件状态的三方调和，文件在一切
// 冲突中获胜——冲突键从账本移除并逐条上报，使树跟随文件。fileOwned(id, key)
// 限定检查范围（补丁持有的键与补丁插入的条目不归文件表达）；key 为 nil 时
// 问询整条目。账本被就地修改。
func Reconcile(j *Journal, base, theirs map[string]*FlatEntry, fileOwned func(id string, key *string) bool) []Conflict {
	var conflicts []Conflict
	j.Each(func(id string, rec *JournalRecord) {
		if !fileOwned(id, nil) {
			return
		}
		b, t := base[id], theirs[id]
		if rec.Kind == KindRemove {
			switch {
			case t == nil:
				// 文件也没有了：移除意图达成，静默出账
				j.Delete(id)
			case b == nil:
				conflicts = append(conflicts, Conflict{ID: id, Reason: "文件中新增，运行时已移除"})
				j.Delete(id)
			case !entryEqual(t.Options, b.Options):
				conflicts = append(conflicts, Conflict{ID: id, Reason: "文件中已修改，运行时已移除"})
				j.Delete(id)
			}
			return
		}
		if t == nil {
			if b != nil {
				conflicts = append(conflicts, Conflict{ID: id, Reason: "文件中已移除，运行时已修改"})
				j.Delete(id)
			}
			// 运行时创建、文件尚无此条目：没有可冲突的对象
			return
		}
		if rec.Created {
			rec.Created = false
		}
		for _, key := range sortedKeys(rec.Changes) {
			if !fileOwned(id, &key) {
				continue
			}
			var bv any
			if b != nil && b.Options != nil {
				bv, _ = loader.GetKey(b.Options, key)
			}
			var tv any
			if t.Options != nil {
				tv, _ = loader.GetKey(t.Options, key)
			}
			if valueEqual(bv, tv) || valueEqual(tv, rec.Changes[key]) {
				continue
			}
			conflicts = append(conflicts, Conflict{
				ID:     id,
				Reason: fmt.Sprintf("键 %q 在文件与运行时同时被修改", key),
			})
			delete(rec.Changes, key)
		}
		if rec.Parent != nil && b != nil && !sameParent(t.Parent, b.Parent) && !sameParent(t.Parent, rec.Parent) {
			conflicts = append(conflicts, Conflict{ID: id, Reason: "文件与运行时同时移动了条目"})
			rec.Parent = nil
		}
		moved := rec.Parent != nil && !sameParent(rec.Parent, t.Parent)
		if len(rec.Changes) == 0 && !moved {
			j.Delete(id)
		}
	})
	return conflicts
}

// —— 以下为机制层内部辅助 ——

// rooted 把两态 parent（nil=根）转成账本三态形态（根=指向 ""）。
func rooted(parent *string) *string {
	if parent == nil {
		empty := ""
		return &empty
	}
	return parent
}

// placeParent 把三态 parent 规约成 Place 形参的两态（nil=根）。
func placeParent(parent *string) *string {
	if parent == nil || *parent == "" {
		return nil
	}
	return parent
}

// parentName 取父组名（根为空串），仅用于比较与告警文案。
func parentName(parent *string) string {
	if parent == nil {
		return ""
	}
	return *parent
}

// sameParent 比较两个父组指针的取值（nil 与指向 "" 都视为根）。
func sameParent(a, b *string) bool {
	return parentName(a) == parentName(b)
}

// warnf 是告警通道的 nil 安全包装。
func warnf(warn Warn, format string, args ...any) {
	if warn != nil {
		warn(format, args...)
	}
}

// sortedKeys 取 map 键的确定序快照（Go map 遍历无序，冲突上报需可复现）。
func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// indexOfOptions 按指针身份查找条目在列表中的位置（TS Array.indexOf）。
func indexOfOptions(data []*loader.EntryOptions, o *loader.EntryOptions) int {
	for i, item := range data {
		if item == o {
			return i
		}
	}
	return -1
}

// omitOptions 对应 cosmokit 的 omit(options, ['id'])：取除 id 外的全部在场键。
func omitOptions(o *loader.EntryOptions) map[string]any {
	changes := map[string]any{}
	for _, key := range loader.KeysOf(o) {
		if key == "id" {
			continue
		}
		v, _ := loader.GetKey(o, key)
		changes[key] = v
	}
	return changes
}

// spliceInsert 在 min(position, len) 处插入条目（TS splice 的正数语义；
// 机制层的 position 总来自实时 indexOf（非负），负值收敛到 0）。
func spliceInsert(list []*loader.EntryOptions, position int, o *loader.EntryOptions) []*loader.EntryOptions {
	if position > len(list) {
		position = len(list)
	}
	if position < 0 {
		position = 0
	}
	list = append(list, nil)
	copy(list[position+1:], list[position:])
	list[position] = o
	return list
}

// spliceOutInPlace 在列表容器内按指针移除条目并回传：根级经 slot（指向
// 调用方列表），嵌套级经父组条目的 Config。返回是否找到并移除。
func spliceOutInPlace(slot *[]*loader.EntryOptions, o *loader.EntryOptions) bool {
	for i, item := range *slot {
		if item == o {
			*slot = append((*slot)[:i], (*slot)[i+1:]...)
			return true
		}
	}
	for _, entry := range *slot {
		if entry == nil || entry.Group == nil || !*entry.Group {
			continue
		}
		list, ok := entriesOf(entry)
		if !ok {
			continue
		}
		if spliceOutInPlace(&list, o) {
			setList(entry, list)
			return true
		}
	}
	return false
}

// detachFromContainer 是 Detach 的容器内实现：返回移除后的根列表
// （嵌套列表的变更已经过父组 Config 回传）。
func detachFromContainer(data []*loader.EntryOptions, o *loader.EntryOptions) []*loader.EntryOptions {
	spliceOutInPlace(&data, o)
	return data
}

// listOf 读取组条目的成员列表；兼容 []*EntryOptions、*[]*EntryOptions 与
// []any（YAML/JSON 原生解析产物，元素可为 *EntryOptions 或 map[string]any）。
func listOf(o *loader.EntryOptions) ([]*loader.EntryOptions, bool) {
	switch v := o.Config.(type) {
	case []*loader.EntryOptions:
		return v, true
	case *[]*loader.EntryOptions:
		return *v, true
	case []any:
		list := make([]*loader.EntryOptions, 0, len(v))
		for _, item := range v {
			e, ok := asEntryOptions(item)
			if !ok {
				return nil, false
			}
			list = append(list, e)
		}
		return list, true
	}
	return nil, false
}

// entriesOf 读取成员列表并保证规范化回填：列表以 canonical 的 []*EntryOptions
// 形态存放（[]any 原生产物在首次读取时转换并回写），此后一切就地变更都落在
// canonical 对象上、经 Config 回传。
func entriesOf(o *loader.EntryOptions) ([]*loader.EntryOptions, bool) {
	if list, ok := listOf(o); ok {
		setList(o, list)
		return list, true
	}
	return nil, false
}

// ensureList 对应 TS 的 config ??= []：读取成员列表，缺失时建空列表并回填。
func ensureList(o *loader.EntryOptions) []*loader.EntryOptions {
	if list, ok := entriesOf(o); ok {
		return list
	}
	list := []*loader.EntryOptions{}
	setList(o, list)
	return list
}

// setList 把成员列表写回组条目——Go 值语义下结构变更的唯一回传通道。
// 已是指针形态时经原指针更新，保持既有别名有效。
func setList(o *loader.EntryOptions, list []*loader.EntryOptions) {
	if p, ok := o.Config.(*[]*loader.EntryOptions); ok {
		*p = list
		return
	}
	o.Config = list
}

// asEntryOptions 把原生解析产物转成条目；map 经 SetKey 逐键落位。
func asEntryOptions(v any) (*loader.EntryOptions, bool) {
	switch t := v.(type) {
	case *loader.EntryOptions:
		return t, true
	case map[string]any:
		e := &loader.EntryOptions{}
		for key, value := range t {
			loader.SetKey(e, key, normalizeValue(key, value))
		}
		return e, true
	}
	return nil, false
}

// normalizeValue 把原生标值整理成 loader.SetKey 期望的形态
// （group/disabled 的 bool → *bool；其余原样）。
func normalizeValue(key string, value any) any {
	switch key {
	case "group", "disabled":
		if b, ok := value.(bool); ok {
			return &b
		}
	}
	return value
}

// entryEqual 按键并集深比较两份条目（TS 对普通对象的 deepEqual）。
func entryEqual(a, b *loader.EntryOptions) bool {
	if a == b {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	seen := map[string]bool{}
	for _, key := range append(loader.KeysOf(a), loader.KeysOf(b)...) {
		if seen[key] {
			continue
		}
		seen[key] = true
		av, _ := loader.GetKey(a, key)
		bv, _ := loader.GetKey(b, key)
		if !valueEqual(av, bv) {
			return false
		}
	}
	return true
}

// entryEqualMap 让 *EntryOptions 与原生 map 可比（规范化前后的混合形态）。
func entryEqualMap(x *loader.EntryOptions, y map[string]any) bool {
	seen := map[string]bool{}
	for _, key := range loader.KeysOf(x) {
		seen[key] = true
		xv, _ := loader.GetKey(x, key)
		if !valueEqual(xv, y[key]) {
			return false
		}
	}
	for key := range y {
		if seen[key] {
			continue
		}
		if !nullish(y[key]) {
			return false
		}
	}
	return true
}

// valueEqual 是 cosmokit deepEqual（非严格模式）的 Go 等价物：
// null/undefined（nil 与类型化 nil）互通；数字跨整型/浮点比较（NaN 不等）；
// bool 与 *bool 互通；数组按长度逐项；对象按键并集逐值；
// *EntryOptions 与 map[string]any 结构互通。
func valueEqual(a, b any) bool {
	if a == nil || b == nil {
		return nullish(a) && nullish(b)
	}
	if x, ok := a.(*loader.EntryOptions); ok {
		if y, ok := b.(*loader.EntryOptions); ok {
			return entryEqual(x, y)
		}
		if y, ok := b.(map[string]any); ok {
			return entryEqualMap(x, y)
		}
		return false
	}
	if y, ok := b.(*loader.EntryOptions); ok {
		if x, ok := a.(map[string]any); ok {
			return entryEqualMap(y, x)
		}
		return false
	}
	ra, rb := reflect.ValueOf(a), reflect.ValueOf(b)
	if isNumberKind(ra.Kind()) && isNumberKind(rb.Kind()) {
		return numberEqual(ra, rb)
	}
	if bx, ok := asBool(a); ok {
		by, ok := asBool(b)
		return ok && bx == by
	}
	if ra.Kind() != rb.Kind() {
		return false
	}
	switch ra.Kind() {
	case reflect.Bool, reflect.String:
		return ra.Equal(rb)
	case reflect.Slice, reflect.Array:
		if ra.Len() != rb.Len() {
			return false
		}
		for i := 0; i < ra.Len(); i++ {
			if !valueEqual(ra.Index(i).Interface(), rb.Index(i).Interface()) {
				return false
			}
		}
		return true
	case reflect.Map:
		return mapEqual(ra, rb)
	case reflect.Pointer:
		return valueEqual(ra.Elem().Interface(), rb.Elem().Interface())
	default:
		return reflect.DeepEqual(a, b)
	}
}

// nullish 判断值是否为 TS 的 null/undefined 等价物（nil 或类型化 nil）。
// 空切片不是 nullish（TS 的 [] 是对象）。
func nullish(v any) bool {
	if v == nil {
		return true
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Pointer, reflect.Map, reflect.Slice, reflect.Interface, reflect.Func, reflect.Chan:
		return rv.IsNil()
	}
	return false
}

// asBool 让 bool 与 *bool 可比（*bool 为 nil 时不可比，交给 nullish 分支）。
func asBool(v any) (bool, bool) {
	switch t := v.(type) {
	case bool:
		return t, true
	case *bool:
		if t == nil {
			return false, false
		}
		return *t, true
	}
	return false, false
}

func isNumberKind(k reflect.Kind) bool {
	switch k {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64,
		reflect.Uintptr, reflect.Float32, reflect.Float64:
		return true
	}
	return false
}

func isSignedKind(k reflect.Kind) bool {
	switch k {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return true
	}
	return false
}

func numberEqual(a, b reflect.Value) bool { return kardia.NumbersEqual(a.Interface(), b.Interface()) }

// mapEqual 按键并集逐值比较；键类型不同的两侧视为互不存在。
func mapEqual(ra, rb reflect.Value) bool {
	for _, key := range ra.MapKeys() {
		if !valueEqual(mapGet(ra, key), mapGet(rb, key)) {
			return false
		}
	}
	for _, key := range rb.MapKeys() {
		if key.Type() != ra.Type().Key() || ra.MapIndex(key).IsValid() {
			continue
		}
		if !nullish(mapGet(rb, key)) {
			return false
		}
	}
	return true
}

func mapGet(m reflect.Value, key reflect.Value) any {
	if key.Type() != m.Type().Key() {
		return nil
	}
	v := m.MapIndex(key)
	if !v.IsValid() {
		return nil
	}
	return v.Interface()
}
