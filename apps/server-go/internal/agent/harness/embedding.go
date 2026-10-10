package harness

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"elysian/server/internal/agent/harness/model"
)

// embeddingSchema is deliberately SQLite-only. Vectors are JSON arrays so the
// page revision and its digest remain the authoritative index key; an optional
// native vector extension can be added without changing the Wiki contract.
const embeddingSchema = `
CREATE TABLE IF NOT EXISTS wiki_embedding_profiles(id TEXT NOT NULL,revision INTEGER NOT NULL,document TEXT NOT NULL,
 PRIMARY KEY(id,revision));
CREATE TABLE IF NOT EXISTS wiki_embedding_indexes(page_id TEXT NOT NULL,page_revision INTEGER NOT NULL,digest TEXT NOT NULL,
 profile_id TEXT NOT NULL,profile_revision INTEGER NOT NULL,vector TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(page_id,page_revision,profile_id,profile_revision));
CREATE INDEX IF NOT EXISTS wiki_embedding_page ON wiki_embedding_indexes(page_id,page_revision);
CREATE TABLE IF NOT EXISTS wiki_embedding_requests(id TEXT PRIMARY KEY,state TEXT NOT NULL,document TEXT NOT NULL);
`

type EmbeddingProfile struct {
	ID            string `json:"id"`
	Revision      int    `json:"revision"`
	Name          string `json:"name"`
	BaseURL       string `json:"baseUrl"`
	Model         string `json:"model"`
	Dimensions    int    `json:"dimensions"`
	Active        bool   `json:"active"`
	HasCredential bool   `json:"hasCredential"`
	Credential    string `json:"-"`
}
type EmbeddingProfileInput struct {
	Name       string  `json:"name"`
	BaseURL    string  `json:"baseUrl"`
	Model      string  `json:"model"`
	Dimensions int     `json:"dimensions"`
	Active     bool    `json:"active"`
	Credential *string `json:"credential,omitempty"`
}

func (p EmbeddingProfile) Public() EmbeddingProfile {
	p.HasCredential = p.HasCredential || p.Credential != ""
	p.Credential = ""
	return p
}
func validateEmbeddingProfile(p EmbeddingProfile) error {
	if p.Name == "" || len(p.Name) > 120 || !utf8.ValidString(p.Name) || p.Model == "" || len(p.Model) > 200 || !utf8.ValidString(p.Model) || p.Dimensions < 1 || p.Dimensions > 8192 {
		return bad("invalid-embedding-profile", "Embedding 配置名称、模型或维度无效")
	}
	u, err := url.Parse(strings.TrimRight(p.BaseURL, "/"))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return bad("invalid-embedding-profile", "Embedding 服务地址必须是无凭据、查询参数或片段的 HTTP 地址")
	}
	if len(p.Credential) > 8192 || !utf8.ValidString(p.Credential) {
		return bad("invalid-embedding-profile", "Embedding 凭据格式无效")
	}
	return nil
}

func embeddingFromInput(in EmbeddingProfileInput, old string, id string, revision int) (EmbeddingProfile, error) {
	p := EmbeddingProfile{ID: id, Revision: revision, Name: strings.TrimSpace(in.Name), BaseURL: strings.TrimRight(strings.TrimSpace(in.BaseURL), "/"), Model: strings.TrimSpace(in.Model), Dimensions: in.Dimensions, Active: in.Active, Credential: old}
	if in.Credential != nil {
		p.Credential = *in.Credential
	}
	p.HasCredential = p.Credential != ""
	return p, validateEmbeddingProfile(p)
}

