package model

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"
)

const maxStoreBytes = 16 << 20

var profileID = regexp.MustCompile(`^model-[a-f0-9]{32}$`)
var serviceID = regexp.MustCompile(`^service-[a-f0-9]{32}$`)
var reasoningLevel = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)

type storedProfile struct {
	Profile
	Secret  string `json:"credential"`
	Removed bool   `json:"removed,omitempty"`
}

type document struct {
	Version  int             `json:"version"`
	Profiles []storedProfile `json:"profiles"`
}

// Store 在内存中持有全部不可变修订；所有修改先持久化再对调用者可见。
type Store struct {
	mu      sync.RWMutex
	path    string
	records []Profile
	write   func(string, []Profile) (bool, error)
}

func Open(path string) (*Store, error) {
	if !filepath.IsAbs(path) {
		return nil, problem(400, "invalid-profile-path", "模型配置必须使用绝对路径")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, storageError()
	}
	records, err := readProfiles(path)
	if err != nil {
		return nil, err
	}
	return &Store{path: path, records: records, write: writeProfiles}, nil
}

func (s *Store) List() []Profile {
	s.mu.RLock()
	defer s.mu.RUnlock()
	latest := make(map[string]Profile)
	for _, p := range s.records {
		latest[p.ID] = p
	}
	result := make([]Profile, 0, len(latest))
	for _, p := range latest {
		if !p.Removed {
			result = append(result, p.Public())
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Model != result[j].Model {
			return result[i].Model < result[j].Model
		}
		return result[i].ID < result[j].ID
	})
	return result
}

func (s *Store) Create(input Input) (Profile, error) {
	p, err := fromInput(input, "")
	if err != nil {
		return Profile{}, err
	}
	var random [16]byte
	if _, err = rand.Read(random[:]); err != nil {
		return Profile{}, problem(503, "profile-id-unavailable", "无法分配模型配置编号")
	}
	p.ID, p.Revision = "model-"+hex.EncodeToString(random[:]), 1
	s.mu.Lock()
	defer s.mu.Unlock()
	if err = s.append(p); err != nil {
		return Profile{}, err
	}
	return p.Public(), nil
}

func (s *Store) Update(id string, expectedRevision int, input Input) (Profile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	latest, ok := s.latest(id)
	if !ok {
		return Profile{}, problem(404, "profile-not-found", "模型配置不存在")
	}
	if expectedRevision != latest.Revision {
		return Profile{}, problem(409, "revision-conflict", "模型配置已被修改，请重新读取后重试")
	}
	if latest.Service != nil || latest.Removed {
		return Profile{}, problem(409, "service-managed-profile", "请通过模型服务配置更新该模型")
	}
	p, err := fromInput(input, latest.Credential)
	if err != nil {
		return Profile{}, err
	}
	p.ID, p.Revision = id, latest.Revision+1
	if p.Revision <= latest.Revision {
		return Profile{}, problem(409, "revision-limit", "模型配置修订数量达到上限")
	}
	if err = s.append(p); err != nil {
		return Profile{}, err
	}
	return p.Public(), nil
}

// Resolve 仅供父进程内部使用，返回指定修订的凭据。停用最新版本阻止全部新运行。
func (s *Store) Resolve(id string, revision int, allowInactive bool) (Profile, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	latest, ok := s.latest(id)
	if !ok {
		return Profile{}, problem(404, "profile-not-found", "模型配置不存在")
	}
	for _, p := range s.records {
		if p.ID == id && p.Revision == revision {
			if !allowInactive && (!latest.Active || !p.Active) {
				return Profile{}, problem(409, "profile-inactive", "模型配置已停用，不能开始新的运行")
			}
			p.Capabilities = p.Capabilities.clone()
			return p, nil
		}
	}
	return Profile{}, problem(404, "profile-revision-not-found", "模型配置修订不存在")
}

func (s *Store) latest(id string) (Profile, bool) {
	for i := len(s.records) - 1; i >= 0; i-- {
		if s.records[i].ID == id {
			return s.records[i], true
		}
	}
	return Profile{}, false
}

func (s *Store) append(profiles ...Profile) error {
	records := append(append([]Profile(nil), s.records...), profiles...)
	committed, err := s.write(s.path, records)
	if committed {
		// rename 后目录同步失败属于结果未确认；内存仍须与可见文件保持一致。
		s.records = records
	}
	return err
}

