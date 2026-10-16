package docker

import (
	"context"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/config"
	"elysian/server/internal/seam"
)

// Deps 装配入参（go-plan §3.8）：模式事实经 config 产出、装配层注入，本包不读 env。
type Deps struct {
	AgentAuthorize func(context.Context) error
	ReservedPorts  []int

	Mode       config.RuntimeMode
	SocketPath string // cfg.DockerSocket
	MountRoot  string // cfg.MountRoot
	Logs       seam.Logs
	Kit        seam.TerminalKit
	Now        func() time.Time
}

// Stack 装配产出：路由器与向 database/websites 分发的事实。
type Stack struct {
	Agent  *AgentFacade
	Router chi.Router
	Engine seam.DockerTransport
	Views  seam.DockerViews // ListImages/ListContainers/Policy/SelfContainerID
	SelfID string           // 空串 = 未识别
	// Ready 是 socketReady（/version ≥1.41 探测结果）。LocalDemo 与容器双闸门
	// 不满足时不探测、恒 false（dockerHostDeps.ts:93-95 早退语义）；仅 BareMetal
	// 跳过容器闸门后才探测。websites/database 的整片 503 依赖此恒 false。
	Ready bool
}

// Assemble 容器管理片装配（dockerHostDeps.ts createDockerHostDeps 等价物）：
// LocalDemo 第一段 503；Docker/BareMetal 探测 /version（后者跳过容器闸门），
// 失败第二段 503（带原因）；成功后构造 service/eventsHub/execSessions 并产出 Stack。
func Assemble(deps Deps) (Stack, error) {
	socketPath := deps.SocketPath
	if socketPath == "" {
		socketPath = "/var/run/docker.sock"
	}
	mountRoot := deps.MountRoot
	if mountRoot == "" {
		mountRoot = "/srv"
	}
	now := deps.Now
	if now == nil {
		now = time.Now
	}

	if deps.Mode == config.ModeLocalDemo {
		// 容器硬边界不满足：不探测 socket，整片第一段 503。
		return Stack{Router: newRouter(routerDeps{available: false})}, nil
	}

	transport := assemblyTransport(socketPath)
	if err := probeEngineAPI(context.Background(), transport); err != nil {
		reason := err.Error()
		if reason == "" {
			reason = "Docker socket 连接失败"
		}
		return Stack{
			Router: newRouter(routerDeps{available: true, socketReady: false, socketUnavailableReason: reason}),
			Engine: transport,
			Ready:  false,
		}, nil
	}

	selfID := resolveSelfContainerIDFromEngine(transport)
	hub := newEventsHub(eventsHubConfig{transport: transport, now: now})
	service := newDockerService(serviceDeps{
		transport:       transport,
		mountRoot:       mountRoot,
		reservedPorts:   assemblyReservedPorts(deps.ReservedPorts),
		selfContainerID: selfID,
		onRestarting:    func(containerID string) { hub.NotifyRestarting(containerID) },
		mkdir: func(path string, mode os.FileMode) error {
			return os.Mkdir(path, mode)
		},
		realpath: defaultRealpath,
		now:      now,
	})

	var sessions *execSessions
	if deps.Kit != nil {
		sessions = newExecSessions(execSessionsConfig{
			kit:              deps.Kit,
			createExecRunner: func(containerID string) execRunner { return createContainerExecRunner(socketPath, containerID) },
			identityForContainer: func(containerID string) seam.TerminalIdentity {
				return seam.TerminalIdentity{User: "root", HostLabel: hostLabelForContainer(containerID), HomeDir: "/"}
			},
			listDir: func(containerID, path string) ([]string, error) {
				return listDockerFiles(createContainerExecRunner(socketPath, containerID), path)
			},
			listCommands: func(containerID string, kind shellKind) ([]string, error) {
				return listDockerCommands(createContainerExecRunner(socketPath, containerID), kind)
			},
			now: now,
		})
	}

	router := newRouter(routerDeps{
		available:    true,
		socketReady:  true,
		service:      service,
		eventsHub:    hub,
		transport:    transport,
		execSessions: sessions,
		logs:         deps.Logs,
	})
	return Stack{
		Agent:  &AgentFacade{service: service, authorize: deps.AgentAuthorize},
		Router: router,
		Engine: transport,
		Views:  service,
		SelfID: selfID,
		Ready:  true,
	}, nil
}

// hostLabelForContainer 容器终端身份 hostLabel：容器 id 前 13 位。
func hostLabelForContainer(containerID string) string {
	if len(containerID) > 13 {
		return containerID[:13]
	}
	return containerID
}

// assemblyTransportOverride 测试注入点：非 nil 时装配期传输器由测试供给
// （生产恒 nil，走 NewTransportFactory）。
var assemblyTransportOverride func(socketPath string) seam.DockerTransport

// assemblyTransport 装配期传输器出口。
func assemblyTransport(socketPath string) seam.DockerTransport {
	if assemblyTransportOverride != nil {
		return assemblyTransportOverride(socketPath)
	}
	return NewTransportFactory().New(socketPath)
}

// cgroupTextOverride / hostnameOverride 测试注入点：非 nil 时自容器识别改读注入
// 文本（生产恒 nil，读真实 /proc 与 os.Hostname）。
var (
	cgroupTextOverride func() string
	hostnameOverride   func() string
)

// resolveSelfContainerIDFromEngine cgroup 双文件 + 引擎容器表 + hostname 三通道。
func resolveSelfContainerIDFromEngine(transport seam.DockerTransport) string {
	cgroupText := ""
	if cgroupTextOverride != nil {
		cgroupText = cgroupTextOverride()
	} else {
		cgroupText = readCgroupText()
	}
	ids := listContainerIDsFromEngine(transport)
	hostname := ""
	if hostnameOverride != nil {
		hostname = hostnameOverride()
	} else if name, err := os.Hostname(); err == nil {
		hostname = name
	}
	return resolveSelfContainerId(cgroupText, ids, hostname)
}

// listContainerIDsFromEngine 引擎容器表（失败容错空表）。
func listContainerIDsFromEngine(transport seam.DockerTransport) []string {
	response, err := transport.Request(context.Background(), seam.EngineRequest{
		Method:   http.MethodGet,
		Path:     "/containers/json",
		Query:    url.Values{"all": {"1"}},
		Timeout:  10 * time.Second,
		MaxBytes: 32 * 1024 * 1024,
	})
	if err != nil {
		return []string{}
	}
	if response.Status < 200 || response.Status >= 300 {
		return []string{}
	}
	value, err := decodeOrderedJSON(response.Body)
	if err != nil {
		return []string{}
	}
	entries, ok := asArray(value)
	if !ok {
		return []string{}
	}
	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		if record, ok := asRecord(entry); ok {
			if id, ok := asString(mustGet(record, "Id")); ok && id != "" {
				ids = append(ids, id)
			}
		}
	}
	return ids
}

func assemblyReservedPorts(ports []int) []int {
	if ports == nil {
		return reservedPortsList()
	}
	return ports
}
