// Package platform 实现 /api/platform 片：memory 内存采样、dependencies 依赖探测、
// dependencies/setup 宿主代装两条 POST。行为权威是
// .zcode/go-migration/inventories/platform.md 盘点，TS 源在
// apps/server/src/platformDependencies 与 apps/server/src/platformMemory。
//
// 本域无容器边界、无 503 段：「Docker 缺失」这个事实要在三域全 503 时仍拿得到
// （app.ts:59-61），三种运行模式下 memory 与 dependencies 探测一律照常工作；
// setup 的分支只由 InContainer 决定——裸机直接 /bin/sh 执行，容器内经引擎 socket
// 起一次性特权 nsenter 容器进宿主命名空间。本域不消费 seam.Logs（两条 setup POST
// 的操作审计由 logs 域审计中间件按描述符表落），不读 env、不自测 /.dockerenv，
// 一切模式事实经 Deps 注入。
package platform
