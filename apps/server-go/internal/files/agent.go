package files

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

const agentTextLimit = 256 * 1024

var errAgentProtectedPath = errors.New("系统与面板状态路径不能经 Agent 文件工具访问")

type AgentRoot struct {
	Path     string
	Writable bool
}

// AgentRootAuthorization is the identity of a business directory captured by
// the trusted authorizer. It is not an input accepted from the model.
type AgentRootAuthorization struct {
	Path     string `json:"path"`
	Writable bool   `json:"writable"`
	Device   uint64 `json:"device"`
	Inode    uint64 `json:"inode"`
	// Only ConfiguredRoot can mark the explicit legacy startup path. Dynamic
	// dispatch facts reconstructed by the app always recheck trusted ancestors.
	legacy bool
}

type AgentOptions struct {
	Roots       []AgentRoot
	Authorize   func(context.Context) error
	ResolveRoot func(context.Context, string, bool) (AgentRootAuthorization, error)
}

type agentRootGrant struct {
	AgentRoot
	identity unix.Stat_t
}

// AgentFacade shares the HTTP service, but its public methods use descriptor-
// anchored IO instead of shell commands and never follow symbolic links.
type AgentFacade struct {
	service     fileService
	roots       map[string]agentRootGrant
	authorize   func(context.Context) error
	resolveRoot func(context.Context, string, bool) (AgentRootAuthorization, error)
	mu          *sync.Mutex
}

func NewAgentFacade(deps Deps, options AgentOptions) (*AgentFacade, error) {
	f := &AgentFacade{roots: map[string]agentRootGrant{}, authorize: options.Authorize, resolveRoot: options.ResolveRoot, mu: &sync.Mutex{}}
	if deps.Available && (deps.Accounts != nil || deps.service != nil) {
		host := deps.host
		if host == nil {
			host = newRealHostDeps()
		}
		f.service = deps.service
		if f.service == nil {
			f.service = newService(host, deps.Accounts)
		}
	}
	if s, ok := f.service.(*filesService); ok {
		f.mu = &s.mutationMu
	}
	for _, root := range options.Roots {
		if !filepath.IsAbs(root.Path) || filepath.Clean(root.Path) != root.Path || forbiddenAgentRoot(root.Path) {
			return f, errors.New("Agent 文件根必须是独立业务目录")
		}
		fd, err := openAgentAbsoluteDirectory(root.Path)
		if err != nil {
			return f, errors.New("Agent 文件根必须是现存无链接目录")
		}
		var identity unix.Stat_t
		err = unix.Fstat(fd, &identity)
		unix.Close(fd)
		if err != nil {
			return f, errors.New("Agent 文件根身份无法核实")
		}
		f.roots[root.Path] = agentRootGrant{AgentRoot: root, identity: identity}
	}
	return f, nil
}

func forbiddenAgentRoot(path string) bool {
	if agentProtectedPath(path) {
		return true
	}
	if path == "/" || path == "/home" || path == "/Users" || path == "/var" || path == "/tmp" {
		return true
	}
	for _, p := range strings.Split(path, "/") {
		if agentSecretName(p) {
			return true
		}
	}
	return false
}

func agentProtectedPath(path string) bool {
	for _, base := range []string{"/etc", "/proc", "/sys", "/dev", "/boot", "/bin", "/sbin", "/usr", "/lib", "/lib64", "/run", "/root", "/var/run", "/var/log", "/var/cache", "/var/spool", "/var/lib/docker", "/var/lib/containerd", "/var/lib/elysian", "/var/lib/apt", "/var/lib/dpkg", "/var/lib/systemd"} {
		if path == base || strings.HasPrefix(path, base+"/") {
			return true
		}
	}
	return false
}

func agentSecretName(name string) bool {
	n := strings.ToLower(name)
	if strings.HasPrefix(n, ".env") || strings.HasPrefix(n, ".elysian-") {
		return true
	}
	for _, blocked := range []string{".ssh", ".aws", ".azure", ".config", ".docker", ".elysian", ".git", "credentials", "secrets", "node_modules"} {
		if n == blocked {
			return true
		}
	}
	for _, suffix := range []string{".pem", ".key", ".p12", ".pfx", ".keystore", ".kdbx"} {
		if strings.HasSuffix(n, suffix) {
			return true
		}
	}
	return strings.Contains(n, "credential") || strings.Contains(n, "private_key") || strings.Contains(n, "secret")
}

