// Package docker 实现 /api/docker 容器管理片与 Engine 传输（seam.DockerTransport /
// DockerViews 实现方，HTTP-over-unix 固定 /v1.41；Assemble 产出装配层向
// database/websites 分发的 Stack）。行为权威是
// .zcode/go-migration/inventories/docker.md 盘点。
//
// 骨架阶段本包只声明存在；路由、服务与测试由 docker 域实现者替换本占位。
package docker