func fromInput(in Input, oldCredential string) (Profile, error) {
	p := Profile{
		Provider:  in.Provider,
		APIFormat: in.APIFormat,
		BaseURL:   strings.TrimRight(strings.TrimSpace(in.BaseURL), "/"),
		Model:     strings.TrimSpace(in.Model), ContextTokens: in.ContextTokens, OutputTokens: in.OutputTokens,
		Capabilities: in.Capabilities.clone(), Active: in.Active, Credential: oldCredential,
	}
	if in.Credential != nil {
		p.Credential = *in.Credential
	}
	p.HasCredential = p.Credential != ""
	p.Capabilities.Source = strings.TrimSpace(p.Capabilities.Source)
	if err := validateProfile(p); err != nil {
		return Profile{}, err
	}
	return p, nil
}

func validateProfile(p Profile) error {
	if p.Service != nil {
		ref := p.Service
		validID := profileID.MatchString(ref.ID) || serviceID.MatchString(ref.ID)
		if !validID || ref.Revision < 1 || !cleanText(ref.Name, 120) || p.Active != (ref.Active && ref.Enabled) {
			return problem(400, "invalid-profile", "模型服务修订或开关无效")
		}
	}
	if p.APIFormat != FormatChatCompletions && p.APIFormat != FormatAnthropicMessages && p.APIFormat != FormatResponses {
		return problem(400, "invalid-profile", "模型 API 格式必须是 Chat Completions、Anthropic Messages 或 Responses")
	}
	if p.Provider != ProviderOpenAICompatible && p.Provider != ProviderDeepSeek {
		return problem(400, "invalid-profile", "模型供应商必须是 OpenAI 兼容接口或 DeepSeek")
	}
	if strings.TrimSpace(p.Credential) == "" {
		return problem(400, "invalid-profile", "请配置 API Key")
	}
	if !cleanText(p.Model, 200) || !cleanText(p.BaseURL, 2048) || !cleanText(p.Capabilities.Source, 80) {
		return problem(400, "invalid-profile", "模型服务地址、模型标识与能力来源必须是有效文本")
	}
	u, err := url.Parse(p.BaseURL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" {
		return problem(400, "invalid-profile", "模型服务地址必须是无凭据、查询参数或片段的 HTTP 或 HTTPS 地址")
	}
	if p.ContextTokens < 1 || p.ContextTokens > 2_000_000 || p.OutputTokens < 1 || p.OutputTokens > p.ContextTokens {
		return problem(400, "invalid-profile", "模型上下文与输出上限必须为有效的正整数，输出不能超过上下文")
	}
	if len(p.Capabilities.ReasoningLevels) > 16 {
		return problem(400, "invalid-profile", "模型推理等级不能超过 16 项")
	}
	seenReasoning := make(map[string]bool, len(p.Capabilities.ReasoningLevels))
	for _, level := range p.Capabilities.ReasoningLevels {
		if !reasoningLevel.MatchString(level) {
			return problem(400, "invalid-profile", "模型推理等级无效")
		}
		if seenReasoning[level] {
			return problem(400, "invalid-profile", "模型推理等级不能重复")
		}
		seenReasoning[level] = true
	}
	if len(p.Credential) > 8192 || !utf8.ValidString(p.Credential) || strings.IndexFunc(p.Credential, unicode.IsControl) >= 0 {
		return problem(400, "invalid-profile", "模型凭据格式无效")
	}
	// 明文 HTTP 会把 Bearer 凭据原样送上网，只有不出网卡的回环地址允许携带凭据。
	if u.Scheme == "http" && p.Credential != "" && !loopbackHost(u.Hostname()) {
		return problem(400, "invalid-profile", "HTTP 模型服务地址携带凭据时仅允许本机回环地址，请改用 HTTPS 或清除凭据")
	}
	return nil
}

// loopbackHost 判定主机是否为本机回环；明文 HTTP 仅在回环内允许携带凭据。
func loopbackHost(host string) bool {
	switch strings.ToLower(host) {
	case "127.0.0.1", "::1", "localhost":
		return true
	}
	return false
}