func (f *AgentFacade) Available() bool {
	return f != nil && f.service != nil && (len(f.roots) > 0 || f.resolveRoot != nil) && f.authorize != nil
}

// DynamicRoots reports whether roots are selected from the current dispatch.
// It affects tool discovery only; it never grants access to any path.
func (f *AgentFacade) DynamicRoots() bool { return f != nil && f.resolveRoot != nil }

// ConfiguredRoot exposes an immutable startup identity for the app's explicit
// legacy dispatch path. Dynamic authorization never falls back to this map.
func (f *AgentFacade) ConfiguredRoot(root string, write bool) (AgentRootAuthorization, error) {
	if f != nil {
		if grant, ok := f.roots[root]; ok && (!write || grant.Writable) {
			return AgentRootAuthorization{Path: root, Writable: grant.Writable, Device: uint64(grant.identity.Dev), Inode: uint64(grant.identity.Ino), legacy: true}, nil
		}
	}
	return AgentRootAuthorization{}, errors.New("业务目录未授权")
}
func (f *AgentFacade) Roots() []string {
	roots := []string{}
	if f != nil {
		for root := range f.roots {
			roots = append(roots, root)
		}
	}
	sort.Strings(roots)
	return roots
}

func agentRelative(path string, directory bool) ([]string, error) {
	if directory && (path == "" || path == ".") {
		return nil, nil
	}
	if path == "" || filepath.IsAbs(path) || filepath.Clean(path) != path || strings.ContainsAny(path, "\\\x00\r\n") {
		return nil, errors.New("文件路径须为规范相对路径")
	}
	parts := strings.Split(path, "/")
	for _, p := range parts {
		if p == ".." || p == "." || p == "" || agentSecretName(p) {
			return nil, errors.New("文件路径包含禁用内容")
		}
	}
	return parts, nil
}

func openAgentAbsoluteDirectory(path string) (int, error) {
	return openAgentRootDirectory(path, false)
}

// InspectAgentRoot captures an approval-time identity without retaining a
// descriptor or changing the facade's configured roots. Ancestors must be
// trusted, matching the execution mount boundary.
func InspectAgentRoot(root AgentRoot) (AgentRootAuthorization, error) {
	if !filepath.IsAbs(root.Path) || filepath.Clean(root.Path) != root.Path || forbiddenAgentRoot(root.Path) {
		return AgentRootAuthorization{}, errors.New("Agent 文件根必须是独立业务目录")
	}
	fd, err := openAgentRootDirectory(root.Path, true)
	if err != nil {
		return AgentRootAuthorization{}, err
	}
	defer unix.Close(fd)
	var identity unix.Stat_t
	if err := unix.Fstat(fd, &identity); err != nil {
		return AgentRootAuthorization{}, errors.New("Agent 文件根身份无法核实")
	}
	return AgentRootAuthorization{Path: root.Path, Writable: root.Writable, Device: uint64(identity.Dev), Inode: uint64(identity.Ino)}, nil
}

func openAgentRootDirectory(path string, trustedAncestors bool) (int, error) {
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	for _, part := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		if part == "" {
			continue
		}
		if trustedAncestors {
			var stat unix.Stat_t
			if unix.Fstat(fd, &stat) != nil || stat.Uid != 0 || stat.Mode&0022 != 0 {
				unix.Close(fd)
				return -1, errors.New("授权目录的所有祖先必须由 root 持有且不可被组或其他用户写入")
			}
		}
		next, e := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		unix.Close(fd)
		if e != nil {
			return -1, e
		}
		fd = next
	}
	return fd, nil
}

func (f *AgentFacade) parent(ctx context.Context, root, path string, write, directory bool) (int, string, error) {
	if _, err := agentRelative(path, directory); err != nil {
		return -1, "", err
	}
	if agentProtectedPath(filepath.Join(root, path)) {
		return -1, "", errAgentProtectedPath
	}
	scope, err := f.openRoot(ctx, root, write)
	if err != nil {
		return -1, "", err
	}
	defer unix.Close(scope.fd)
	return scope.parent(path, directory)
}

type agentRootScope struct {
	fd   int
	path string
}

