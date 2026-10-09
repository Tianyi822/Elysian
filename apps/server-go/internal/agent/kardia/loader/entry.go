package loader

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"sync"

	"elysian/server/internal/agent/kardia"
)

// EntryOptions 对应 loader/src/config/entry.ts:8-15（含 isolate.ts 扩展的
// intercept/isolate 与任意键）。除已命名字段外的一切键进 Extras，diff/写回/
// 键序都经 KeysOf/GetKey/SetKey 三辅助，三者覆盖具名字段与 Extras。
type EntryOptions struct {
	ID        string           `yaml:"id"`
	Name      string           `yaml:"name"`
	Config    any              `yaml:"config,omitempty"`
	Group     *bool            `yaml:"group,omitempty"`
	Disabled  *bool            `yaml:"disabled,omitempty"`
	Inject    kardia.InjectMap `yaml:"inject,omitempty"`
	Isolate   map[string]any   `yaml:"isolate,omitempty"`
	Intercept map[string]any   `yaml:"intercept,omitempty"`
	Extras    map[string]any   `yaml:",inline"`
}

// KeysOf 返回条目在场键的确定序快照：具名字段按声明序（id、name、config、
// group、disabled、inject），其余键按字典序。
func KeysOf(o *EntryOptions) []string {
	if o == nil {
		return nil
	}
	var keys []string
	if o.ID != "" {
		keys = append(keys, "id")
	}
	if o.Name != "" {
		keys = append(keys, "name")
	}
	if o.Config != nil {
		keys = append(keys, "config")
	}
	if o.Group != nil {
		keys = append(keys, "group")
	}
	if o.Disabled != nil {
		keys = append(keys, "disabled")
	}
	if o.Inject != nil {
		keys = append(keys, "inject")
	}
	if o.Isolate != nil {
		keys = append(keys, "isolate")
	}
	if o.Intercept != nil {
		keys = append(keys, "intercept")
	}
	named := len(keys)
	for key := range o.Extras {
		present := false
		for _, existing := range keys {
			if existing == key {
				present = true
				break
			}
		}
		if !present {
			keys = append(keys, key)
		}
	}
	// 具名字段之后的其余键按字典序，保证 diff/写回可复现
	sort.Strings(keys[named:])
	return keys
}

// GetKey 读取一个键；未在场时 ok 为 false。
func GetKey(o *EntryOptions, key string) (any, bool) {
	if o == nil {
		return nil, false
	}
	if raw, ok := o.Extras[key]; ok {
		return raw, true
	}
	switch key {
	case "id":
		if o.ID != "" {
			return o.ID, true
		}
		return nil, false
	case "name":
		if o.Name != "" {
			return o.Name, true
		}
		return nil, false
	case "config":
		if o.Config != nil {
			return o.Config, true
		}
		return nil, false
	case "group":
		if o.Group != nil {
			return o.Group, true
		}
		return nil, false
	case "disabled":
		if o.Disabled != nil {
			return o.Disabled, true
		}
		return nil, false
	case "isolate":
		if o.Isolate != nil {
			return o.Isolate, true
		}
		return nil, false
	case "intercept":
		if o.Intercept != nil {
			return o.Intercept, true
		}
		return nil, false
	case "inject":
		if o.Inject != nil {
			return o.Inject, true
		}
		return nil, false
	default:
		v, ok := o.Extras[key]
		return v, ok
	}
}

