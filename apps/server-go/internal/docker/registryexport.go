package docker

import (
	"context"
)

// CheckRegistryHost 是镜像源校验的跨域出口（ADR-0021）：供 containerapps 域的
// Dockerfile FROM 静态预检复用 docker 域同一套语法 + DNS 公网判定，避免两处各写
// 一份规则漂移。语义与拉取前的 assertRegistryAllowed 相同；区别是这里不挂
// serviceDeps，用缺省解析器（defaultRegistryResolver 自带 3s 超时包裹）。
// 返回 nil 表示允许；失败原文即 registrypolicy 的中文错误
// （「镜像源无法解析为公网地址」/「镜像源主机名不合法」等）。
func CheckRegistryHost(ctx context.Context, raw string) error {
	_, err := validateRegistryTarget(raw, func(hostname string) ([]string, error) {
		return defaultRegistryResolver(ctx, hostname)
	})
	return err
}
