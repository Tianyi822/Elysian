// Package web 内嵌前端静态资源（go-plan §8）：embed 目录固定为 apps/server-go/web/dist，
// 入库时仅含 .gitkeep 占位，保证 dist 缺失时也能编译、能跑全部测试；发布构建先清空再
// 拷贝 apps/web/dist 的真实产物覆盖占位。
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var distFS embed.FS

// DistFS 返回嵌入的前端静态资源根（dist 目录），供静态服务与 SPA 回落消费。
func DistFS() fs.FS {
	return distFS
}
