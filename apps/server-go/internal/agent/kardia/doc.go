// Package kardia 提供按作用域管理资源的 Go 插件运行时。
//
// 插件用 Plugin 描述符在编译期注册；Apply 接收本次激活的 Context。
// Lifetime 返回本次激活的 context.Context，阻塞调用应响应它的取消。
// 服务用 Provide 注册，以 InjectMap 声明依赖，再通过 Get 受检访问：
//
//	root := kardia.NewContext()
//	provider, err := root.Plugin(&kardia.Plugin{
//		Name: "settings",
//		Apply: func(c *kardia.Context, config any) (kardia.Disposable, error) {
//			return c.Provide("settings", config, nil)
//		},
//	}, map[string]any{"limit": 4})
//	if err != nil { return err }
//	if _, err = provider.Await(ctx); err != nil { return err }
//	consumer, err := root.Plugin(&kardia.Plugin{
//		Name: "consumer", Inject: kardia.InjectMap{"settings": nil},
//		Apply: func(c *kardia.Context, _ any) (kardia.Disposable, error) {
//			settings, err := c.Get("settings")
//			if err != nil { return nil, err }
//			c.Logger().Info("配置：%o", settings)
//			return nil, nil
//		},
//	}, nil)
//	if err != nil { return err }
//	if _, err = consumer.Await(ctx); err != nil { return err }
//	if err = provider.Update(ctx, map[string]any{"limit": 8}, false); err != nil { return err }
//	if err = consumer.Dispose(ctx); err != nil { return err }
//	return provider.Dispose(ctx)
//
// 创建带 Initializer 或 InitializerIter 的服务时使用 ServicePlugin 工厂。
// 初始化错误会回滚当次激活登记的全部资源，包括与错误同时返回的清理器。
// Service.ResolveConfig 按基础值、外层拦截、内层拦截、显式覆盖依次合并。
//
// 异步资源通过 c.Scope().Iter 登记。子资源须用回调传入的 EffectScope 创建，
// 或用 scope.Bind(c) 取得绑定上下文；同时执行的其他 goroutine 不会被隐式领养。
// Scope.Defer 接纳生产者关闭期间返回的迟到清理器。EffectHandle.Dispose 的
// 等待取消只影响当前调用者，后续调用可等待同一清理任务和 errors.Join 结果。
// 回调不能同步等待包含自身的任务关闭；应调用 Fiber.CancelActivation 请求取消，
// 退出回调后再由外部等待 Dispose。根 Fiber.Dispose 保留 Cordis 的重置语义，
// 根可继续装载插件；子插件的 Dispose 则永久注销该插件身份。
//
// Fiber.Await 只等待生命周期收敛，不等待 interval 等常驻任务。
// Tasks().Wait 等待任务组全部完成，应先停止相应资源。
// Parallel 和 Serial 用 EventCtx.Context 传递调用者的取消信号。
// 导出器与 Loader.Load 显式接收资源所属的调用方 Context。
//
// loader 管理条目与组，EntryPatch.Set 和 Unset 区分赋值、清空与删除；Update
// 返回表示已完成调和，SubmitUpdate 返回可等待的 Task。include 用绝对目录解析
// 相对配置路径，支持 JSON/YAML；!js 只作不透明数据保真，需要求值时返回错误。
// 不提供 npm 模块装载、Node 模块热替换或 JavaScript 执行引擎。
//
// 配置容器通过快照交换。带私有字段的配置应实现 ConfigCloner；服务实例和普通
// 指针由插件自行保证并发安全。Plugin 描述符及自定义回调在注册后应保持不变。
package kardia
