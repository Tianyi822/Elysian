// Package contract 是 @elysian/contracts 的 Go 版等价物（go-plan §4.4）：纯类型 +
// 纯函数 + 常量，零 IO、零框架依赖，供公共层接缝与各域共用。
//
// 骨架阶段只预置 seam 接口签名引用到的最小类型集（容器视图与防火墙端口同步）；
// §4.4 清单的其余视图模型与判据（ParseImageReference、TerminalCharWidth、SSH/网站/
// 数据库判据等）随各域实现按 gaps 协议补入，域内不得私造跨域共享类型。
package contract

// 容器状态取值（TS ContainerStatus）。
const (
	ContainerStatusRunning    = "running"
	ContainerStatusStopped    = "stopped"
	ContainerStatusRestarting = "restarting"
	ContainerStatusPaused     = "paused"
)

// 重启策略取值（TS RestartPolicy）。
const (
	RestartPolicyNo            = "no"
	RestartPolicyAlways        = "always"
	RestartPolicyOnFailure     = "on-failure"
	RestartPolicyUnlessStopped = "unless-stopped"
)

// 端口协议取值。
const (
	ProtocolTCP = "tcp"
	ProtocolUDP = "udp"
)

// PortBindingView 端口映射视图：容器内监听端口 → 宿主机端口（TS PortMapping）。
type PortBindingView struct {
	ContainerPort int    `json:"containerPort"`
	HostPort      int    `json:"hostPort"`
	Protocol      string `json:"protocol"`
	HostIP        string `json:"hostIp,omitempty"`
}

// EnvPair 环境变量键值；value 为 null 时以 nil 指针表达。
type EnvPair struct {
	Key   string  `json:"key"`
	Value *string `json:"value"`
}

// VolumeMount 绑定挂载：宿主机路径 → 容器内路径。
type VolumeMount struct {
	HostPath      string `json:"hostPath"`
	ContainerPath string `json:"containerPath"`
	Kind          string `json:"kind,omitempty"` // bind | volume | tmpfs
}

// Container 容器视图（TS Container 的 Go 版）。
type Container struct {
	ID            string            `json:"id"`
	Name          string            `json:"name"`
	Status        string            `json:"status"`
	ImageID       string            `json:"imageId"`
	ImageRef      string            `json:"imageRef,omitempty"`
	Ports         []PortBindingView `json:"ports"`
	CreatedAt     string            `json:"createdAt"`
	StartedAt     string            `json:"startedAt,omitempty"`
	Command       string            `json:"command"`
	Env           []EnvPair         `json:"env"`
	Volumes       []VolumeMount     `json:"volumes"`
	RestartPolicy string            `json:"restartPolicy"`
}

// ContainerImage 镜像视图（TS ContainerImage 的 Go 版）。
type ContainerImage struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Tag       string   `json:"tag"`
	Digest    string   `json:"digest"`
	SizeMB    int      `json:"sizeMb"`
	PulledAt  *string  `json:"pulledAt"`
	OtherTags []string `json:"otherTags,omitempty"`
}
