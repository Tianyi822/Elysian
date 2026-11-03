package panel

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// GitHub 的 tarball 在源码根目录前携带记录提交 SHA 的 PAX 全局头。
func sourceArchiveWithPAX(t *testing.T, entries ...tar.Header) []byte {
	t.Helper()
	var b bytes.Buffer
	z := gzip.NewWriter(&b)
	w := tar.NewWriter(z)
	global := tar.Header{
		Name:       "pax_global_header",
		Typeflag:   tar.TypeXGlobalHeader,
		PAXRecords: map[string]string{"comment": strings.Repeat("b", 40)},
	}
	for _, h := range append([]tar.Header{global}, entries...) {
		if h.Typeflag == tar.TypeReg {
			h.Size = int64(len("source\n"))
		}
		if err := w.WriteHeader(&h); err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeReg {
			if _, err := w.Write([]byte("source\n")); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func TestGitHubDownloadAcceptsPAXGlobalHeader(t *testing.T) {
	sha := strings.Repeat("b", 40)
	prefix := "Tianyi822-Elysian-bbbbbbb/"
	body := sourceArchiveWithPAX(t,
		tar.Header{Name: prefix, Typeflag: tar.TypeDir},
		tar.Header{Name: prefix + "package.json", Typeflag: tar.TypeReg},
		tar.Header{Name: prefix + "scripts/", Typeflag: tar.TypeDir},
		tar.Header{Name: prefix + "scripts/build-release.sh", Typeflag: tar.TypeReg},
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/"+Repository+"/tarball/"+sha {
			t.Errorf("下载未锁定提交：%s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/gzip")
		_, _ = w.Write(body)
	}))
	defer srv.Close()
	root := t.TempDir()
	source := GitHubSource{Client: srv.Client(), API: srv.URL}
	if err := source.Download(context.Background(), sha, root); err != nil {
		t.Fatalf("GitHub PAX 归档解包失败：%v", err)
	}
	for _, name := range []string{"package.json", "scripts/build-release.sh"} {
		content, err := os.ReadFile(filepath.Join(root, name))
		if err != nil || string(content) != "source\n" {
			t.Fatalf("源码文件 %s 未正确解包：%q %v", name, content, err)
		}
	}
	if _, err := os.Lstat(filepath.Join(root, "pax_global_header")); !os.IsNotExist(err) {
		t.Fatalf("PAX 元数据不应写入文件系统：%v", err)
	}
}

func TestPAXSourceStillRejectsUnsafeEntries(t *testing.T) {
	for _, test := range []struct {
		name  string
		entry tar.Header
		want  string
	}{
		{"绝对路径", tar.Header{Name: "/escape", Typeflag: tar.TypeReg}, "包含非法路径"},
		{"反斜杠", tar.Header{Name: "repo\\escape", Typeflag: tar.TypeReg}, "包含非法路径"},
		{"目录越界", tar.Header{Name: "repo/../../escape", Typeflag: tar.TypeReg}, "包含目录越界"},
		{"多个根目录", tar.Header{Name: "other/file", Typeflag: tar.TypeReg}, "包含多个根目录"},
		{"符号链接", tar.Header{Name: "repo/link", Typeflag: tar.TypeSymlink, Linkname: "../escape"}, "不允许链接或特殊文件"},
		{"硬链接", tar.Header{Name: "repo/link", Typeflag: tar.TypeLink, Linkname: "repo/file"}, "不允许链接或特殊文件"},
		{"特殊文件", tar.Header{Name: "repo/pipe", Typeflag: tar.TypeFifo}, "不允许链接或特殊文件"},
		{"根目录是普通文件", tar.Header{Name: "repo", Typeflag: tar.TypeReg}, "源码根目录无效"},
		{"普通文件冒充元数据", tar.Header{Name: "pax_global_header", Typeflag: tar.TypeReg}, "包含多个根目录"},
	} {
		t.Run(test.name, func(t *testing.T) {
			body := sourceArchiveWithPAX(t, tar.Header{Name: "repo/", Typeflag: tar.TypeDir}, test.entry)
			err := extractSource(bytes.NewReader(body), t.TempDir())
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("归档应因 %s 被拒绝，实际错误：%v", test.want, err)
			}
		})
	}
}