// SetKey 写入一个键；value 为 nil 表示删除该键（对齐 TS applyChanges 对
// undefined 的 delete 语义）。group/disabled 接受 bool 或 *bool。
func SetKey(o *EntryOptions, key string, value any) {
	if o == nil {
		return
	}
	if value != nil && !namedShapeValid(key, value) {
		if o.Extras == nil {
			o.Extras = map[string]any{}
		}
		o.Extras[key] = deepCopyValue(value)
		return
	}
	if isNamedKey(key) {
		delete(o.Extras, key)
	}
	if value == nil {
		switch key {
		case "id":
			o.ID = ""
		case "name":
			o.Name = ""
		case "config":
			o.Config = nil
		case "group":
			o.Group = nil
		case "disabled":
			o.Disabled = nil
		case "isolate":
			o.Isolate = nil
		case "intercept":
			o.Intercept = nil
		case "inject":
			o.Inject = nil
		default:
			delete(o.Extras, key)
		}
		return
	}
	switch key {
	case "id":
		o.ID = asString(value)
	case "name":
		o.Name = asString(value)
	case "config":
		o.Config = value
	case "group":
		o.Group = asBoolPtr(value)
	case "disabled":
		o.Disabled = asBoolPtr(value)
	case "isolate":
		o.Isolate, _ = deepCopyValue(value).(map[string]any)
	case "intercept":
		o.Intercept, _ = deepCopyValue(value).(map[string]any)
	case "inject":
		o.Inject = asInjectMap(value)
	default:
		if o.Extras == nil {
			o.Extras = map[string]any{}
		}
		o.Extras[key] = value
	}
}

// CloneOptions 深拷贝条目（structuredClone 等价）：具名字段与 Extras 逐键
// 深复制。含非导出字段的结构体值（如 include 的 PatchOptions）无法经反射
// 重建时通过 ConfigCloner 显式复制；其余含私有状态的非配置对象按值保留。
func CloneOptions(o *EntryOptions) *EntryOptions {
	if o == nil {
		return nil
	}
	c := &EntryOptions{
		ID:        o.ID,
		Name:      o.Name,
		Config:    deepCopyValue(o.Config),
		Group:     copyBoolPtr(o.Group),
		Disabled:  copyBoolPtr(o.Disabled),
		Inject:    copyInjectMap(o.Inject),
		Isolate:   copyMap(o.Isolate),
		Intercept: copyMap(o.Intercept),
	}
	if o.Extras != nil {
		c.Extras = make(map[string]any, len(o.Extras))
		for k, v := range o.Extras {
			c.Extras[k] = deepCopyValue(v)
		}
	}
	return c
}

// OptionsEqual 按键并集深比较两份条目（cosmokit deepEqual 的等价物）。
func OptionsEqual(a, b *EntryOptions) bool {
	if a == b {
		return true
	}
	if isNullish(a) || isNullish(b) {
		return false
	}
	seen := map[string]bool{}
	for _, key := range append(KeysOf(a), KeysOf(b)...) {
		if seen[key] {
			continue
		}
		seen[key] = true
		av, _ := GetKey(a, key)
		bv, _ := GetKey(b, key)
		if !deepValueEqual(av, bv) {
			return false
		}
	}
	return true
}

// AsEntries 把任意形态的成员列表规范化为 []*EntryOptions：兼容 []*EntryOptions、
// *[]*EntryOptions、[]any（YAML/JSON 原生解析产物，元素为 map[string]any 或
// *EntryOptions）与 nil。返回 ok=false 表示形态不可识别。
// ParseEntries 是配置数组的严格入口；未知键保真，错误的具名字段不会静默丢失。
func ParseEntries(v any) ([]*EntryOptions, error) {
	var list []*EntryOptions
	switch value := v.(type) {
	case nil:
		return nil, nil
	case []*EntryOptions:
		list = value
	case *[]*EntryOptions:
		if value == nil {
			return nil, nil
		}
		list = *value
	case []any:
		list = make([]*EntryOptions, 0, len(value))
		for i, item := range value {
			e, ok := asEntryOptions(item)
			if !ok || e == nil {
				return nil, fmt.Errorf("第 %d 个配置条目必须是对象", i+1)
			}
			list = append(list, e)
		}
	default:
		return nil, fmt.Errorf("插件配置必须是条目数组")
	}
	for i, e := range list {
		if e == nil {
			return nil, fmt.Errorf("第 %d 个配置条目为空", i+1)
		}
		if err := validateEntryShape(e); err != nil {
			return nil, fmt.Errorf("第 %d 个配置条目无效：%w", i+1, err)
		}
	}
	return list, nil
}
func AsEntries(v any) ([]*EntryOptions, bool) { list, err := ParseEntries(v); return list, err == nil }
func isNamedKey(key string) bool {
	switch key {
	case "id", "name", "config", "group", "disabled", "inject", "isolate", "intercept":
		return true
	}
	return false
}
func namedShapeValid(key string, v any) bool {
	if v == nil {
		return true
	}
	switch key {
	case "id", "name":
		_, ok := v.(string)
		return ok
	case "group", "disabled":
		switch v.(type) {
		case bool, *bool:
			return true
		}
		return false
	case "inject":
		switch value := v.(type) {
		case kardia.InjectMap, map[string]any, []string:
			return true
		case []any:
			for _, item := range value {
				if _, ok := item.(string); !ok {
					return false
				}
			}
			return true
		}
		return false
	case "isolate", "intercept":
		_, ok := v.(map[string]any)
		return ok
	}
	return true
}
func validateEntryShape(e *EntryOptions) error {
	for _, key := range KeysOf(e) {
		v, _ := GetKey(e, key)
		if _, deferred := v.(RuntimeConfigError); deferred {
			continue
		}
		if !namedShapeValid(key, v) {
			return fmt.Errorf("字段 %s 的类型无效", key)
		}
	}
	return nil
}