func cleanText(value string, limit int) bool {
	return value != "" && len(value) <= limit && utf8.ValidString(value) && strings.IndexFunc(value, unicode.IsControl) < 0
}

func readProfiles(path string) ([]Profile, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return []Profile{}, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxStoreBytes {
		return nil, storageError()
	}
	// 历史文件权限也收口，避免旧权限使已保存凭据可被其他用户读取。
	if err := os.Chmod(path, 0600); err != nil {
		return nil, storageError()
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, storageError()
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxStoreBytes+1))
	if err != nil || len(b) > maxStoreBytes {
		return nil, storageError()
	}
	var d document
	if json.Unmarshal(b, &d) != nil || d.Version != 1 || d.Profiles == nil {
		return nil, problem(503, "profile-storage", "模型配置文件格式无效，请检查配置文件")
	}
	revisions := make(map[string]int)
	records := make([]Profile, 0, len(d.Profiles))
	for i, stored := range d.Profiles {
		p := stored.Profile
		p.Credential, p.HasCredential = stored.Secret, stored.Secret != ""
		p.Removed = stored.Removed
		// 拒载报错指明具体条目与原因：存量配置被新校验拒绝时，手工修复不必逐条翻找。
		locate := "第 " + strconv.Itoa(i+1) + " 条模型配置"
		if profileID.MatchString(p.ID) {
			locate = "模型配置 " + p.ID + "（第 " + strconv.Itoa(i+1) + " 条）"
		}
		if !profileID.MatchString(p.ID) || p.Revision != revisions[p.ID]+1 {
			return nil, problem(503, "profile-storage", locate+"的修订号无效，请检查配置文件")
		}
		if err := validateProfile(p); err != nil {
			return nil, problem(503, "profile-storage", locate+"："+err.Error())
		}
		if p.Removed && p.Active {
			return nil, problem(503, "profile-storage", locate+"已移除但仍启用")
		}
		revisions[p.ID] = p.Revision
		records = append(records, p)
	}
	latest := map[string]Profile{}
	for _, p := range records {
		latest[p.ID] = p
	}
	groups := map[string]Profile{}
	for _, p := range latest {
		if p.Service == nil || p.Removed {
			continue
		}
		if old, ok := groups[p.Service.ID]; ok && (old.Service.Revision != p.Service.Revision || old.Service.Name != p.Service.Name || old.Service.Active != p.Service.Active || old.Provider != p.Provider || old.APIFormat != p.APIFormat || old.BaseURL != p.BaseURL || old.Credential != p.Credential) {
			return nil, problem(503, "profile-storage", "同一模型服务的配置不一致")
		}
		groups[p.Service.ID] = p
	}
	return records, nil
}

func writeProfiles(path string, records []Profile) (bool, error) {
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return false, storageError()
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, storageError()
	}
	d := document{Version: 1, Profiles: make([]storedProfile, 0, len(records))}
	for _, p := range records {
		d.Profiles = append(d.Profiles, storedProfile{Profile: p.Public(), Secret: p.Credential, Removed: p.Removed})
	}
	b, err := json.Marshal(d)
	if err != nil || len(b) > maxStoreBytes {
		return false, problem(503, "profile-storage", "模型配置存储达到容量上限")
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".model-profiles-*")
	if err != nil {
		return false, storageError()
	}
	tempPath := f.Name()
	defer os.Remove(tempPath)
	defer f.Close()
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(b)
	}
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil || os.Rename(tempPath, path) != nil {
		return false, storageError()
	}
	dir, err := os.Open(filepath.Dir(path))
	if err == nil {
		err = dir.Sync()
		if closeErr := dir.Close(); err == nil {
			err = closeErr
		}
	}
	if err != nil {
		return true, problem(503, "profile-write-unconfirmed", "模型配置已写入但持久化结果未确认，请重新读取后检查")
	}
	return true, nil
}

func storageError() *Error {
	return problem(503, "profile-storage", "模型配置读取或持久化失败")
}

// Available 包含仍可被会话选择的旧修订；修改能力声明不撤销固定版本。
func (s *Store) Available() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	active := make(map[string]bool)
	for _, p := range s.records {
		active[p.ID] = p.Active
	}
	for _, p := range s.records {
		if active[p.ID] && p.Active && p.Capabilities.Text && p.Capabilities.Tools {
			return true
		}
	}
	return false
}
