package include

import (
	"sort"

	"elysian/server/internal/agent/kardia/loader"
)

// Warn 对应 include/src/patch.ts 的 Warn：机制层的告警通道，格式串风格同 fmt。
type Warn func(format string, args ...any)

// PatchOptions 对应 patch.ts:5-16 的补丁形态：id 定位既有条目，insert 追加新
// 条目，name 用于一致性校验；其余一切键（config/group/disabled/inject 等，
// 含未知名键）经 OverrideKeys/GetOverride/SetOverride 三法读写。
// ID 三态：nil=未指定（insert 之外的补丁必须给，否则告警跳过；指向 "" 同样
// 视为未指定——TS 的空串为 falsy）。
type PatchOptions struct {
	ID     *string                `yaml:"id"`
	Insert []*loader.EntryOptions `yaml:"insert"`
	Name   *string                `yaml:"name"`

	overrides map[string]any
}

// CloneConfig 为配置快照复制补丁覆盖表及插入条目。
func (p PatchOptions) CloneConfig() any { return clonePatches([]PatchOptions{p})[0] }

// OverrideKeys 返回除 id/insert/name 外的全部键（确定序）。
func (p *PatchOptions) OverrideKeys() []string {
	keys := make([]string, 0, len(p.overrides))
	for key := range p.overrides {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// GetOverride 读取一个 override 键；未设置时 ok 为 false。
func (p *PatchOptions) GetOverride(key string) (any, bool) {
	v, ok := p.overrides[key]
	return v, ok
}

// SetOverride 写入一个 override 键；value 为 nil 表示删除该键
// （对齐 TS applyChanges 对 undefined 的 delete 语义）。
func (p *PatchOptions) SetOverride(key string, value any) {
	if p.overrides == nil {
		p.overrides = map[string]any{}
	}
	if value == nil {
		delete(p.overrides, key)
		return
	}
	p.overrides[key] = value
}

// randomID 对应 patch.ts:20-26：循环取新 id 直到未占用（id 生成器注入以便测试）。
func randomID(used func(string) bool, mk func() string) string {
	for {
		id := mk()
		if !used(id) {
			return id
		}
	}
}

// EnsureIDs 对应 patch.ts:29-34：为每个条目（含嵌套组成员）就地补 id。
func EnsureIDs(entries []*loader.EntryOptions, used func(string) bool, mk func() string) {
	for _, entry := range entries {
		if entry == nil {
			continue
		}
		if entry.ID == "" {
			entry.ID = randomID(used, mk)
		}
		if entry.Group != nil && *entry.Group {
			if list, ok := entriesOf(entry); ok {
				EnsureIDs(list, used, mk)
			}
		}
	}
}

// EnsureInsertIds 对应 patch.ts:37-41：运行时变更经 id 路由回插入条目，
// 因此每段 insert 都要有 id。
func EnsureInsertIDs(patches []PatchOptions, used func(string) bool, mk func() string) {
	for i := range patches {
		if patches[i].Insert != nil {
			EnsureIDs(patches[i].Insert, used, mk)
		}
	}
}

// ApplyPatches 对应 patch.ts:47-109：把补丁叠加到 data 的深拷贝上并返回；
// 插入的条目同样被深拷贝，树持有它挂载的每个对象。warn 为 nil 时丢弃告警。
func ApplyPatches(data []*loader.EntryOptions, patches []PatchOptions, warn Warn) []*loader.EntryOptions {
	data = cloneList(data)
	if len(patches) == 0 {
		return data
	}

	entryMap := map[string]*loader.EntryOptions{}
	var buildMap func(entries []*loader.EntryOptions)
	buildMap = func(entries []*loader.EntryOptions) {
		for _, entry := range entries {
			if entry == nil {
				continue
			}
			if entry.ID != "" {
				entryMap[entry.ID] = entry
			}
			if entry.Group != nil && *entry.Group {
				if list, ok := entriesOf(entry); ok {
					buildMap(list)
				}
			}
		}
	}
	buildMap(data)

	for i := range patches {
		patch := &patches[i]
		if patch.Insert != nil {
			clone := cloneList(patch.Insert)
			if patch.ID != nil && *patch.ID != "" {
				target := entryMap[*patch.ID]
				if target == nil {
					warnf(warn, "补丁 insert：找不到条目 %q", *patch.ID)
					continue
				}
				if target.Group == nil || !*target.Group {
					warnf(warn, "补丁 insert：条目 %q 不是组", *patch.ID)
					continue
				}
				list := ensureList(target)
				setList(target, append(list, clone...))
			} else {
				data = append(data, clone...)
			}
			buildMap(clone)
			continue
		}

		if patch.ID == nil || *patch.ID == "" {
			warnf(warn, "补丁：非 insert 补丁必须提供 id")
			continue
		}

		target := entryMap[*patch.ID]
		if target == nil {
			warnf(warn, "补丁：找不到条目 %q", *patch.ID)
			continue
		}

		if patch.Name != nil && *patch.Name != "" && *patch.Name != target.Name {
			warnf(warn, "补丁：条目 %q 名称不匹配（期望 %q，实际 %q），跳过", *patch.ID, target.Name, *patch.Name)
			continue
		}

		for _, key := range patch.OverrideKeys() {
			if key == "id" {
				continue
			}
			value, _ := patch.GetOverride(key)
			loader.SetKey(target, key, normalizeValue(key, value))
		}
	}

	return data
}

// EntryOwnerKind 对应 patch.ts EntryOwner 的 type 字段。
type EntryOwnerKind string

const (
	// OwnerFile 表示条目（或键）由文件表达。
	OwnerFile EntryOwnerKind = "file"
	// OwnerPatch 表示键由某个覆盖它的补丁表达（最后一个生效）。
	OwnerPatch EntryOwnerKind = "patch"
	// OwnerInsert 表示整个条目由某段 insert 插入。
	OwnerInsert EntryOwnerKind = "insert"
)

// EntryOwner 对应 patch.ts:116-139：补丁视角下条目（或其某个键）的归属。
// List 是建索引时所在 insert 列表的快照；结构变更经 patches[Index].Insert
// 或父组条目的 Config 回传。Parent 三态：根为指向 ""。
type EntryOwner struct {
	Kind    EntryOwnerKind
	Index   int
	List    *[]*loader.EntryOptions
	Options *loader.EntryOptions
	Parent  *string
}

// PatchIndex 对应 patch.ts:141-184：补丁列表的归属索引。
type PatchIndex struct {
	patches []PatchOptions
	keys    map[string]map[string]int
	inserts map[string]EntryOwner
}

// NewPatchIndex 建索引：insert 条目按 id 登记（含嵌套组成员，父组取其 id，
// 无 id 时按根）；非 insert 补丁按 OverrideKeys 登记键到最后写它的补丁下标。
// 无 id 的 insert 条目不入索引（TS 以 undefined 为键存入但永不被查到）。
func NewPatchIndex(patches []PatchOptions) *PatchIndex {
	pi := &PatchIndex{
		patches: patches,
		keys:    map[string]map[string]int{},
		inserts: map[string]EntryOwner{},
	}
	for index := range patches {
		patch := &patches[index]
		if patch.Insert != nil {
			walkInserts(pi.inserts, patch.Insert, patch.ID, index)
			continue
		}
		if patch.ID == nil || *patch.ID == "" {
			continue
		}
		keys := pi.keys[*patch.ID]
		if keys == nil {
			keys = map[string]int{}
			pi.keys[*patch.ID] = keys
		}
		for _, key := range patch.OverrideKeys() {
			keys[key] = index
		}
	}
	return pi
}

func walkInserts(inserts map[string]EntryOwner, list []*loader.EntryOptions, parent *string, index int) {
	slot := new([]*loader.EntryOptions)
	*slot = list
	for _, options := range list {
		if options == nil {
			continue
		}
		if options.ID != "" {
			inserts[options.ID] = EntryOwner{
				Kind:    OwnerInsert,
				Index:   index,
				List:    slot,
				Options: options,
				Parent:  rooted(parent),
			}
		}
		if options.Group != nil && *options.Group {
			if nested, ok := entriesOf(options); ok {
				var next *string
				if options.ID != "" {
					next = &options.ID
				}
				walkInserts(inserts, nested, next, index)
			}
		}
	}
}

// Entry 返回条目整体的归属。id 两态：nil=根（恒为文件）。
func (pi *PatchIndex) Entry(id *string) EntryOwner {
	if id == nil {
		return EntryOwner{Kind: OwnerFile}
	}
	if owner, ok := pi.inserts[*id]; ok {
		return owner
	}
	return EntryOwner{Kind: OwnerFile}
}

// Key 返回条目某个键的归属。
func (pi *PatchIndex) Key(id, key string) EntryOwner {
	if insert, ok := pi.inserts[id]; ok {
		return insert
	}
	if index, ok := pi.keys[id][key]; ok {
		return EntryOwner{Kind: OwnerPatch, Index: index}
	}
	return EntryOwner{Kind: OwnerFile}
}

// FileOwned 判断条目（或其某个键）是否由文件表达；key 为 nil 时问询整条目。
func (pi *PatchIndex) FileOwned(id string, key *string) bool {
	var owner EntryOwner
	if key == nil {
		owner = pi.Entry(&id)
	} else {
		owner = pi.Key(id, *key)
	}
	return owner.Kind == OwnerFile
}

// RouteJournal 将账本变更分别应用到文件树与补丁，返回更新后的根切片和补丁变更标志。
func RouteJournal(j *Journal, data []*loader.EntryOptions, patches []PatchOptions, warn Warn) ([]*loader.EntryOptions, bool) {
	patched := routeJournalSlot(j, &data, patches, warn)
	return data, patched
}

func routeJournalSlot(j *Journal, dataSlot *[]*loader.EntryOptions, patches []PatchOptions, warn Warn) bool {
	index := NewPatchIndex(patches)
	patched := false

	// placeAt 对应 TS 闭包：优先插入 insert 组，否则落文件数据。
	placeAt := func(options *loader.EntryOptions, parent *string, position int) {
		owner := index.Entry(parent)
		if owner.Kind == OwnerInsert {
			// 对应 TS 的 insertList(owner)：owner.options.config ??= []
			list := ensureList(owner.Options)
			setList(owner.Options, spliceInsert(list, position, options))
			patched = true
			return
		}
		updated, ok := placeInto(*dataSlot, options, parent, position)
		if !ok {
			warnf(warn, "无法放置条目 %q：找不到组 %q", options.ID, parentName(parent))
			return
		}
		*dataSlot = updated
	}

	j.Each(func(id string, rec *JournalRecord) {
		owner := index.Entry(&id)
		if rec.Kind == KindRemove {
			if owner.Kind == OwnerInsert {
				spliceOutInPlace(&patches[owner.Index].Insert, owner.Options)
				patched = true
			} else if flat := Flatten(*dataSlot, nil)[id]; flat != nil {
				*dataSlot = detachFromContainer(*dataSlot, flat.Options)
			}
			return
		}

		var currentParent *string
		var currentOptions *loader.EntryOptions
		if owner.Kind == OwnerInsert {
			currentParent = owner.Parent
			currentOptions = owner.Options
		} else if flat := Flatten(*dataSlot, nil)[id]; flat != nil {
			currentParent = flat.Parent
			currentOptions = flat.Options
		} else {
			// 条目不存在：按账本重建（对应 TS 的 flatten(data).get(id) 未命中）
			options := &loader.EntryOptions{ID: id}
			ApplyChanges(options, rec.Changes, nil)
			placeAt(options, placeParent(rec.Parent), rec.Position)
			return
		}

		if rec.Parent != nil && !sameParent(currentParent, rec.Parent) {
			// 跨归属迁移：整份配置随行
			if owner.Kind == OwnerInsert {
				spliceOutInPlace(&patches[owner.Index].Insert, owner.Options)
				patched = true
			} else {
				*dataSlot = detachFromContainer(*dataSlot, currentOptions)
			}
			ApplyChanges(currentOptions, rec.Changes, nil)
			placeAt(currentOptions, placeParent(rec.Parent), rec.Position)
			return
		}

		if owner.Kind == OwnerInsert {
			ApplyChanges(currentOptions, rec.Changes, nil)
			patched = true
			return
		}

		// 文件持有的条目：补丁覆盖的键路由回补丁，其余就地应用
		patchChanges := map[int]map[string]any{}
		ApplyChanges(currentOptions, rec.Changes, func(key string) bool {
			keyOwner := index.Key(id, key)
			if keyOwner.Kind != OwnerPatch {
				return true
			}
			if patchChanges[keyOwner.Index] == nil {
				patchChanges[keyOwner.Index] = map[string]any{}
			}
			patchChanges[keyOwner.Index][key] = rec.Changes[key]
			return false
		})
		indices := make([]int, 0, len(patchChanges))
		for i := range patchChanges {
			indices = append(indices, i)
		}
		sort.Ints(indices)
		for _, i := range indices {
			applyToPatch(&patches[i], patchChanges[i])
			patched = true
		}
	})

	return patched
}

// applyToPatch 把键级变更写进补丁：name 落到具名字段（TS 直写普通对象字段），
// 其余键进 override 表（nil 表示删除该键）。
func applyToPatch(p *PatchOptions, changes map[string]any) {
	keys := make([]string, 0, len(changes))
	for key := range changes {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		value := changes[key]
		if key == "name" {
			if s, ok := value.(string); ok {
				p.Name = &s
			} else {
				p.Name = nil
			}
			continue
		}
		p.SetOverride(key, value)
	}
}

// cloneList 是 structuredClone 的等价物：深拷贝条目列表（含嵌套组成员与
// Config 里的任意值），返回的树与源完全独立。
func cloneList(entries []*loader.EntryOptions) []*loader.EntryOptions {
	if entries == nil {
		return nil
	}
	result := make([]*loader.EntryOptions, len(entries))
	for i, entry := range entries {
		result[i] = cloneEntry(entry)
	}
	return result
}

// cloneEntry 深拷贝单个条目。CloneOptions 对嵌套成员列表的深拷贝不作假设，
// 组条目的成员列表在此统一重建，保证 insert/patch 的修改绝不触及调用方对象。
func cloneEntry(entry *loader.EntryOptions) *loader.EntryOptions {
	if entry == nil {
		return nil
	}
	clone := loader.CloneOptions(entry)
	if entry.Group != nil && *entry.Group {
		if list, ok := listOf(entry); ok {
			setList(clone, cloneList(list))
		}
	}
	return clone
}
