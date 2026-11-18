package database

// 数据库域共享类型：引擎常量、凭证、登记行、容器投影与 SQLite 托管投影。
// JSON 键序与 TS 版逐字段对齐（响应键序是冻结契约）。

// 引擎取值（契约 DatabaseEngine 的服务端子集；SQLite 由托管片单独表达）。
const (
	engineMySQL   = "MySQL"
	engineMariaDB = "MariaDB"
	engineRedis   = "Redis"
	engineSQLite  = "SQLite"
)

// 状态取值（投影 status）：容器行只产出 running/stopped（warning 仅存于
// SQLite 非 active 行的投影，见 sqlite.go）。
const (
	statusRunning = "running"
	statusWarning = "warning"
	statusStopped = "stopped"
	statusMissing = "missing"
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

// SqlNameRule 标识符格式规则的唯一公开文案出处：退役描述符的参数说明仍逐字
// 引用本常量，冻结目录摘要因此依赖原文不变。
const SqlNameRule = "只能使用英文字母、数字和下划线，并须以字母开头"

// databaseRecord 服务型数据库登记行（~/.Elysian/config/databases.json）。
// 字段声明序即写盘键序，与 TS 版构造序逐字兼容；功能退役后本行仍承载容器归属
// 与专属卷信息，旧登记文件不因退役自动删除或改写。
type databaseRecord struct {
	ID            string         `json:"id"`
	Engine        string         `json:"engine"`
	Name          string         `json:"name"`
	VersionTag    string         `json:"versionTag"`
	ContainerID   string         `json:"containerId"`
	VolumeName    string         `json:"volumeName,omitempty"`
	Source        string         `json:"source"`
	AccessScope   string         `json:"accessScope"`
	Admin         databaseSecret `json:"admin"`
	User          databaseSecret `json:"user"`
	CreatedAt     string         `json:"createdAt"`
	State         string         `json:"state"`
	ContainerName string         `json:"containerName,omitempty"`
}

// memoryView 容器内存投影。
type memoryView struct {
	UsedGb  float64 `json:"usedGb"`
	TotalGb float64 `json:"totalGb"`
}

// containerPortView 容器端口投影行；hostPort 缺省表示仅暴露未绑定宿主端口。
type containerPortView struct {
	HostIP        string `json:"hostIp,omitempty"`
	HostPort      *int   `json:"hostPort,omitempty"`
	ContainerPort int    `json:"containerPort"`
	Protocol      string `json:"protocol"`
}

// containerAddressView 容器连接地址投影（host/port 键序为冻结契约）。
type containerAddressView struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

// containerInstance 数据库容器投影（以 Docker 容器清单为事实源）。字段声明序
// 即响应键序；missing 表示 Docker 清单已无此容器但仍有登记待清理。
// memory 读不到时经 omitempty 消隐。
type containerInstance struct {
	ID                  string                `json:"id"`
	Engine              string                `json:"engine"`
	Name                string                `json:"name"`
	Version             string                `json:"version"`
	Status              string                `json:"status"`
	Image               string                `json:"image"`
	ContainerID         string                `json:"containerId"`
	Source              string                `json:"source,omitempty"`
	VersionTag          string                `json:"versionTag,omitempty"`
	Ports               []containerPortView   `json:"ports"`
	Networks            []string              `json:"networks"`
	VolumeName          string                `json:"volumeName,omitempty"`
	Address             *containerAddressView `json:"address,omitempty"`
	CredentialUsername  string                `json:"credentialUsername,omitempty"`
	CredentialsVerified bool                  `json:"credentialsVerified"`
	Memory              *memoryView           `json:"memory,omitempty"`
	NeedsAttention      bool                  `json:"needsAttention"`
	UpdatedAt           string                `json:"updatedAt"`
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
