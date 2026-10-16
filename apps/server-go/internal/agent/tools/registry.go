// registry.go 是工具注册表：以 kardia 服务 "tools" 的形态提供，能力插件经
// Inject 声明依赖它，登记与撤销都挂在装载它的那条 fiber 上，销毁自动回收。
package tools

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"sync/atomic"

	"elysian/server/internal/agent/kardia"
)

// ServiceName 是注册表的服务名，也是能力插件 Inject 声明里要写的键。
const ServiceName = "tools"

// Plugin 是注册表插件。宿主先装载它，能力插件的注入才会就绪。
var Plugin = &kardia.Plugin{Name: ServiceName, Apply: newRegistry}

// entry 是表内一条记录。seq 让撤销只删自己登记的那一条，避免「先撤销、
// 后重注册同名工具」时误删新记录。
type entry struct {
	descriptor Descriptor
	id         int64
}

// Registry 是工具注册表服务。
type Registry struct {
	kardia.Service

	mu        sync.Mutex
	items     map[string]*entry
	nextID    int64
	counter   atomic.Int64
	managed   bool
	authority *Authority
}

// New 构造注册表并在 c 的 fiber 上以服务名 "tools" 提供。
func New(c *kardia.Context) (*Registry, error) {
	registry := &Registry{items: make(map[string]*entry)}
	base, err := kardia.NewService(c, ServiceName, registry, nil)
	if err != nil {
		return nil, err
	}
	registry.Service = base
	return registry, nil
}

func newRegistry(c *kardia.Context, _ any) (kardia.Disposable, error) {
	if _, err := New(c); err != nil {
		return nil, err
	}
	// 服务提供本身是 effect，fiber 销毁时自动撤销，无需额外清理器。
	return nil, nil
}

// Register 登记一条描述符并返回撤销器。描述符不合法、重名、change 事件失败
// 都会拒绝登记（失败闭合）；条目归注册表激活代所有，撤销器共享一次清理结果。
func (r *Registry) Register(descriptor Descriptor) (kardia.Disposable, error) {
	return r.register(r.Ctx, descriptor)
}

// register 把登记与处理器绑定到提供者的激活代；直接登记归注册表自身所有。
func (r *Registry) register(owner *kardia.Context, descriptor Descriptor) (kardia.Disposable, error) {
	if err := r.Ctx.Lifetime().Err(); err != nil {
		return nil, fmt.Errorf("工具注册表已停用：%w", err)
	}
	if err := descriptor.validate(); err != nil {
		return nil, err
	}
	descriptor = descriptor.clone()
	if descriptor.Metadata.Exposure == "agent" {
		if descriptor.Metadata.Version == "" {
			descriptor.Metadata.Version = "1"
		}
		if descriptor.Metadata.Backend == "" {
			descriptor.Metadata.Backend = "domain"
		}
	}
	handler := descriptor.Handler
	var done atomic.Bool
	registrationCtx, revoke := context.WithCancel(owner.Lifetime())
	descriptor.Handler = func(access *kardia.Context, args Arguments) (any, error) {
		if done.Load() {
			return nil, fmt.Errorf("工具 %q 的登记已撤销", descriptor.Name)
		}
		if err := owner.Lifetime().Err(); err != nil {
			return nil, fmt.Errorf("工具 %q 的提供者已停用：%w", descriptor.Name, err)
		}
		if err := r.Ctx.Lifetime().Err(); err != nil {
			return nil, fmt.Errorf("工具注册表已停用：%w", err)
		}
		if access == nil {
			access = owner
		}
		if err := Lifetime(access).Err(); err != nil {
			return nil, fmt.Errorf("工具 %q 的调用已取消：%w", descriptor.Name, err)
		}
		if err := descriptor.validateArguments(args); err != nil {
			return nil, err
		}
		r.mu.Lock()
		managed, authority := r.managed, r.authority
		r.mu.Unlock()
		if managed {
			if err := consumeRegistry(Lifetime(access), authority, descriptor.Catalog, descriptor.Name, args); err != nil {
				return nil, err
			}
		}
		callCtx, cancel := context.WithCancel(Lifetime(access))
		stopOwner := context.AfterFunc(registrationCtx, cancel)
		stopScope := context.AfterFunc(access.Lifetime(), cancel)
		stopRegistry := context.AfterFunc(r.Ctx.Lifetime(), cancel)
		defer cancel()
		defer stopOwner()
		defer stopRegistry()
		defer stopScope()
		access = access.Extend(kardia.ExtendMeta{Props: map[any]any{invocationContextKey{}: callCtx}})
		value, err := handler(access.Shadow(owner), args)
		if err == nil && descriptor.Await != nil {
			return descriptor.Await(callCtx, value)
		}
		return value, err
	}
	record, err := r.insert(descriptor)
	if err != nil {
		revoke()
		return nil, err
	}
	cleanup := func(ctx context.Context) error {
		if ctx == nil {
			return errors.New("撤销工具登记必须提供 ctx")
		}
		if !done.CompareAndSwap(false, true) {
			return nil
		}
		revoke()
		r.remove(record)
		return r.emitChange(ChangeRemoved, descriptor.Name)
	}
	dispose, err := owner.Effect(fmt.Sprintf("tools.register(%q)", descriptor.Name), func() (kardia.Disposable, error) {
		return cleanup, nil
	})
	if err != nil {
		return nil, errors.Join(err, cleanup(context.Background()))
	}
	if err := r.emitChange(ChangeRegistered, descriptor.Name); err != nil {
		return nil, errors.Join(fmt.Errorf("登记工具 %q 后上报变化失败：%w", descriptor.Name, err), dispose(context.Background()))
	}
	return func(ctx context.Context) error {
		if ctx == nil {
			return errors.New("撤销工具登记必须提供 ctx")
		}
		return dispose(ctx)
	}, nil
}