func (f *AgentFacade) openRoot(ctx context.Context, root string, write bool) (*agentRootScope, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !f.Available() {
		return nil, errors.New("业务文件能力未配置")
	}
	if err := f.authorize(ctx); err != nil {
		return nil, err
	}
	var grant AgentRootAuthorization
	var err error
	if f.resolveRoot != nil {
		grant, err = f.resolveRoot(ctx, root, write)
	} else {
		grant, err = f.ConfiguredRoot(root, write)
	}
	if err != nil {
		return nil, err
	}
	if grant.Path != root || write && !grant.Writable || !filepath.IsAbs(root) || filepath.Clean(root) != root || forbiddenAgentRoot(root) || grant.Inode == 0 {
		return nil, errors.New("业务目录未授权")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	fd, err := openAgentRootDirectory(root, f.resolveRoot != nil && !grant.legacy)
	if err != nil {
		return nil, errors.New("业务目录不可访问")
	}
	var identity unix.Stat_t
	if unix.Fstat(fd, &identity) != nil || uint64(identity.Dev) != grant.Device || uint64(identity.Ino) != grant.Inode {
		unix.Close(fd)
		return nil, errors.New("授权业务根目录身份已变化，须重新申请授权")
	}
	return &agentRootScope{fd: fd, path: root}, nil
}

func (scope *agentRootScope) parent(path string, directory bool) (int, string, error) {
	parts, err := agentRelative(path, directory)
	if err != nil {
		return -1, "", err
	}
	if agentProtectedPath(filepath.Join(scope.path, path)) {
		return -1, "", errAgentProtectedPath
	}
	fd, err := unix.Openat(scope.fd, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, "", errors.New("业务目录不可访问")
	}
	count := len(parts)
	name := "."
	if !directory {
		count--
		name = parts[len(parts)-1]
	}
	for _, p := range parts[:count] {
		next, e := unix.Openat(fd, p, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		unix.Close(fd)
		if e != nil {
			return -1, "", errors.New("文件父目录不可访问或含链接")
		}
		fd = next
	}
	return fd, name, nil
}

func (f *AgentFacade) List(ctx context.Context, root, path string) (any, error) {
	fd, _, err := f.parent(ctx, root, path, false, true)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), "business-directory")
	defer file.Close()
	names, err := file.Readdirnames(501)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, errors.New("读取业务目录失败")
	}
	sort.Strings(names)
	rows := []map[string]any{}
	for _, name := range names {
		if agentSecretName(name) || agentProtectedPath(filepath.Join(root, path, name)) {
			continue
		}
		var st unix.Stat_t
		if unix.Fstatat(fd, name, &st, unix.AT_SYMLINK_NOFOLLOW) != nil {
			continue
		}
		kind := "file"
		if st.Mode&unix.S_IFMT == unix.S_IFDIR {
			kind = "directory"
		} else if st.Mode&unix.S_IFMT != unix.S_IFREG || st.Nlink != 1 {
			continue
		}
		if len(rows) == 500 {
			break
		}
		rows = append(rows, map[string]any{"name": name, "kind": kind, "size": st.Size})
	}
	return map[string]any{"root": root, "path": path, "entries": rows, "truncated": len(names) > 500}, ctx.Err()
}

func (f *AgentFacade) Read(ctx context.Context, root, path string) (any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	parent, name, err := f.parent(ctx, root, path, false, false)
	if err != nil {
		return nil, err
	}
	defer unix.Close(parent)
	fd, err := unix.Openat(parent, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New("业务文件不可读取")
	}
	file := os.NewFile(uintptr(fd), "business-file")
	defer file.Close()
	var st unix.Stat_t
	if unix.Fstat(fd, &st) != nil || st.Mode&unix.S_IFMT != unix.S_IFREG || st.Nlink != 1 || st.Size > agentTextLimit {
		return nil, errors.New("仅允许读取不超过 256 KiB 的单链接普通文本文件")
	}
	data, err := io.ReadAll(io.LimitReader(file, agentTextLimit+1))
	if err != nil || len(data) > agentTextLimit || !utf8.Valid(data) || strings.IndexByte(string(data), 0) >= 0 {
		return nil, errors.New("文件不是有效的受限文本")
	}
	sum := sha256.Sum256(data)
	return map[string]any{"root": root, "path": path, "content": string(data), "version": hex.EncodeToString(sum[:])}, ctx.Err()
}

