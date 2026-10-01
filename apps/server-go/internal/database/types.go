package database

import (
	"context"

	"elysian/server/internal/contract"
)

// 服务型数据库与 SQLite 托管的共享类型：引擎常量、凭证、登记行、投影视图与
// 终端会话接口。JSON 键序与 TS 版逐字段对齐（响应键序是冻结契约）。

// 引擎取值（契约 DatabaseEngine 的服务端子集；SQLite 由托管片单独表达）。
const (
	engineMySQL   = "MySQL"
	engineMariaDB = "MariaDB"
	engineRedis   = "Redis"
	engineSQLite  = "SQLite"
)

// 状态取值（投影 status）。
const (
	statusRunning = "running"
	statusWarning = "warning"
	statusStopped = "stopped"
)

// databaseSecret 管理员或普通账号凭证；键序 username → password。
type databaseSecret struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// 登记行 source 取值。
const (
	sourceManaged = "managed"
	sourceAdopted = "adopted"
)

// 登记行 state 取值。
const (
	stateActive         = "active"
	stateNeedsAttention = "needs-attention"
	stateEmpty          = "empty"
)

// accessScope 取值。
const (
	scopeLocalhost       = "localhost"
	scopeContainerNet    = "container-network"
	scopeAnyHost         = "any-host"
	networkDBPrivateName = "elysian-db-local"
	networkDBSharedName  = "elysian-db-shared"
)

// databaseRecord 服务型数据库登记行（~/.Elysian/config/databases.json）。
// 字段声明序即写盘键序，与 TS 版构造序逐字兼容。
type databaseRecord struct {
	ID          string         `json:"id"`
	Engine      string         `json:"engine"`
	Name        string         `json:"name"`
	VersionTag  string         `json:"versionTag"`
	ContainerID string         `json:"containerId"`
	VolumeName  string         `json:"volumeName,omitempty"`
	Source      string         `json:"source"`
	AccessScope string         `json:"accessScope"`
	Admin       databaseSecret `json:"admin"`
	User        databaseSecret `json:"user"`
	CreatedAt   string         `json:"createdAt"`
	State       string         `json:"state"`
}

// storageView 存储用量投影。
type storageView struct {
	UsedGb  float64 `json:"usedGb"`
	TotalGb float64 `json:"totalGb"`
}

// memoryView 容器内存投影。
type memoryView struct {
	UsedGb  float64 `json:"usedGb"`
	TotalGb float64 `json:"totalGb"`
}

// connectionsView 连接使用投影。
type connectionsView struct {
	Active int `json:"active"`
	Max    int `json:"max"`
}

// serviceInstance 服务型数据库投影（含空容器形态）。字段声明序即响应键序：
// 与 TS 版两处对象字面量的插入序逐字对齐（正常态与空容器态共用本序，
// 各自缺省的字段经 omitempty / nil 指针消隐）。
type serviceInstance struct {
	ID                 string           `json:"id"`
	Engine             string           `json:"engine"`
	Name               string           `json:"name"`
	Version            string           `json:"version"`
	Status             string           `json:"status"`
	ContainerID        string           `json:"containerId,omitempty"`
	Source             string           `json:"source,omitempty"`
	VersionTag         string           `json:"versionTag,omitempty"`
	AccessScope        string           `json:"accessScope,omitempty"`
	VolumeName         string           `json:"volumeName,omitempty"`
	CredentialUsername string           `json:"credentialUsername,omitempty"`
	HasCredentials     *bool            `json:"hasCredentials,omitempty"`
	EmptyContainer     bool             `json:"emptyContainer,omitempty"`
	Storage            *storageView     `json:"storage,omitempty"`
	Memory             *memoryView      `json:"memory,omitempty"`
	Connections        *connectionsView `json:"connections,omitempty"`
	MetricsError       string           `json:"metricsError,omitempty"`
	UpdatedAt          string           `json:"updatedAt"`
	NeedsAttention     *bool            `json:"needsAttention,omitempty"`
}

// sqliteInstance SQLite 托管投影；键序与 TS 版 sqliteService.project 的插入序一致。
type sqliteInstance struct {
	ID             string   `json:"id"`
	Engine         string   `json:"engine"`
	Name           string   `json:"name"`
	Version        string   `json:"version"`
	Status         string   `json:"status"`
	FilePath       string   `json:"filePath,omitempty"`
	FileSizeMB     *float64 `json:"fileSizeMb,omitempty"`
	TableCount     *int     `json:"tableCount,omitempty"`
	LastWrittenAt  string   `json:"lastWrittenAt,omitempty"`
	UpdatedAt      string   `json:"updatedAt"`
	Source         string   `json:"source,omitempty"`
	MetricsError   string   `json:"metricsError,omitempty"`
	NeedsAttention bool     `json:"needsAttention"`
}

// databaseAddress 容器内数据库连接地址。
type databaseAddress struct {
	Host string
	Port int
}

// databaseMetrics 指标采样（sizeGb 与 connections 均可缺省）。
type databaseMetrics struct {
	SizeGb      *float64
	Connections *connectionsView
}

// Session 一次数据库协议终端会话：execute 输出多行文本，close 关闭底层连接。
type Session interface {
	Execute(ctx context.Context, input string) ([]string, error)
	Close() error
}

// containerCandidate 发现接口返回的候选容器行；键序与 TS 版一致。
type containerCandidate struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	AccessScope string `json:"accessScope"`
	Managed     bool   `json:"managed"`
	VersionTag  string `json:"versionTag"`
}

// discoverResult 发现接口响应体。
type discoverResult struct {
	Images     []contract.ContainerImage `json:"images"`
	Containers []containerCandidate      `json:"containers"`
}