func (r *Registry) insert(descriptor Descriptor) (*entry, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := descriptor.Catalog + "\x00" + descriptor.Name
	if _, exists := r.items[key]; exists {
		return nil, fmt.Errorf("工具 %q 已注册", descriptor.Name)
	}
	r.nextID++
	record := &entry{descriptor: descriptor, id: r.nextID}
	r.items[key] = record
	return record, nil
}

func (r *Registry) remove(record *entry) {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := record.descriptor.Catalog + "\x00" + record.descriptor.Name
	if current, ok := r.items[key]; ok && current == record {
		delete(r.items, key)
	}
}

func (r *Registry) emitChange(kind ChangeKind, name string) error {
	return r.Ctx.Emit(EventChange, Change{Kind: kind, Name: name})
}

// Lookup 按名取描述符。
func (r *Registry) Lookup(name string) (Descriptor, bool) {
	return r.lookup("", name)
}

func (r *Registry) lookup(catalog, name string) (Descriptor, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	record, ok := r.items[catalog+"\x00"+name]
	if !ok && catalog != "" {
		record, ok = r.items["\x00"+name]
	}
	if !ok {
		return Descriptor{}, false
	}
	return record.descriptor.clone(), true
}

// List 返回按名字稳定排序的描述符快照。
func (r *Registry) List() []Descriptor {
	r.mu.Lock()
	list := make([]Descriptor, 0, len(r.items))
	for _, record := range r.items {
		list = append(list, record.descriptor.clone())
	}
	r.mu.Unlock()
	sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
	return list
}

// Schemas 返回对外投影的快照，不含处理器。
func (r *Registry) Schemas() []PublicSchema {
	list := r.List()
	schemas := make([]PublicSchema, 0, len(list))
	for _, descriptor := range list {
		schemas = append(schemas, descriptor.Public())
	}
	return schemas
}

// Size 返回已登记的工具数。
func (r *Registry) Size() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.items)
}

// Execute 按名执行一条工具：先校验参数（不合法直接拒，不进策略链），再走三段
// 瀑布，最后发 result 事件。参数为 nil 时按空对象处理。
func (r *Registry) Execute(c *kardia.Context, name string, args Arguments) (any, error) {
	if err := r.Ctx.Lifetime().Err(); err != nil {
		return nil, fmt.Errorf("工具注册表已停用：%w", err)
	}
	catalog := ""
	if c != nil {
		if t := ticket(Lifetime(c)); t != nil {
			catalog = t.binding.CatalogID
		}
	}
	descriptor, ok := r.lookup(catalog, name)
	if !ok {
		return nil, fmt.Errorf("工具 %q 未注册", name)
	}
	if args == nil {
		args = Arguments{}
	}
	args = kardia.CloneConfig(args).(Arguments)
	if err := descriptor.validateArguments(args); err != nil {
		return nil, fmt.Errorf("工具 %q 的参数不合法：%w", name, err)
	}
	call := Call{ID: r.nextCallID(), Name: name, Args: args}
	site := r.Ctx
	if c != nil {
		site = r.CtxFor(c)
	}
	if err := Lifetime(site).Err(); err != nil {
		return nil, fmt.Errorf("工具 %q 的调用已取消：%w", name, err)
	}
	outcome := runCall(site, descriptor, call, args)
	if err := site.Emit(EventResult, call.snapshot(), outcome); err != nil {
		// result 是审计事件：监听者失败不改写执行结果，但必须让调用方看见。
		outcome.Err = errors.Join(outcome.Err, fmt.Errorf("上报工具 %q 的结果失败：%w", name, err))
	}
	return outcome.Value, outcome.Err
}

func (r *Registry) nextCallID() string {
	return fmt.Sprintf("call-%d", r.counter.Add(1))
}
