package docker

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"syscall"
)

// agentServiceCredentialRecord 是一个 service-v1 容器的登记事实；凭据值只落本文件，
// 不进模型参数、回执与运行记录。
type agentServiceCredentialRecord struct {
	Name          string            `json:"name"`
	ContainerID   string            `json:"containerId,omitempty"`
	Credentials   map[string]string `json:"credentials"`
	VolumeNames   []string          `json:"volumeNames,omitempty"`
	NetworkScope  string            `json:"networkScope"`
	HostPort      int               `json:"hostPort,omitempty"`
	Port          int               `json:"port,omitempty"`
	ResourceTier  string            `json:"resourceTier"`
	ContainerPath []string          `json:"containerPath,omitempty"`
	CreatedAt     string            `json:"createdAt"`
}

// agentCredentialStore 收口在装配层注入的 JSON 文件；进程内互斥，磁盘原子替换。
type agentCredentialStore struct {
	path string
	mu   sync.Mutex
}

func newAgentCredentialStore(path string) *agentCredentialStore {
	return &agentCredentialStore{path: path}
}

func (s *agentCredentialStore) load() ([]agentServiceCredentialRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked()
}

func (s *agentCredentialStore) loadLocked() ([]agentServiceCredentialRecord, error) {
	file, err := os.OpenFile(s.path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("读取服务容器登记失败")
	}
	defer file.Close()
	var records []agentServiceCredentialRecord
	if err := json.NewDecoder(file).Decode(&records); err != nil {
		return nil, fmt.Errorf("解析服务容器登记失败")
	}
	return records, nil
}

func (s *agentCredentialStore) find(name string) (*agentServiceCredentialRecord, error) {
	records, err := s.load()
	if err != nil {
		return nil, err
	}
	for i := range records {
		if records[i].Name == name {
			clone := records[i]
			clone.Credentials = map[string]string{}
			for key, value := range records[i].Credentials {
				clone.Credentials[key] = value
			}
			return &clone, nil
		}
	}
	return nil, nil
}

// save 按 name upsert：同容器重试沿用既有凭据，不重新生成。
func (s *agentCredentialStore) save(record agentServiceCredentialRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	records, err := s.loadLocked()
	if err != nil {
		return err
	}
	replaced := false
	for i := range records {
		if records[i].Name == record.Name {
			records[i] = record
			replaced = true
			break
		}
	}
	if !replaced {
		records = append(records, record)
	}
	raw, err := json.MarshalIndent(records, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomicDocker(s.path, raw)
}

// generateAgentSecret 生成 24 随机字节的十六进制凭据；失败属系统级故障直接 panic。
func generateAgentSecret() string {
	var buffer [24]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		panic(fmt.Sprintf("无法生成随机凭据：%v", err))
	}
	return hex.EncodeToString(buffer[:])
}

// writeFileAtomicDocker 与 internal/database/atomicfile.go 的 writeFileAtomic 同构；
// docker 域不依赖 database 包，故自带一份。
func writeFileAtomicDocker(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary := path + "." + fmt.Sprintf("%d", os.Getpid()) + ".tmp"
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		os.Remove(temporary)
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		os.Remove(temporary)
		return err
	}
	if err := file.Close(); err != nil {
		os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		os.Remove(temporary)
		return err
	}
	return nil
}
