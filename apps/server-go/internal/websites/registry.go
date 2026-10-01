package websites

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

/*
 * 网站项目登记（websitesRegistry.ts 逐字移植）：站点的事实来源——站点目录、容器身份、
 * 绑定域名与部署命令都固化在这里，Caddy 路由配置每次由登记全量重新推导（无第二份需要
 * 同步的状态）。读写纪律照 databaseRegistry 先例：O_NOFOLLOW 读 + 权限/属主/大小校验，
 * 0600 临时文件（uuid 后缀）+ fsync + rename 原子写，串行队列防交错；登记不含凭据
 * （证书只存引用与公开元数据）。
 */

// WebsiteCertificateRef 证书在登记里的形态：私有证书文件引用与公开元数据；
// PEM 与私钥均不进入登记。
type WebsiteCertificateRef struct {
	Ref            string `json:"ref"`
	Issuer         string `json:"issuer"`
	NotAfter       string `json:"notAfter"`
	Fingerprint256 string `json:"fingerprint256"`
}

// WebsiteRecord 登记行（JSON 键序即 TS 对象插入序；存量 TS 版 websites.json 直接可读）。
type WebsiteRecord struct {
	ID             string                 `json:"id"`
	Kind           string                 `json:"kind"`
	Name           string                 `json:"name"`
	Port           int                    `json:"port"`
	RuntimeVersion *string                `json:"runtimeVersion"`
	RootDir        string                 `json:"rootDir"`
	Domain         *string                `json:"domain"`
	AccessMode     string                 `json:"accessMode"`
	Certificate    *WebsiteCertificateRef `json:"certificate"`
	ContainerName  *string                `json:"containerName"`
	ContainerID    *string                `json:"containerId"`
	ImageRef       *string                `json:"imageRef"`
	DeployCommand  *string                `json:"deployCommand"`
	Enabled        bool                   `json:"enabled"`
	Category       string                 `json:"category"`
	ExpiryAt       *string                `json:"expiryAt"`
	Note           *string                `json:"note"`
	GitURL         *string                `json:"gitUrl"`
	CreatedAt      string                 `json:"createdAt"`
}

// Registry 网站登记接口（文件实现为生产缺省，内存实现为测试/降级用）。
type Registry interface {
	List(ctx context.Context) ([]WebsiteRecord, error)
	Put(ctx context.Context, record WebsiteRecord) error
	Remove(ctx context.Context, id string) error
}

// NewFileWebsiteRegistry 文件版登记：path 缺省 ~/.Elysian/config/websites.json。
func NewFileWebsiteRegistry(path string) Registry {
	return &fileWebsiteRegistry{path: path}
}

type fileWebsiteRegistry struct {
	path string
	mu   sync.Mutex
}

// read 读取并校验登记文件：不存在 → 空表；内容/权限不可信 → 显式报错不静默清空。
func (r *fileWebsiteRegistry) read() ([]WebsiteRecord, error) {
	handle, err := openNoFollow(r.path)
	if err != nil {
		if isENOENT(err) {
			return nil, nil
		}
		return nil, err
	}
	defer handle.Close()
	info, err := handle.Stat()
	if err != nil {
		return nil, err
	}
	if !statTrusted(info, registryMaxBytes) {
		return nil, errRegistryUnusable
	}
	data, err := readAll(handle)
	if err != nil {
		return nil, err
	}
	// 文件是本进程写出的私有数据；先验根形态（非数组显式报错），再按类型解码。
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, err
	}
	if _, ok := value.([]any); !ok {
		return nil, errRegistryInvalid
	}
	var rows []WebsiteRecord
	if len(value.([]any)) > 0 {
		if err := json.Unmarshal(data, &rows); err != nil {
			return nil, err
		}
	}
	return rows, nil
}

// write 以「随机后缀临时文件 + fsync + rename」原子替换登记文件。
func (r *fileWebsiteRegistry) write(rows []WebsiteRecord) error {
	if err := os.MkdirAll(filepath.Dir(r.path), 0o700); err != nil {
		return err
	}
	data, err := marshalJSONCompact(rows)
	if err != nil {
		return err
	}
	temporary := r.path + "." + randomUUID() + ".tmp"
	handle, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := handle.Write(data); err != nil {
		_ = handle.Close()
		_ = os.Remove(temporary)
		return err
	}
	if err := handle.Sync(); err != nil {
		_ = handle.Close()
		_ = os.Remove(temporary)
		return err
	}
	if err := handle.Close(); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, r.path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}

func (r *fileWebsiteRegistry) List(context.Context) ([]WebsiteRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.read()
}

func (r *fileWebsiteRegistry) Put(_ context.Context, record WebsiteRecord) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	rows, err := r.read()
	if err != nil {
		return err
	}
	updated := make([]WebsiteRecord, 0, len(rows)+1)
	for _, row := range rows {
		if row.ID != record.ID {
			updated = append(updated, row)
		}
	}
	updated = append(updated, record)
	return r.write(updated)
}

func (r *fileWebsiteRegistry) Remove(_ context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	rows, err := r.read()
	if err != nil {
		return err
	}
	updated := make([]WebsiteRecord, 0, len(rows))
	for _, row := range rows {
		if row.ID != id {
			updated = append(updated, row)
		}
	}
	return r.write(updated)
}

// NewMemoryWebsiteRegistry 内存版登记（测试用）：list 返回副本，外部改写不影响登记。
func NewMemoryWebsiteRegistry() *memoryWebsiteRegistry {
	return &memoryWebsiteRegistry{}
}

type memoryWebsiteRegistry struct {
	mu   sync.Mutex
	rows []WebsiteRecord
}

func (m *memoryWebsiteRegistry) List(context.Context) ([]WebsiteRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rows := make([]WebsiteRecord, len(m.rows))
	for i, row := range m.rows {
		rows[i] = copyRecord(row)
	}
	return rows, nil
}

func (m *memoryWebsiteRegistry) Put(_ context.Context, record WebsiteRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	updated := make([]WebsiteRecord, 0, len(m.rows)+1)
	for _, row := range m.rows {
		if row.ID != record.ID {
			updated = append(updated, row)
		}
	}
	updated = append(updated, copyRecord(record))
	m.rows = updated
	return nil
}

func (m *memoryWebsiteRegistry) Remove(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	updated := make([]WebsiteRecord, 0, len(m.rows))
	for _, row := range m.rows {
		if row.ID != id {
			updated = append(updated, row)
		}
	}
	m.rows = updated
	return nil
}

// copyRecord 深拷贝登记行的指针字段，防止调用方共享内部状态。
func copyRecord(row WebsiteRecord) WebsiteRecord {
	row.RuntimeVersion = copyStringPtr(row.RuntimeVersion)
	row.Domain = copyStringPtr(row.Domain)
	row.ContainerName = copyStringPtr(row.ContainerName)
	row.ContainerID = copyStringPtr(row.ContainerID)
	row.ImageRef = copyStringPtr(row.ImageRef)
	row.DeployCommand = copyStringPtr(row.DeployCommand)
	row.ExpiryAt = copyStringPtr(row.ExpiryAt)
	row.Note = copyStringPtr(row.Note)
	row.GitURL = copyStringPtr(row.GitURL)
	if row.Certificate != nil {
		cert := *row.Certificate
		row.Certificate = &cert
	}
	return row
}

func copyStringPtr(value *string) *string {
	if value == nil {
		return nil
	}
	copied := *value
	return &copied
}