func hashEmbeddingProfile(p EmbeddingProfile) string {
	b, _ := json.Marshal(struct {
		ID         string
		Revision   int
		Model      string
		Dimensions int
	}{p.ID, p.Revision, p.Model, p.Dimensions})
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func (m *Manager) listEmbeddingProfiles(ctx context.Context) ([]EmbeddingProfile, error) {
	records, err := m.readEmbeddingProfiles()
	if err != nil {
		return nil, err
	}
	latest := map[string]EmbeddingProfile{}
	for _, p := range records {
		latest[p.ID] = p
	}
	out := make([]EmbeddingProfile, 0, len(latest))
	for _, p := range latest {
		out = append(out, p.Public())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}
func (m *Manager) ListEmbeddingProfiles(ctx context.Context) ([]EmbeddingProfile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.listEmbeddingProfiles(ctx)
}
func (m *Manager) createEmbeddingProfile(ctx context.Context, in EmbeddingProfileInput) (EmbeddingProfile, error) {
	var p EmbeddingProfile
	id := m.deps.NewID()
	p, err := embeddingFromInput(in, "", id, 1)
	if err != nil {
		return p, err
	}
	records, err := m.readEmbeddingProfiles()
	if err != nil {
		return EmbeddingProfile{}, err
	}
	err = m.writeEmbeddingProfiles(append(records, p))
	if err != nil {
		return EmbeddingProfile{}, err
	}
	return p.Public(), nil
}
func (m *Manager) CreateEmbeddingProfile(ctx context.Context, in EmbeddingProfileInput) (EmbeddingProfile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.workflowWritable(); err != nil {
		return EmbeddingProfile{}, err
	}
	return m.createEmbeddingProfile(ctx, in)
}
func (m *Manager) updateEmbeddingProfile(ctx context.Context, id string, expected int, in EmbeddingProfileInput) (EmbeddingProfile, error) {
	var old EmbeddingProfile
	records, err := m.readEmbeddingProfiles()
	if err != nil {
		return old, err
	}
	for _, p := range records {
		if p.ID == id {
			old = p
		}
	}
	if old.ID == "" {
		return old, &Error{404, "embedding-profile-not-found", "Embedding 配置不存在"}
	}
	if old.Revision != expected {
		return old, &Error{409, "revision-conflict", "Embedding 配置已变化，请重新读取"}
	}
	p, err := embeddingFromInput(in, old.Credential, id, old.Revision+1)
	if err != nil {
		return old, err
	}
	err = m.writeEmbeddingProfiles(append(records, p))
	if err != nil {
		return old, err
	}
	return p.Public(), nil
}
func (m *Manager) UpdateEmbeddingProfile(ctx context.Context, id string, expected int, in EmbeddingProfileInput) (EmbeddingProfile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.workflowWritable(); err != nil {
		return EmbeddingProfile{}, err
	}
	return m.updateEmbeddingProfile(ctx, id, expected, in)
}

// embeddingCompleteHTTP is intentionally a narrow provider adapter. A failed
// provider request never makes search unavailable: callers fall back to text.
func embeddingCompleteHTTP(ctx context.Context, p EmbeddingProfile, input string) ([]float64, model.Usage, error) {
	usage := model.Usage{}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	if len(input) > wikiExtractionBytes {
		return nil, usage, errors.New("Embedding 输入超过容量限制")
	}
	b, _ := json.Marshal(map[string]any{"model": p.Model, "input": input})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(p.BaseURL, "/")+"/embeddings", strings.NewReader(string(b)))
	if err != nil {
		return nil, usage, err
	}
	req.Header.Set("Content-Type", "application/json")
	if p.Credential != "" {
		req.Header.Set("Authorization", "Bearer "+p.Credential)
	}
	client := &http.Client{Timeout: 60 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return nil, usage, errors.New("Embedding 服务请求失败")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, usage, errors.New("Embedding 服务返回异常状态")
	}
	var out struct {
		Data []struct {
			Embedding []float64 `json:"embedding"`
		} `json:"data"`
		Usage *struct {
			PromptTokens        *int `json:"prompt_tokens"`
			TotalTokens         *int `json:"total_tokens"`
			PromptTokensDetails *struct {
				CachedTokens *int `json:"cached_tokens"`
			} `json:"prompt_tokens_details"`
		} `json:"usage"`
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, (512<<10)+1))
	if err != nil || len(raw) > 512<<10 || json.Unmarshal(raw, &out) != nil {
		return nil, usage, errors.New("Embedding 响应格式或大小无效")
	}
	if out.Usage != nil {
		usage.PromptTokens, usage.TotalTokens = out.Usage.PromptTokens, out.Usage.TotalTokens
		if out.Usage.PromptTokensDetails != nil {
			usage.CachedTokens = out.Usage.PromptTokensDetails.CachedTokens
		}
		for _, count := range []*int{usage.PromptTokens, usage.TotalTokens, usage.CachedTokens} {
			if count != nil && *count < 0 {
				return nil, model.Usage{}, errors.New("Embedding 用量无效")
			}
		}
	}
	if len(out.Data) != 1 || len(out.Data[0].Embedding) != p.Dimensions {
		return nil, usage, errors.New("Embedding 响应维度无效")
	}
	for _, v := range out.Data[0].Embedding {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return nil, usage, errors.New("Embedding 向量包含无效值")
		}
	}
	return out.Data[0].Embedding, usage, nil
}

