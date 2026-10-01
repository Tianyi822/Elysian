// Package main 是运行时版本目录的在线诊断入口（原 scripts/check-website-runtime-catalog.ts
// 的 Go 对等）：走生产同一条路径（真实 http.Client + 官方 8 源）抓一次目录并打印各类型
// 的正式版本数，验证自动获取路径连通；不生成或维护固定版本文件。
// 宿主机不装 Go 工具链，经 scripts/check-website-runtimes.sh 在 go-dev 容器内执行。
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"time"

	"elysian/server/internal/websites"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "运行时目录诊断失败："+err.Error())
		os.Exit(1)
	}
}

func run() error {
	// 与服务端刷新路径同参：真实出网、当天 UTC 作为五年线判据。
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	catalog, err := websites.FetchWebsiteRuntimeCatalog(ctx, &http.Client{}, time.Now().UTC().Format("2006-01-02"))
	if err != nil {
		return err
	}
	total := 0
	for _, entry := range []struct {
		label string
		count int
	}{
		{"java", len(catalog.Java)},
		{"node", len(catalog.Node)},
		{"go", len(catalog.Go)},
		{"python", len(catalog.Python)},
	} {
		fmt.Printf("%s：%d 个正式版本选项\n", entry.label, entry.count)
		total += entry.count
	}
	fmt.Printf("已从官方发布记录与 Docker 官方镜像库自动核对 %d 个选项\n", total)
	return nil
}
