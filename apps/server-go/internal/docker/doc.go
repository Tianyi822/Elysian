// Package docker 实现 /api/docker 容器管理片与 Engine 传输（seam.DockerTransport /
// DockerViews 实现方，HTTP-over-unix 固定 /v1.41；Assemble 产出装配层向
// database/websites 分发的 Stack）。行为权威是 .zcode/go-migration/inventories/docker.md
// 盘点：端点、错误消息原文、副作用与三种运行时模式的分支全部照抄 TS 版
// （apps/server/src/docker/）。
package docker
