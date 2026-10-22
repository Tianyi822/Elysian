// Package platform 实现 /api/platform 片：memory 内存采样与 dependencies 依赖探测。
// 行为权威是 .zcode/go-migration/inventories/platform.md 盘点，TS 源在
// apps/server/src/platformDependencies 与 apps/server/src/platformMemory。
//
// 本域无容器边界、无 503 段：「Docker 缺失」这个事实要在三域全 503 时仍拿得到
// （app.ts:59-61），三种运行模式下 memory 与 dependencies 探测一律照常工作；探测
// 纯读、不在宿主上执行任何安装。本域不消费 seam.Logs，不读 env，一切模式事实经
// Deps 注入。
package platform