// asEntryOptions 把原生 map 转成条目；键经 SetKey 逐个落位（含规范化）。
func asEntryOptions(v any) (*EntryOptions, bool) {
	switch t := v.(type) {
	case nil:
		return nil, true
	case *EntryOptions:
		return t, true
	case map[string]any:
		e := &EntryOptions{}
		for key, value := range t {
			SetKey(e, key, normalizePlainValue(key, value))
		}
		return e, true
	}
	return nil, false
}

// normalizePlainValue 把原生标值整理成 SetKey 期望的形态。
func normalizePlainValue(key string, value any) any {
	switch key {
	case "group", "disabled":
		if b, ok := value.(bool); ok {
			return &b
		}
	}
	return value
}

func asString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func asBoolPtr(v any) *bool {
	switch t := v.(type) {
	case bool:
		return &t
	case *bool:
		return t
	}
	return nil
}

func copyBoolPtr(b *bool) *bool {
	if b == nil {
		return nil
	}
	c := *b
	return &c
}

func asInjectMap(v any) kardia.InjectMap {
	switch t := v.(type) {
	case []string:
		m := kardia.InjectMap{}
		for _, k := range t {
			m[k] = nil
		}
		return m
	case []any:
		m := kardia.InjectMap{}
		for _, v := range t {
			k, ok := v.(string)
			if !ok {
				return nil
			}
			m[k] = nil
		}
		return m
	case kardia.InjectMap:
		return copyInjectMap(t)
	case map[string]any:
		m := kardia.InjectMap{}
		for k, val := range t {
			m[k] = val
		}
		return m
	}
	return nil
}

func copyInjectMap(m kardia.InjectMap) kardia.InjectMap {
	if m == nil {
		return nil
	}
	c := kardia.InjectMap{}
	for k, v := range m {
		c[k] = deepCopyValue(v)
	}
	return c
}

// deepValueEqual 是 cosmokit deepEqual（非严格模式）的 loader 侧等价物：
// null/undefined（nil 与类型化 nil）互通；数字跨整型/浮点（NaN 不等）；
// bool 与 *bool 互通；数组按长度逐项；对象按键并集逐值；*EntryOptions
// 经 OptionsEqual 递归。与 include 包的 valueEqual 语义一致（两侧互不
// import，各自持有一份）。
func deepValueEqual(a, b any) bool {
	if a == nil || b == nil {
		return isNullish(a) && isNullish(b)
	}
	if x, ok := a.(*EntryOptions); ok {
		if y, ok := b.(*EntryOptions); ok {
			return OptionsEqual(x, y)
		}
		if y, ok := b.(map[string]any); ok {
			return optionsEqualMap(x, y)
		}
		return false
	}
	if y, ok := b.(*EntryOptions); ok {
		if x, ok := a.(map[string]any); ok {
			return optionsEqualMap(y, x)
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
			if !deepValueEqual(ra.Index(i).Interface(), rb.Index(i).Interface()) {
				return false
			}
		}
		return true
	case reflect.Map:
		return mapDeepEqual(ra, rb)
	case reflect.Pointer:
		return deepValueEqual(ra.Elem().Interface(), rb.Elem().Interface())
	default:
		return reflect.DeepEqual(a, b)
	}
}