type storedEmbeddingProfile struct {
	EmbeddingProfile
	Secret string `json:"credential"`
}
type embeddingDocument struct {
	Version  int                      `json:"version"`
	Profiles []storedEmbeddingProfile `json:"profiles"`
}

func (m *Manager) embeddingConfigPath() string {
	return filepath.Join(filepath.Dir(filepath.Dir(m.deps.Path)), "config", "agent-embeddings.json")
}

func (m *Manager) readEmbeddingProfiles() ([]EmbeddingProfile, error) {
	path := m.embeddingConfigPath()
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return []EmbeddingProfile{}, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 4<<20 {
		return nil, bad("embedding-profile-storage", "Embedding 配置文件权限、类型或大小无效")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, bad("embedding-profile-storage", "Embedding 配置读取失败")
	}
	var doc embeddingDocument
	if json.Unmarshal(raw, &doc) != nil || doc.Version != 1 || doc.Profiles == nil {
		return nil, bad("embedding-profile-storage", "Embedding 配置文件格式无效")
	}
	result := make([]EmbeddingProfile, 0, len(doc.Profiles))
	revisions := map[string]int{}
	for _, record := range doc.Profiles {
		p := record.EmbeddingProfile
		p.Credential = record.Secret
		if !requestPattern.MatchString(p.ID) || p.Revision != revisions[p.ID]+1 || validateEmbeddingProfile(p) != nil {
			return nil, bad("embedding-profile-storage", "Embedding 配置修订无效")
		}
		revisions[p.ID] = p.Revision
		result = append(result, p)
	}
	return result, nil
}

func (m *Manager) writeEmbeddingProfiles(records []EmbeddingProfile) error {
	path := m.embeddingConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return bad("embedding-profile-storage", "Embedding 配置目录不可写")
	}
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() || err != nil && !errors.Is(err, os.ErrNotExist) {
		return bad("embedding-profile-storage", "Embedding 配置路径无效")
	}
	doc := embeddingDocument{Version: 1, Profiles: []storedEmbeddingProfile{}}
	for _, p := range records {
		doc.Profiles = append(doc.Profiles, storedEmbeddingProfile{EmbeddingProfile: p.Public(), Secret: p.Credential})
	}
	raw, err := json.Marshal(doc)
	if err != nil || len(raw) > 4<<20 {
		return bad("embedding-profile-storage", "Embedding 配置达到容量上限")
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".agent-embeddings-*")
	if err != nil {
		return bad("embedding-profile-storage", "Embedding 配置暂存失败")
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(raw)
	}
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil || os.Rename(file.Name(), path) != nil {
		return bad("embedding-profile-storage", "Embedding 配置写入失败")
	}
	dir, err := os.Open(filepath.Dir(path))
	if err == nil {
		err = dir.Sync()
		if closeErr := dir.Close(); err == nil {
			err = closeErr
		}
	}
	if err != nil {
		return bad("embedding-profile-write-unconfirmed", "Embedding 配置已写入，持久化结果未确认，请重新读取")
	}
	return nil
}
