package mcp

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/jsonvalue"
)

const maxStoreBytes = 32 << 20

var serverID = regexp.MustCompile(`^mcp-[a-f0-9]{32}$`)
var grantID = regexp.MustCompile(`^grant-[a-f0-9]{32}$`)
var envName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)

type storedServer struct {
	Server
	Secret      string            `json:"credential"`
	Environment map[string]string `json:"environment,omitempty"`
}
type storedCatalog struct {
	ServerID string  `json:"serverId"`
	Revision int     `json:"revision"`
	Catalog  Catalog `json:"catalog"`
}
type document struct {
	Version  int             `json:"version"`
	Servers  []storedServer  `json:"servers"`
	Catalogs []storedCatalog `json:"catalogs"`
}
type Store struct {
	mu       sync.RWMutex
	path     string
	records  []Server
	catalogs []storedCatalog
	write    func(string, []Server, []storedCatalog) (bool, error)
}

func Open(path string) (*Store, error) {
	if !filepath.IsAbs(path) {
		return nil, problem(400, "invalid-mcp-path", "MCP 配置必须使用绝对路径")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, storageError()
	}
	s := &Store{path: path, records: []Server{}, catalogs: []storedCatalog{}, write: writeDocument}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxStoreBytes {
		return nil, storageError()
	}
	if os.Chmod(path, 0600) != nil {
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
	b, err = jsonvalue.Canonical(b)
	if err != nil {
		return nil, storageError()
	}
	var doc document
	if json.Unmarshal(b, &doc) != nil || doc.Version != 1 || doc.Servers == nil || doc.Catalogs == nil {
		return nil, storageError()
	}
	revisions := make(map[string]int)
	revoked := make(map[string]bool)
	for _, stored := range doc.Servers {
		p := stored.Server
		p.Credential = stored.Secret
		p.HasCredential = p.Credential != ""
		if p.Stdio != nil {
			p.Stdio.Environment = stored.Environment
			p.Stdio.HasEnvironment = len(stored.Environment) > 0
		} else if len(stored.Environment) > 0 {
			return nil, storageError()
		}
		if !serverID.MatchString(p.ID) || p.Revision != revisions[p.ID]+1 || validateServer(p) != nil || (revoked[p.ID] && !p.Revoked) {
			return nil, storageError()
		}
		revisions[p.ID] = p.Revision
		revoked[p.ID] = p.Revoked
		s.records = append(s.records, p)
	}
	seen := make(map[string]bool)
	for _, stored := range doc.Catalogs {
		if stored.Revision < 1 || stored.Revision > revisions[stored.ServerID] {
			return nil, storageError()
		}
		canonical, err := NormalizeCatalog(stored.Catalog)
		key := catalogKey(stored.ServerID, stored.Revision, stored.Catalog.Digest)
		if err != nil || canonical.Digest != stored.Catalog.Digest || seen[key] {
			return nil, storageError()
		}
		seen[key] = true
		s.catalogs = append(s.catalogs, storedCatalog{ServerID: stored.ServerID, Revision: stored.Revision, Catalog: canonical})
	}
	return s, nil
}

func (s *Store) List() []Server {
	s.mu.RLock()
	defer s.mu.RUnlock()
	latest := make(map[string]Server)
	for _, p := range s.records {
		latest[p.ID] = p.Public()
	}
	out := make([]Server, 0, len(latest))
	for _, p := range latest {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].ID < out[j].ID
	})
	return out
}
func (s *Store) Create(in Input) (Server, error) {
	p, err := fromInput(in, Server{})
	if err != nil {
		return Server{}, err
	}
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return Server{}, problem(503, "mcp-id-unavailable", "无法分配 MCP 服务编号")
	}
	p.ID = "mcp-" + hex.EncodeToString(b[:])
	p.Revision = 1
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.persist(append(append([]Server(nil), s.records...), p), s.catalogs); err != nil {
		return Server{}, err
	}
	return p.Public(), nil
}
func (s *Store) Update(id string, expectedRevision int, in Input) (Server, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	old, ok := s.latest(id)
	if !ok {
		return Server{}, problem(404, "mcp-not-found", "MCP 服务不存在")
	}
	if old.Revision != expectedRevision {
		return Server{}, problem(409, "revision-conflict", "MCP 配置已修改，请重新读取后重试")
	}
	if old.Revoked && !in.Revoked {
		return Server{}, problem(409, "mcp-revoked", "已撤销的 MCP 服务不能恢复，请创建新的配置")
	}
	p, err := fromInput(in, old)
	if err != nil {
		return Server{}, err
	}
	p.ID = id
	p.Revision = old.Revision + 1
	if p.Revision <= old.Revision {
		return Server{}, problem(409, "revision-limit", "MCP 配置修订数量达到上限")
	}
	if err := s.persist(append(append([]Server(nil), s.records...), p), s.catalogs); err != nil {
		return Server{}, err
	}
	return p.Public(), nil
}
func (s *Store) Resolve(id string, revision int, allowInactive bool) (Server, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.resolve(id, revision, allowInactive)
}
func (s *Store) resolve(id string, revision int, allowInactive bool) (Server, error) {
	latest, ok := s.latest(id)
	if !ok {
		return Server{}, problem(404, "mcp-not-found", "MCP 服务不存在")
	}
	if latest.Revoked {
		return Server{}, problem(409, "mcp-revoked", "MCP 服务已撤销，历史修订也不能继续执行")
	}
	for _, p := range s.records {
		if p.ID == id && p.Revision == revision {
			if !allowInactive && (!latest.Active || !p.Active) {
				return Server{}, problem(409, "mcp-inactive", "MCP 服务已停用，不能开始新运行")
			}
			return cloneServer(p), nil
		}
	}
	return Server{}, problem(404, "mcp-revision-not-found", "MCP 配置修订不存在")
}
func (s *Store) latest(id string) (Server, bool) {
	for i := len(s.records) - 1; i >= 0; i-- {
		if s.records[i].ID == id {
			return s.records[i], true
		}
	}
	return Server{}, false
}