// optionsEqualMap 让 *EntryOptions 与原生 map 可比。
func optionsEqualMap(x *EntryOptions, y map[string]any) bool {
	seen := map[string]bool{}
	for _, key := range KeysOf(x) {
		seen[key] = true
		xv, _ := GetKey(x, key)
		if !deepValueEqual(xv, y[key]) {
			return false
		}
	}
	for key := range y {
		if seen[key] {
			continue
		}
		if !isNullish(y[key]) {
			return false
		}
	}
	return true
}

func isNullish(v any) bool {
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

func mapDeepEqual(ra, rb reflect.Value) bool {
	for _, key := range ra.MapKeys() {
		if !deepValueEqual(mapValue(ra, key), mapValue(rb, key)) {
			return false
		}
	}
	for _, key := range rb.MapKeys() {
		if key.Type() != ra.Type().Key() || ra.MapIndex(key).IsValid() {
			continue
		}
		if !isNullish(mapValue(rb, key)) {
			return false
		}
	}
	return true
}

func mapValue(m reflect.Value, key reflect.Value) any {
	if key.Type() != m.Type().Key() {
		return nil
	}
	v := m.MapIndex(key)
	if !v.IsValid() {
		return nil
	}
	return v.Interface()
}

// deepCopyValue 经反射深复制纯数据值；含非导出字段的结构体按值共享
// （见 CloneOptions 注释）。
func deepCopyValue(v any) any {
	if v == nil || isNullish(v) {
		return v
	}
	out := copyReflect(reflect.ValueOf(v))
	if !out.IsValid() || !out.CanInterface() {
		return v
	}
	return out.Interface()
}

// ConfigCloner 允许配置类型显式深复制其非导出字段。返回值必须保持动态类型。
type ConfigCloner interface{ CloneConfig() any }

func copyReflect(rv reflect.Value) reflect.Value {
	if rv.Kind() == reflect.Pointer && rv.IsNil() {
		return rv
	}
	if rv.CanInterface() {
		if cloner, ok := rv.Interface().(ConfigCloner); ok {
			copy := reflect.ValueOf(cloner.CloneConfig())
			if copy.IsValid() && copy.Type().AssignableTo(rv.Type()) {
				return copy
			}
		}
	}
	switch rv.Kind() {
	case reflect.Interface:
		if rv.IsNil() {
			return rv
		}
		out := reflect.New(rv.Type()).Elem()
		out.Set(copyReflect(rv.Elem()))
		return out
	case reflect.Array:
		out := reflect.New(rv.Type()).Elem()
		for i := 0; i < rv.Len(); i++ {
			out.Index(i).Set(copyReflect(rv.Index(i)))
		}
		return out
	case reflect.Map:
		if rv.IsNil() {
			return rv
		}
		m := reflect.MakeMapWithSize(rv.Type(), rv.Len())
		iter := rv.MapRange()
		for iter.Next() {
			m.SetMapIndex(copyReflect(iter.Key()), copyReflect(iter.Value()))
		}
		return m
	case reflect.Slice:
		if rv.IsNil() {
			return rv
		}
		s := reflect.MakeSlice(rv.Type(), rv.Len(), rv.Len())
		for i := 0; i < rv.Len(); i++ {
			s.Index(i).Set(copyReflect(rv.Index(i)))
		}
		return s
	case reflect.Pointer:
		if rv.IsNil() {
			return rv
		}
		np := reflect.New(rv.Type().Elem())
		np.Elem().Set(copyReflect(rv.Elem()))
		return np
	case reflect.Struct:
		if !structCopyable(rv.Type()) {
			return rv
		}
		ns := reflect.New(rv.Type()).Elem()
		for i := 0; i < rv.NumField(); i++ {
			if !ns.Field(i).CanSet() {
				return rv
			}
			ns.Field(i).Set(copyReflect(rv.Field(i)))
		}
		return ns
	default:
		return rv
	}
}

func structCopyable(t reflect.Type) bool {
	for i := 0; i < t.NumField(); i++ {
		if !t.Field(i).IsExported() {
			return false
		}
	}
	return true
}

func copyMap(m map[string]any) map[string]any {
	if m == nil {
		return nil
	}
	return deepCopyValue(m).(map[string]any)
}

// EntryPatch 将缺省、显式设置（含空值）和删除区分开。Unset 在 Set 之后应用。
type EntryPatch struct {
	Set   map[string]any
	Unset []string
}

// PatchOptions 将具名配置转换为补丁；删除请直接使用 EntryPatch.Unset。
func PatchOptions(o EntryOptions) EntryPatch {
	p := EntryPatch{Set: map[string]any{}}
	for _, k := range KeysOf(&o) {
		v, _ := GetKey(&o, k)
		if v == nil {
			p.Unset = append(p.Unset, k)
		} else {
			p.Set[k] = deepCopyValue(v)
		}
	}
	return p
}
func (p EntryPatch) apply(o *EntryOptions) error {
	for k, v := range p.Set {
		if k == "id" {
			return fmt.Errorf("条目 ID 不可修改")
		}
		SetKey(o, k, deepCopyValue(v))
	}
	for _, k := range p.Unset {
		if k == "id" {
			return fmt.Errorf("条目 ID 不可删除")
		}
		SetKey(o, k, nil)
	}
	return validateEntryShape(o)
}

// RuntimeConfigError 由不能执行的配置节点实现（例如保真读取的 !js 表达式）。
type RuntimeConfigError interface{ RuntimeConfigError() error }

func validateRuntime(v any) error {
	if o, ok := v.(*EntryOptions); ok && o != nil && o.Disabled != nil && *o.Disabled {
		return nil
	}
	if v == nil {
		return nil
	}
	if unsupported, ok := v.(RuntimeConfigError); ok {
		return unsupported.RuntimeConfigError()
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Interface, reflect.Pointer:
		if !rv.IsNil() {
			return validateRuntime(rv.Elem().Interface())
		}
	case reflect.Slice, reflect.Array:
		for i := 0; i < rv.Len(); i++ {
			if err := validateRuntime(rv.Index(i).Interface()); err != nil {
				return err
			}
		}
	case reflect.Map:
		it := rv.MapRange()
		for it.Next() {
			if err := validateRuntime(it.Value().Interface()); err != nil {
				return err
			}
		}
	case reflect.Struct:
		for i := 0; i < rv.NumField(); i++ {
			if rv.Field(i).CanInterface() {
				if err := validateRuntime(rv.Field(i).Interface()); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// Entry 的可变状态由树族 state.mu 保护；opMu 仅串行运行时调和，回调不持状态锁。
type Entry struct {
	Loader          *Loader
	Ctx             *kardia.Context
	state           *treeState
	opMu            sync.Mutex
	task            *entryTask
	running         bool
	runningRevision uint64
	runningOptions  *EntryOptions
	runningParent   *EntryGroup
	restartRequired bool
	notifying       bool
	settledRevision uint64
	options         *EntryOptions
	parent          *EntryGroup
	fiber           *kardia.Fiber
	subgroup        *EntryGroup
	subtree         *EntryTree
	removed         bool
	initialized     bool
	revision        uint64
	appliedRevision uint64
	applied         *EntryOptions
	local           map[string]*kardia.Symbol
	realms          map[string]string
}

func (e *Entry) Options() *EntryOptions {
	e.state.mu.RLock()
	defer e.state.mu.RUnlock()
	return CloneOptions(e.options)
}
func (e *Entry) Parent() *EntryGroup  { e.state.mu.RLock(); defer e.state.mu.RUnlock(); return e.parent }
func (e *Entry) Fiber() *kardia.Fiber { e.state.mu.RLock(); defer e.state.mu.RUnlock(); return e.fiber }
func (e *Entry) Subgroup() *EntryGroup {
	e.state.mu.RLock()
	defer e.state.mu.RUnlock()
	return e.subgroup
}
func (e *Entry) Subtree() *EntryTree {
	e.state.mu.RLock()
	defer e.state.mu.RUnlock()
	return e.subtree
}
func (e *Entry) ID() string { e.state.mu.RLock(); defer e.state.mu.RUnlock(); return e.idLocked() }
func (e *Entry) idLocked() string {
	id := e.options.ID
	if e.parent != nil {
		if owner := EntryOf(e.parent.Tree().Ctx); owner != nil && owner != e {
			return owner.idLocked() + TreeSep + id
		}
	}
	return id
}
func (e *Entry) Disabled() bool {
	e.state.mu.RLock()
	defer e.state.mu.RUnlock()
	return e.disabledLocked()
}
func (e *Entry) disabledLocked() bool {
	if e.options.Group != nil && *e.options.Group {
		return false
	}
	for cur := e; cur != nil; {
		if cur.options.Disabled != nil && *cur.options.Disabled {
			return true
		}
		if cur.parent == nil {
			break
		}
		cur = EntryOf(cur.parent.Ctx)
	}
	return false
}
func (e *Entry) Refresh(ctx context.Context) error { return e.reconcile(ctx) }
func (e *Entry) Init(ctx context.Context) error    { return e.reconcile(ctx) }

// entryTask 是一次合并调和的完成句柄。等待取消不取消已接纳的配置意向。
type entryTask struct {
	done chan struct{}
	err  error
}

func (t *entryTask) Wait(ctx context.Context) error {
	select {
	case <-t.done:
		return t.err
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (e *Entry) ensureTaskLocked() *entryTask {
	if e.task != nil {
		select {
		case <-e.task.done:
		default:
			return e.task
		}
	}
	e.task = &entryTask{done: make(chan struct{})}
	return e.task
}
func (e *Entry) pendingTask() *entryTask {
	e.state.mu.RLock()
	defer e.state.mu.RUnlock()
	if e.task != nil {
		select {
		case <-e.task.done:
		default:
			return e.task
		}
	}
	return nil
}
func (e *Entry) reconcile(ctx context.Context) error { return e.submitReconcile().Wait(ctx) }
func (e *Entry) submitReconcile() *entryTask {
	e.state.mu.Lock()
	task := e.ensureTaskLocked()
	start := !e.running
	fiber := e.fiber
	interrupt := e.running && runtimeChanged(e.runningOptions, e.options, e.runningParent, e.parent)
	if start {
		e.running = true
		e.runningRevision = e.revision
		e.runningOptions = CloneOptions(e.options)
		e.runningParent = e.parent
	}
	if interrupt && fiber != nil && fiber.CancelLoading() {
		e.restartRequired = true
	}
	e.state.mu.Unlock()
	if start {
		e.Ctx.Tasks().Go(func() {
			for {
				e.state.mu.RLock()
				revision := e.revision
				e.state.mu.RUnlock()
				err := e.run(context.Background())
				e.state.mu.Lock()
				if e.revision != revision && e.appliedRevision != e.revision {
					e.state.mu.Unlock()
					continue
				}
				e.notifying = true
				e.settledRevision = e.revision
				e.state.mu.Unlock()
				_, notifyErr := e.Ctx.Reflect().Notify(e.Ctx, []string{"loader"})
				e.state.mu.Lock()
				e.notifying = false
				if e.revision != e.settledRevision {
					e.state.mu.Unlock()
					continue
				}
				e.running = false
				task := e.task
				task.err = errors.Join(err, notifyErr)
				close(task.done)
				e.state.mu.Unlock()
				return
			}
		})
	}
	return task
}

func (e *Entry) run(ctx context.Context) error {
	e.opMu.Lock()
	defer e.opMu.Unlock()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		e.state.mu.Lock()
		e.runningRevision = e.revision
		options, parent, fiber, revision := CloneOptions(e.options), e.parent, e.fiber, e.revision
		e.runningOptions = options
		e.runningParent = parent
		restartRequired := e.restartRequired
		removed, disabled, initialized, applied := e.removed, e.disabledLocked(), e.initialized, e.appliedRevision
		e.state.mu.Unlock()
		if removed || disabled {
			if fiber != nil {
				if err := fiber.Dispose(ctx); err != nil {
					return err
				}
			}
			e.state.mu.Lock()
			if e.fiber == fiber {
				e.fiber = nil
				e.subgroup = nil
				e.subtree = nil
			}
			e.appliedRevision = revision
			previous := CloneOptions(e.applied)
			e.applied = nil
			current := e.revision
			e.state.mu.Unlock()
			if previous != nil {
				if err := e.Ctx.Emit(kardia.StringEvent("loader/partial-dispose"), e, previous, false); err != nil {
					return err
				}
			}
			if current != revision {
				continue
			}
			return nil
		}
		if revision == applied && !restartRequired && fiber != nil && fiber.UID() != nil {
			return nil
		}
		for _, v := range []any{options} {
			if err := validateRuntime(v); err != nil {
				return err
			}
		}
		if !initialized {
			if err := e.Ctx.Emit(kardia.StringEvent("loader/entry-init"), e); err != nil {
				return err
			}
			e.state.mu.Lock()
			e.initialized = true
			e.state.mu.Unlock()
		}
		isolate, finishIsolation, err := e.resolveIsolation(options.Isolate)
		if err != nil {
			return err
		}
		e.state.mu.RLock()
		previous := CloneOptions(e.applied)
		e.state.mu.RUnlock()
		if previous != nil {
			if err := e.Ctx.Emit(kardia.StringEvent("loader/partial-dispose"), e, previous, true); err != nil {
				finishIsolation(false)
				return err
			}
		}
		isolationApplied := false
		_, err = e.Ctx.Waterfall(kardia.StringEvent("loader/patch-context"), func(*kardia.EventCtx) (any, error) {
			if err := e.Ctx.PatchLayer(parent.Ctx, isolate, options.Intercept); err != nil {
				return nil, err
			}
			isolationApplied = true
			if fiber != nil && fiber.UID() != nil {
				// 插件身份或 inject 变化需要重建，普通配置/隔离更新保持 fiber 身份。
				e.state.mu.RLock()
				prior := e.appliedOptionsLocked()
				e.state.mu.RUnlock()
				if prior != nil && (prior.Name != options.Name || !deepValueEqual(prior.Inject, options.Inject)) {
					e.state.mu.Lock()
					e.fiber = nil
					e.state.mu.Unlock()
					if err := fiber.Dispose(ctx); err != nil {
						return nil, err
					}
					e.state.mu.Lock()
					e.subgroup = nil
					e.subtree = nil
					e.state.mu.Unlock()
					fiber = nil
				} else if restartRequired || prior == nil || !deepValueEqual(prior.Config, options.Config) || options.Group != nil && *options.Group {
					if err := fiber.Update(ctx, deepCopyValue(options.Config), true); err != nil {
						return nil, err
					}
				}
			}
			return nil, nil
		}, e)
		finishIsolation(isolationApplied)
		if err != nil {
			return err
		}

		if fiber == nil || fiber.UID() == nil {
			plugin, err := parent.Tree().Import(options.Name)
			if err != nil {
				return err
			}
			fiber, err = e.Ctx.Plugin(plugin, deepCopyValue(options.Config))
			if err != nil {
				return err
			}
			e.state.mu.Lock()
			e.fiber = fiber
			cancelActivation := e.removed || e.disabledLocked()
			staleActivation := runtimeChanged(options, e.options, parent, e.parent)
			if staleActivation && fiber.CancelLoading() {
				e.restartRequired = true
			}
			e.state.mu.Unlock()
			if cancelActivation {
				if err := fiber.Dispose(ctx); err != nil {
					return err
				}
				continue
			}
			if _, err = fiber.Await(ctx); err != nil {
				return err
			}
		}
		e.state.mu.Lock()
		e.appliedRevision = revision
		e.applied = options
		if e.revision == revision {
			e.restartRequired = false
		}
		current := e.revision
		e.state.mu.Unlock()
		if current == revision {
			return nil
		}
	}
}
func (e *Entry) appliedOptionsLocked() *EntryOptions { return e.applied }

// resolveIsolation 保持局部 symbol 稳定，并按条目引用计数回收具名共享域。
func (e *Entry) resolveIsolation(config map[string]any) (map[string]*kardia.Symbol, func(bool), error) {
	for name, value := range config {
		switch v := value.(type) {
		case bool:
			if !v {
				return nil, nil, fmt.Errorf("隔离服务 %s 的值必须为 true 或域名", name)
			}
		case string:
			if v == "" {
				return nil, nil, fmt.Errorf("隔离服务 %s 的域名不能为空", name)
			}
		case nil:
		default:
			return nil, nil, fmt.Errorf("隔离服务 %s 的值必须为 true 或域名", name)
		}
	}
	e.state.mu.Lock()
	defer e.state.mu.Unlock()
	next := map[string]string{}
	out := map[string]*kardia.Symbol{}
	for name, value := range config {
		if value == nil {
			out[name] = nil
			continue
		}
		if local, ok := value.(bool); ok && local {
			if e.local == nil {
				e.local = map[string]*kardia.Symbol{}
			}
			if e.local[name] == nil {
				e.local[name] = kardia.NewSymbol(name + "#" + e.options.ID)
			}
			out[name] = e.local[name]
			continue
		}
		label := value.(string)
		key := label + "\x00" + name
		next[name] = key
		realm := e.state.realms[key]
		if realm == nil {
			realm = &realmRef{symbol: kardia.NewSymbol(name + "@" + label)}
			e.state.realms[key] = realm
		}
		realm.refs++
		out[name] = realm.symbol
	}
	finish := func(applied bool) {
		e.state.mu.Lock()
		defer e.state.mu.Unlock()
		if applied && !e.removed {
			for _, key := range e.realms {
				e.state.releaseRealmLocked(key)
			}
			e.realms = next
		} else {
			for _, key := range next {
				e.state.releaseRealmLocked(key)
			}
		}
	}
	return out, finish, nil
}

// stopAndReconcile 先通知正在初始化的插件取消，再等待共享调和任务。
func (e *Entry) stopAndReconcile(ctx context.Context) error {
	var err error
	if f := e.Fiber(); f != nil {
		err = f.Dispose(ctx)
	}
	return errors.Join(err, e.reconcile(ctx))
}

// SaveConfig 在配置仍为 expected 时记录插件内部已应用的配置，不重新执行插件。
// 调用方不能持有提交回调需要的锁；冲突后应读取新快照并重新合并。
func (e *Entry) SaveConfig(expected, next any) error {
	e.state.mu.Lock()
	if e.removed || e.parent.Tree().closed || !deepValueEqual(e.options.Config, expected) {
		e.state.mu.Unlock()
		return ErrStaleRevision
	}
	legacy := CloneOptions(e.options)
	e.options = CloneOptions(e.options)
	e.options.Config = deepCopyValue(next)
	e.state.revision++
	e.revision = e.state.revision
	if e.applied != nil {
		e.applied = CloneOptions(e.applied)
		e.applied.Config = deepCopyValue(next)
	}
	e.parent.replaceOptionsLocked(e)
	tree := e.parent.Tree()
	change := tree.changeLocked(e, legacy, nil, false)
	e.state.mu.Unlock()
	tree.commit(change)
	return nil
}

func (e *Entry) isRemoved() bool { e.state.mu.RLock(); defer e.state.mu.RUnlock(); return e.removed }

func (e *Entry) readinessPending() bool {
	e.state.mu.RLock()
	defer e.state.mu.RUnlock()
	if e.notifying && e.settledRevision == e.revision {
		return false
	}
	if e.task != nil {
		select {
		case <-e.task.done:
		default:
			return true
		}
	}
	return false
}

func runtimeChanged(a, b *EntryOptions, oldParent, newParent *EntryGroup) bool {
	if a == nil || b == nil {
		return a != b
	}
	return oldParent != newParent || a.Name != b.Name || !deepValueEqual(a.Config, b.Config) || !deepValueEqual(a.Inject, b.Inject)
}
