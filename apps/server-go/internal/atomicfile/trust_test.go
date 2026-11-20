package atomicfile

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestOpenTrustedChecksExplicitPolicy(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "record")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	alias, symlink := path+".hard", path+".symlink"
	if err := os.Link(path, alias); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(path, symlink); err != nil {
		t.Fatal(err)
	}
	uid := uint32(os.Getuid())
	otherUID := uid ^ 1
	for _, tc := range []struct {
		name string
		path string
		opts TrustOptions
		want error
	}{
		{"登记可读同属主硬链接", alias, TrustOptions{MaxBytes: 1, RejectPerm: 0o077, OwnerUID: &uid}, nil},
		{"拒绝硬链接", path, TrustOptions{MaxBytes: 1, RejectPerm: 0o077, SingleLink: true}, ErrUntrusted},
		{"拒绝不同属主", path, TrustOptions{MaxBytes: 1, RejectPerm: 0o077, OwnerUID: &otherUID}, ErrUntrusted},
		{"零字节上限", path, TrustOptions{MaxBytes: 0, RejectPerm: 0o077}, ErrUntrusted},
		{"拒绝目录", dir, TrustOptions{MaxBytes: 1 << 20, RejectPerm: 0o077}, ErrUntrusted},
		{"拒绝符号链接", symlink, TrustOptions{MaxBytes: 1, RejectPerm: 0o077}, syscall.ELOOP},
	} {
		t.Run(tc.name, func(t *testing.T) {
			file, err := OpenTrusted(tc.path, tc.opts)
			if file != nil {
				defer file.Close()
			}
			if !errors.Is(err, tc.want) || (file == nil) != (tc.want != nil) {
				t.Fatalf("打开结果 = %v, %v；期望错误 %v", file, err, tc.want)
			}
		})
	}
}
