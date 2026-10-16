package workspace

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

var taskPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

func validateTask(taskID string, revision int) error {
	if !taskPattern.MatchString(taskID) || revision < 0 {
		return problem(400, "workspace_invalid_version", "工作区任务标识或版本无效")
	}
	return nil
}

func validatePath(name string) error {
	if name == "" || len(name) > 1024 || !utf8.ValidString(name) || strings.ContainsAny(name, "\\:") || strings.HasPrefix(name, "/") {
		return problem(400, "workspace_invalid_path", "工作区文件路径无效")
	}
	parts := strings.Split(name, "/")
	if len(parts) > 32 {
		return problem(400, "workspace_invalid_path", "工作区文件路径层级过深")
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || len(part) > 255 {
			return problem(400, "workspace_invalid_path", "工作区文件路径包含非法路径段")
		}
		for _, r := range part {
			if unicode.IsControl(r) {
				return problem(400, "workspace_invalid_path", "工作区文件路径包含控制字符")
			}
		}
	}
	return nil
}

// ValidatePath exposes the same path policy used by every workspace storage
// operation. Callers can reject invalid model arguments before creating a
// candidate revision without duplicating the traversal and control-character
// checks in another package.
func ValidatePath(name string) error { return validatePath(name) }

// openRoot 从 / 的目录描述符逐段打开，任何父目录符号链接都会被拒绝。
// 调用方负责在可信路径配置层解析部署中明确允许的 ~/.Elysian 链接。
func openRoot(root string) (*os.File, error) {
	if !filepath.IsAbs(root) || root == "/" || filepath.Clean(root) != root {
		return nil, problem(400, "workspace_invalid_root", "工作区根目录必须是规范的绝对路径")
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, storageError(err)
	}
	for _, component := range strings.Split(strings.TrimPrefix(root, "/"), "/") {
		next, openErr := unix.Openat(fd, component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if openErr == unix.ENOENT {
			if mkdirErr := unix.Mkdirat(fd, component, 0o700); mkdirErr != nil && mkdirErr != unix.EEXIST {
				unix.Close(fd)
				return nil, storageError(mkdirErr)
			}
			next, openErr = unix.Openat(fd, component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		}
		unix.Close(fd)
		if openErr != nil {
			return nil, problem(400, "workspace_unsafe_root", "工作区根目录含链接或无法安全访问的路径")
		}
		fd = next
	}
	if err = unix.Fchmod(fd, 0o700); err != nil {
		unix.Close(fd)
		return nil, storageError(err)
	}
	return os.NewFile(uintptr(fd), root), nil
}

func safeFileAt(dir *os.File, name string, flags int) (*os.File, error) {
	fd, err := unix.Openat(int(dir.Fd()), name, flags|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0o600)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), name)
	var st unix.Stat_t
	if err = unix.Fstat(fd, &st); err != nil {
		f.Close()
		return nil, err
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG || st.Nlink != 1 || st.Mode&0o777 != 0o600 || st.Uid != uint32(os.Geteuid()) {
		f.Close()
		return nil, problem(409, "workspace_unsafe_file", "工作区只允许当前用户拥有的独立 0600 普通文件")
	}
	return f, nil
}
