package websites

import "time"

// 来源、构建配置与发布版本的持久形状与共享契约一致，认证令牌不属于任何持久类型。
type sourceRecord struct {
	FetchContainer string          `json:"fetchContainer,omitempty"`
	FetchImage     string          `json:"fetchImage,omitempty"`
	ID             string          `json:"id"`
	Type           string          `json:"type"`
	Mode           string          `json:"mode"`
	State          string          `json:"state"`
	Name           string          `json:"name"`
	GitURL         string          `json:"gitUrl,omitempty"`
	Ref            string          `json:"ref,omitempty"`
	Commit         string          `json:"commit,omitempty"`
	CreatedAt      string          `json:"createdAt"`
	ExpiresAt      string          `json:"expiresAt"`
	Error          string          `json:"error,omitempty"`
	Report         *analysisReport `json:"report,omitempty"`
}
type analysisReport struct {
	Candidates []projectCandidate `json:"candidates"`
	Warnings   []string           `json:"warnings"`
}
type projectCandidate struct {
	ID               string   `json:"id"`
	Directory        string   `json:"directory"`
	Kind             string   `json:"kind"`
	Tool             string   `json:"tool"`
	ToolVersion      string   `json:"toolVersion,omitempty"`
	Wrapper          bool     `json:"wrapper"`
	Entries          []string `json:"entries"`
	TestSteps        []string `json:"testSteps"`
	BuildSteps       []string `json:"buildSteps"`
	Artifacts        []string `json:"artifacts"`
	SuggestedCommand string   `json:"suggestedCommand"`
	Warnings         []string `json:"warnings"`
	RequiredVersion  string   `json:"requiredVersion,omitempty"`
}
type buildConfig struct {
	CandidateID    string    `json:"candidateId"`
	BuildVersion   string    `json:"buildVersion,omitempty"`
	RuntimeVersion string    `json:"runtimeVersion,omitempty"`
	ToolVersion    string    `json:"toolVersion,omitempty"`
	Entry          string    `json:"entry,omitempty"`
	Artifact       string    `json:"artifact,omitempty"`
	Target         string    `json:"target"`
	Command        string    `json:"command"`
	SkipTests      bool      `json:"skipTests"`
	TestSteps      *[]string `json:"testSteps,omitempty"`
	BuildSteps     *[]string `json:"buildSteps,omitempty"`
}
type deploymentInput struct {
	SourceID  string      `json:"sourceId"`
	ProjectID string      `json:"projectId,omitempty"`
	RequestID string      `json:"requestId"`
	Name      string      `json:"name"`
	Port      int         `json:"port"`
	Note      *string     `json:"note,omitempty"`
	Access    accessInput `json:"access"`
	Config    buildConfig `json:"config"`
}
type releaseRecord struct {
	ID             string `json:"id"`
	CreatedAt      string `json:"createdAt"`
	SourceID       string `json:"sourceId"`
	Commit         string `json:"commit,omitempty"`
	Directory      string `json:"directory"`
	Target         string `json:"target"`
	BuildImage     string `json:"buildImage,omitempty"`
	RuntimeImage   string `json:"runtimeImage"`
	BuildVersion   string `json:"buildVersion,omitempty"`
	RuntimeVersion string `json:"runtimeVersion,omitempty"`
	Command        string `json:"command"`
	ContainerID    string `json:"containerId"`
	ContainerName  string `json:"containerName"`
}
type deploymentTask struct {
	ProjectStatus     string                 `json:"projectStatus,omitempty"`
	Port              int                    `json:"port"`
	PreviousRunning   bool                   `json:"previousRunning"`
	ID                string                 `json:"id"`
	SourceID          string                 `json:"sourceId"`
	ProjectID         string                 `json:"projectId,omitempty"`
	Name              string                 `json:"name"`
	State             string                 `json:"state"`
	Stage             string                 `json:"stage"`
	CreatedAt         string                 `json:"createdAt"`
	UpdatedAt         string                 `json:"updatedAt"`
	Config            buildConfig            `json:"config"`
	BuildImage        string                 `json:"buildImage,omitempty"`
	RuntimeImage      string                 `json:"runtimeImage,omitempty"`
	Error             string                 `json:"error,omitempty"`
	TestResult        string                 `json:"testResult"`
	Artifacts         []string               `json:"artifacts,omitempty"`
	SuggestedCommand  string                 `json:"suggestedCommand,omitempty"`
	Release           *releaseRecord         `json:"release,omitempty"`
	StagedCertificate *WebsiteCertificateRef `json:"stagedCertificate,omitempty"`
	Input             deploymentInput        `json:"input"`
	BuildContainer    string                 `json:"buildContainer,omitempty"`
	Previous          *WebsiteRecord         `json:"previous,omitempty"`
	Pending           *WebsiteRecord         `json:"pending,omitempty"`
}
type deploymentLimits struct {
	ArchiveBytes, ExpandedBytes int64
	Entries                     int
	CPUs                        int64
	Memory                      int64
	Timeout                     time.Duration
	Concurrency                 int
}

func defaultDeploymentLimits() deploymentLimits {
	return deploymentLimits{512 << 20, 2 << 30, 100000, 2, 2 << 30, 20 * time.Minute, 1}
}
func activeDeployment(state string) bool {
	return state == "queued" || state == "building" || state == "publishing"
}
