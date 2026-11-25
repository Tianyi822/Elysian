package contract

// DockerPublishedPort is an active host binding reported by Docker Engine.
type DockerPublishedPort struct {
	ContainerID   string `json:"containerId"`
	ContainerName string `json:"containerName"`
	HostIP        string `json:"hostIp"`
	HostPort      int    `json:"hostPort"`
	ContainerPort int    `json:"containerPort"`
	Protocol      string `json:"protocol"`
}