// Write compares the exact contents under the shared HTTP/Agent mutation lock.
// External writers in the authorized directory are outside this CAS boundary.
func (f *AgentFacade) Write(ctx context.Context, root, path, content, expected string) (any, error) {
	if expected == "" || len(content) > agentTextLimit || !utf8.ValidString(content) || strings.IndexByte(content, 0) >= 0 {
		return nil, errors.New("必须提供预期版本和 256 KiB 内有效文本")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	parent, name, err := f.parent(ctx, root, path, true, false)
	if err != nil {
		return nil, err
	}
	defer unix.Close(parent)
	var existing *agentFile
	mode := uint32(0600)
	if expected != "missing" {
		existing, err = readAgentFile(parent, name)
		if err != nil {
			return nil, err
		}
		defer existing.file.Close()
		if err := agentRequireNoACL(int(existing.file.Fd())); err != nil {
			return nil, err
		}
		if existing.version != expected {
			return nil, errors.New("文件内容版本已变化，请重新读取并审批")
		}
		mode = uint32(existing.stat.Mode) & 0777
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, errors.New("新建准备失败")
	}
	temp := ".elysian-agent-" + hex.EncodeToString(nonce[:])
	fd, err := unix.Openat(parent, temp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, mode)
	if err != nil {
		return nil, errors.New("新建准备失败")
	}
	defer unix.Unlinkat(parent, temp, 0)
	file := os.NewFile(uintptr(fd), "business-file")
	if existing != nil {
		if err := unix.Fchown(fd, int(existing.stat.Uid), int(existing.stat.Gid)); err != nil {
			file.Close()
			return nil, errors.New("无法保留文件属主，替换已取消")
		}
		if err := unix.Fchmod(fd, mode); err != nil {
			file.Close()
			return nil, errors.New("无法保留文件权限，替换已取消")
		}
		if err := agentRequireNoACL(fd); err != nil {
			file.Close()
			return nil, err
		}
	}
	_, writeErr := io.WriteString(file, content)
	if writeErr == nil {
		writeErr = file.Sync()
	}
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		return nil, errors.New("文件写入结果未确认，请重新读取，不能自动重试")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if existing == nil {
		if err := unix.Linkat(parent, temp, parent, name, 0); err != nil {
			return nil, errors.New("新建被拒绝：目标可能已存在，请重新读取")
		}
	} else {
		if err := existing.verify(parent, name); err != nil {
			return nil, err
		}
		if err := agentRequireNoACL(int(existing.file.Fd())); err != nil {
			return nil, err
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if err := unix.Renameat(parent, temp, parent, name); err != nil {
			return nil, errors.New("替换失败，请回读确认实际状态")
		}
	}
	if err := unix.Fsync(parent); err != nil {
		return nil, errors.New("文件已发布但目录同步失败，请回读确认")
	}
	sum := sha256.Sum256([]byte(content))
	return map[string]any{"root": root, "path": path, "created": existing == nil, "version": hex.EncodeToString(sum[:])}, ctx.Err()
}

type agentFile struct {
	file    *os.File
	stat    unix.Stat_t
	data    []byte
	version string
}

func readAgentFile(parent int, name string) (*agentFile, error) {
	fd, err := unix.Openat(parent, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New("文件不可读取或为链接")
	}
	f := &agentFile{file: os.NewFile(uintptr(fd), "business-file")}
	fail := func() (*agentFile, error) {
		f.file.Close()
		return nil, errors.New("仅允许 256 KiB 内的单链接普通文本")
	}
	if unix.Fstat(fd, &f.stat) != nil || f.stat.Mode&unix.S_IFMT != unix.S_IFREG || f.stat.Nlink != 1 || f.stat.Size > agentTextLimit {
		return fail()
	}
	f.data, err = io.ReadAll(io.LimitReader(f.file, agentTextLimit+1))
	if err != nil || len(f.data) > agentTextLimit || !utf8.Valid(f.data) || strings.IndexByte(string(f.data), 0) >= 0 {
		return fail()
	}
	sum := sha256.Sum256(f.data)
	f.version = hex.EncodeToString(sum[:])
	return f, nil
}

func (f *agentFile) verify(parent int, name string) error {
	var st unix.Stat_t
	if unix.Fstatat(parent, name, &st, unix.AT_SYMLINK_NOFOLLOW) != nil || st.Dev != f.stat.Dev || st.Ino != f.stat.Ino || st.Mode != f.stat.Mode || st.Uid != f.stat.Uid || st.Gid != f.stat.Gid || st.Mode&unix.S_IFMT != unix.S_IFREG || st.Nlink != 1 {
		return errors.New("文件身份已变化，请重新读取并审批")
	}
	if _, err := f.file.Seek(0, 0); err != nil {
		return errors.New("文件版本无法复核")
	}
	data, err := io.ReadAll(io.LimitReader(f.file, agentTextLimit+1))
	sum := sha256.Sum256(data)
	if err != nil || len(data) > agentTextLimit || hex.EncodeToString(sum[:]) != f.version {
		return errors.New("文件版本已变化，请重新读取并审批")
	}
	return nil
}

// Change accepts one regular file only. There is no recursive removal, target
// overwrite, cross-root move, permission change, or raw host command escape.
func (f *AgentFacade) Change(ctx context.Context, root, path, target, expected, action string) (any, error) {
	if expected == "" || expected == "missing" {
		return nil, errors.New("必须提供源文件的精确内容版本")
	}
	if _, err := agentRelative(path, false); err != nil {
		return nil, err
	}
	if agentProtectedPath(filepath.Join(root, path)) {
		return nil, errAgentProtectedPath
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	scope, err := f.openRoot(ctx, root, true)
	if err != nil {
		return nil, err
	}
	defer unix.Close(scope.fd)
	parent, name, err := scope.parent(path, false)
	if err != nil {
		return nil, err
	}
	defer unix.Close(parent)
	source, err := readAgentFile(parent, name)
	if err != nil {
		return nil, err
	}
	defer source.file.Close()
	if source.version != expected {
		return nil, errors.New("源文件版本已变化，请重新读取并审批")
	}
	if action == "delete" {
		if err := source.verify(parent, name); err != nil {
			return nil, err
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if err := unix.Unlinkat(parent, name, 0); err != nil {
			return nil, errors.New("删除失败，请回读实际状态")
		}
		if err := unix.Fsync(parent); err != nil {
			return nil, errors.New("删除已提交但目录同步失败，请回读实际状态")
		}
		return map[string]any{"root": root, "path": path, "deleted": true}, nil
	}
	if action != "copy" && action != "move" {
		return nil, errors.New("文件变更未开放")
	}
	if path == target {
		return nil, errors.New("源文件与目标不能相同")
	}
	dest, destName, err := scope.parent(target, false)
	if err != nil {
		return nil, err
	}
	defer unix.Close(dest)
	if err := source.verify(parent, name); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if action == "move" {
		if err := agentRenameNoReplace(parent, name, dest, destName); err != nil {
			return nil, errors.New("移动失败，目标可能已存在；请回读实际状态")
		}
		if err := unix.Fsync(parent); err != nil {
			return nil, errors.New("移动已提交但源目录同步失败，请回读实际状态")
		}
	} else {
		var nonce [16]byte
		if _, err := rand.Read(nonce[:]); err != nil {
			return nil, err
		}
		temp := ".elysian-agent-" + hex.EncodeToString(nonce[:])
		fd, err := unix.Openat(dest, temp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0600)
		if err != nil {
			return nil, errors.New("复制准备失败")
		}
		defer unix.Unlinkat(dest, temp, 0)
		file := os.NewFile(uintptr(fd), "business-copy")
		if err := unix.Fchmod(fd, 0600); err != nil {
			file.Close()
			return nil, errors.New("无法固定副本为私有权限，复制已取消")
		}
		_, err = file.Write(source.data)
		if err == nil {
			err = file.Sync()
		}
		closeErr := file.Close()
		if err != nil || closeErr != nil {
			return nil, errors.New("复制写入失败")
		}
		if err := source.verify(parent, name); err != nil {
			return nil, err
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if err := unix.Linkat(dest, temp, dest, destName, 0); err != nil {
			return nil, errors.New("复制发布失败，目标可能已存在")
		}
	}
	if err := unix.Fsync(dest); err != nil {
		return nil, errors.New("文件变更已提交但目标目录同步失败，请回读实际状态")
	}
	return map[string]any{"root": root, "path": path, "target": target, "action": action, "version": source.version}, ctx.Err()
}
