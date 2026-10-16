//go:build linux

package files

import (
	"context"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestAgentFilesRejectACLReplacement(t *testing.T) {
	f, root, _ := testAgentFiles(t)
	path := filepath.Join(root, "acl.txt")
	if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	version := agentVersion(t, f, root, "acl.txt")
	// Linux POSIX ACL: owner rw, named user r, owning group none,
	// effective group mask r, others none. Replacing only mode would broaden
	// the owning group's access from none to read.
	acl := make([]byte, 4+5*8)
	binary.LittleEndian.PutUint32(acl, 2)
	for i, entry := range [][3]uint32{{1, 6, ^uint32(0)}, {2, 4, 1001}, {4, 0, ^uint32(0)}, {16, 4, ^uint32(0)}, {32, 0, ^uint32(0)}} {
		offset := 4 + i*8
		binary.LittleEndian.PutUint16(acl[offset:], uint16(entry[0]))
		binary.LittleEndian.PutUint16(acl[offset+2:], uint16(entry[1]))
		binary.LittleEndian.PutUint32(acl[offset+4:], entry[2])
	}
	if err := unix.Setxattr(path, "system.posix_acl_access", acl, 0); err != nil {
		if errors.Is(err, unix.ENOTSUP) {
			t.Skip("filesystem does not support POSIX ACLs")
		}
		t.Fatal(err)
	}
	if _, err := f.Write(context.Background(), root, "acl.txt", "changed", version); err == nil {
		t.Fatal("replacement discarded ACL restrictions")
	}
	content, err := os.ReadFile(path)
	if err != nil || string(content) != "original" {
		t.Fatal("rejected ACL write modified file", err)
	}
}