// SaveCatalog 持久化不可变目录；同一摘要重复探测不会修改旧快照。
func (s *Store) SaveCatalog(id string, revision int, catalog Catalog) (Catalog, error) {
	catalog, err := NormalizeCatalog(catalog)
	if err != nil {
		return Catalog{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.resolve(id, revision, true); err != nil {
		return Catalog{}, err
	}
	for i, p := range s.catalogs {
		if p.ServerID == id && p.Revision == revision && p.Catalog.Digest == catalog.Digest {
			// 目录可能从 A 变为 B 后又恢复 A；保留快照内容，同时更新当前指针顺序。
			if i != len(s.catalogs)-1 {
				all := append([]storedCatalog(nil), s.catalogs[:i]...)
				all = append(all, s.catalogs[i+1:]...)
				all = append(all, p)
				if err := s.persist(s.records, all); err != nil {
					return Catalog{}, err
				}
			}
			return cloneCatalog(p.Catalog), nil
		}
	}
	all := append(append([]storedCatalog(nil), s.catalogs...), storedCatalog{ServerID: id, Revision: revision, Catalog: catalog})
	if err := s.persist(s.records, all); err != nil {
		return Catalog{}, err
	}
	return cloneCatalog(catalog), nil
}

// Catalog 的空摘要选择该修订最近一次探测目录；非空摘要只返回固定快照。
func (s *Store) Catalog(id string, revision int, digest string) (Catalog, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, err := s.resolve(id, revision, true); err != nil {
		return Catalog{}, err
	}
	for i := len(s.catalogs) - 1; i >= 0; i-- {
		p := s.catalogs[i]
		if p.ServerID == id && p.Revision == revision && (digest == "" || p.Catalog.Digest == digest) {
			return cloneCatalog(p.Catalog), nil
		}
	}
	return Catalog{}, problem(404, "mcp-catalog-not-found", "MCP 服务尚无匹配的已验证目录")
}
func (s *Store) persist(records []Server, catalogs []storedCatalog) error {
	committed, err := s.write(s.path, records, catalogs)
	if committed {
		s.records = records
		s.catalogs = catalogs
	}
	return err
}
func fromInput(in Input, old Server) (Server, error) {
	p := Server{Name: strings.TrimSpace(in.Name), Transport: in.Transport, URL: strings.TrimSpace(in.URL), Active: in.Active, Revoked: in.Revoked, Credential: old.Credential}
	if in.Credential != nil {
		p.Credential = *in.Credential
	}
	p.HasCredential = p.Credential != ""
	if in.Stdio != nil {
		p.Stdio = &ContainerSpec{Image: in.Stdio.Image, Command: append([]string(nil), in.Stdio.Command...), GrantID: in.Stdio.GrantID, GrantRevision: in.Stdio.GrantRevision, RequestedAccess: config.CloneAccessScope(in.Stdio.RequestedAccess)}
		if old.Stdio != nil {
			p.Stdio.Environment = cloneMap(old.Stdio.Environment)
		}
		if in.Stdio.Environment != nil {
			p.Stdio.Environment = cloneMap(*in.Stdio.Environment)
		}
		p.Stdio.HasEnvironment = len(p.Stdio.Environment) > 0
	}
	if err := validateServer(p); err != nil {
		return Server{}, err
	}
	return p, nil
}
func validateServer(p Server) error {
	bad := func() error {
		return problem(400, "invalid-mcp-server", "MCP 服务名称、传输配置或凭据格式无效")
	}
	if !cleanText(p.Name, 120) || len(p.Credential) > 8192 || !utf8.ValidString(p.Credential) || strings.IndexFunc(p.Credential, unicode.IsControl) >= 0 || (p.Revoked && p.Active) {
		return bad()
	}
	switch p.Transport {
	case "streamable-http":
		u, err := url.Parse(p.URL)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" || !cleanText(p.URL, 2048) || p.Stdio != nil {
			return bad()
		}
	case "stdio":
		if p.URL != "" || p.Credential != "" || p.Stdio == nil || !cleanText(p.Stdio.Image, 512) || len(p.Stdio.Command) == 0 || len(p.Stdio.Command) > 64 || len(p.Stdio.Environment) > 128 {
			return bad()
		}
		if (p.Stdio.GrantID == "" && p.Stdio.GrantRevision != 0) || (p.Stdio.GrantID != "" && (!grantID.MatchString(p.Stdio.GrantID) || p.Stdio.GrantRevision < 1)) {
			return problem(400, "invalid-mcp-grant", "MCP 容器授权必须同时固定有效编号和具体修订")
		}
		if p.Stdio.RequestedAccess != nil {
			if p.Stdio.GrantID != "" || p.Stdio.GrantRevision != 0 {
				return problem(400, "invalid-mcp-access", "运行需求不能与旧授权引用同时设置")
			}
			if err := config.ValidateAccessDeclaration(*p.Stdio.RequestedAccess); err != nil {
				return err
			}
		}
		for _, arg := range p.Stdio.Command {
			if len(arg) > 4096 || !utf8.ValidString(arg) || strings.IndexByte(arg, 0) >= 0 {
				return bad()
			}
		}
		if p.Stdio.Command[0] == "" {
			return bad()
		}
		for k, v := range p.Stdio.Environment {
			if !envName.MatchString(k) || len(v) > 8192 || !utf8.ValidString(v) || strings.IndexByte(v, 0) >= 0 {
				return bad()
			}
		}
	default:
		return bad()
	}
	return nil
}
func cleanText(s string, n int) bool {
	return s != "" && len(s) <= n && utf8.ValidString(s) && strings.IndexFunc(s, unicode.IsControl) < 0
}
func cloneMap(in map[string]string) map[string]string {
	if in == nil {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
func cloneServer(s Server) Server {
	if s.Stdio != nil {
		c := *s.Stdio
		c.Command = append([]string(nil), c.Command...)
		c.Environment = cloneMap(c.Environment)
		c.RequestedAccess = config.CloneAccessScope(c.RequestedAccess)
		s.Stdio = &c
	}
	return s
}
func cloneCatalog(c Catalog) Catalog {
	b, _ := json.Marshal(c)
	var out Catalog
	_ = json.Unmarshal(b, &out)
	return out
}
func catalogKey(id string, revision int, digest string) string {
	b, _ := json.Marshal([]any{id, revision, digest})
	return string(b)
}

// NormalizeCatalog 验证全部 schema 并生成与获取时间无关的目录摘要。
func NormalizeCatalog(c Catalog) (Catalog, error) {
	if c.ProtocolVersion != ProtocolVersion || len(c.Tools)+len(c.Resources)+len(c.Prompts) > MaxCatalogEntries {
		return Catalog{}, protocolError()
	}
	if len(c.Tools) > 0 && !c.Capabilities.Tools || len(c.Resources) > 0 && !c.Capabilities.Resources || len(c.Prompts) > 0 && !c.Capabilities.Prompts {
		return Catalog{}, protocolError()
	}
	c = cloneCatalog(c)
	names := make(map[string]bool)
	for i := range c.Tools {
		t := &c.Tools[i]
		if !cleanText(t.Name, 256) || names[t.Name] || len(t.Description) > 32768 {
			return Catalog{}, protocolError()
		}
		names[t.Name] = true
		var err error
		t.InputSchema, err = normalizeSchema(t.InputSchema)
		if err != nil {
			return Catalog{}, err
		}
		if len(t.OutputSchema) > 0 {
			t.OutputSchema, err = normalizeSchema(t.OutputSchema)
			if err != nil {
				return Catalog{}, err
			}
		}
		if len(t.Annotations) > 0 {
			if _, err = jsonvalue.Object(t.Annotations); err != nil {
				return Catalog{}, protocolError()
			}
			t.Annotations, err = jsonvalue.Canonical(t.Annotations)
			if err != nil {
				return Catalog{}, protocolError()
			}
		}
	}
	names = make(map[string]bool)
	for _, r := range c.Resources {
		if !cleanText(r.URI, 4096) || !cleanText(r.Name, 256) || names[r.URI] || len(r.Description) > 32768 {
			return Catalog{}, protocolError()
		}
		names[r.URI] = true
	}
	names = make(map[string]bool)
	for _, p := range c.Prompts {
		if !cleanText(p.Name, 256) || names[p.Name] || len(p.Description) > 32768 || len(p.Arguments) > 128 {
			return Catalog{}, protocolError()
		}
		names[p.Name] = true
		args := make(map[string]bool)
		for _, a := range p.Arguments {
			if !cleanText(a.Name, 256) || args[a.Name] || len(a.Description) > 32768 {
				return Catalog{}, protocolError()
			}
			args[a.Name] = true
		}
	}
	sort.Slice(c.Tools, func(i, j int) bool { return c.Tools[i].Name < c.Tools[j].Name })
	sort.Slice(c.Resources, func(i, j int) bool { return c.Resources[i].URI < c.Resources[j].URI })
	sort.Slice(c.Prompts, func(i, j int) bool { return c.Prompts[i].Name < c.Prompts[j].Name })
	digestInput := c
	digestInput.Digest = ""
	digestInput.FetchedAt = time.Time{}
	b, err := json.Marshal(digestInput)
	if err != nil || len(b) > MaxCatalogBytes {
		return Catalog{}, protocolError()
	}
	b, err = jsonvalue.Canonical(b)
	if err != nil {
		return Catalog{}, protocolError()
	}
	sum := sha256.Sum256(b)
	c.Digest = hex.EncodeToString(sum[:])
	return c, nil
}

func writeDocument(path string, records []Server, catalogs []storedCatalog) (bool, error) {
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return false, storageError()
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, storageError()
	}
	d := document{Version: 1, Servers: make([]storedServer, 0, len(records)), Catalogs: catalogs}
	if d.Catalogs == nil {
		d.Catalogs = []storedCatalog{}
	}
	for _, s := range records {
		p := storedServer{Server: s.Public(), Secret: s.Credential}
		if s.Stdio != nil {
			p.Environment = s.Stdio.Environment
		}
		d.Servers = append(d.Servers, p)
	}
	b, err := json.Marshal(d)
	if err != nil || len(b) > maxStoreBytes {
		return false, storageError()
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".mcp-servers-*")
	if err != nil {
		return false, storageError()
	}
	defer os.Remove(f.Name())
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
	if err != nil || os.Rename(f.Name(), path) != nil {
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
		return true, problem(503, "mcp-write-unconfirmed", "MCP 配置已写入但持久化结果未确认，请重新读取检查")
	}
	return true, nil
}
