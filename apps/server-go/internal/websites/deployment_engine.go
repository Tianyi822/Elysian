package websites

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"elysian/server/internal/seam"
)

type deploymentEngine struct {
	transport seam.DockerTransport
	limits    deploymentLimits
	owner     string
}

func (e deploymentEngine) json(ctx context.Context, method, path string, body any) (map[string]any, error) {
	var b []byte
	var err error
	if body != nil {
		b, err = json.Marshal(body)
		if err != nil {
			return nil, err
		}
	}
	r, err := e.transport.Request(ctx, seam.EngineRequest{Method: method, Path: path, Body: b, MaxBytes: 4 << 20})
	if err != nil {
		return nil, err
	}
	if r.Status >= 300 {
		return nil, fmt.Errorf("Docker 操作失败（%d）：%s", r.Status, strings.TrimSpace(string(r.Body)))
	}
	out := map[string]any{}
	if len(r.Body) > 0 {
		if err = json.Unmarshal(r.Body, &out); err != nil {
			return nil, err
		}
	}
	return out, nil
}
func (e deploymentEngine) pull(ctx context.Context, image string) error {
	if image == "" || strings.Contains(image, ":latest") {
		return errors.New("构建镜像必须指定精确版本")
	}
	if cached, err := e.transport.Request(ctx, seam.EngineRequest{Method: "GET", Path: "/images/" + url.PathEscape(image) + "/json"}); err == nil && cached.Status == 200 {
		return nil
	}
	var failure string
	pending := ""
	r, err := e.transport.Stream(ctx, seam.EngineRequest{Method: "POST", Path: "/images/create", Query: url.Values{"fromImage": {image}}, MaxBytes: 16 << 20, DiscardBody: true}, func(b []byte) {
		pending += string(b)
		for {
			idx := strings.IndexByte(pending, '\n')
			if idx < 0 {
				break
			}
			line := pending[:idx]
			pending = pending[idx+1:]
			var row struct {
				Error string `json:"error"`
			}
			if json.Unmarshal([]byte(line), &row) == nil && row.Error != "" {
				failure = row.Error
			}
		}
		if len(pending) > 1<<20 {
			pending = ""
			failure = "镜像拉取进度超限"
		}
	})
	if err != nil {
		return err
	}
	if r.Status >= 300 || failure != "" {
		return fmt.Errorf("镜像拉取失败：%s", failure)
	}
	return nil
}
func (e deploymentEngine) create(ctx context.Context, image string, cmd []string, env []string, tmpfs bool) (string, error) {
	host := map[string]any{"Memory": e.limits.Memory, "NanoCpus": e.limits.CPUs * 1e9, "PidsLimit": 512, "CapDrop": []string{"ALL"}, "SecurityOpt": []string{"no-new-privileges:true"}, "RestartPolicy": map[string]string{"Name": "no"}, "LogConfig": map[string]any{"Type": "json-file", "Config": map[string]string{"max-size": "10m", "max-file": "1"}}}
	if tmpfs {
		host["Tmpfs"] = map[string]string{"/run/credentials": "rw,noexec,nosuid,size=64k,mode=0700"}
	}
	r, err := e.json(ctx, "POST", "/containers/create", map[string]any{"Image": image, "Cmd": cmd, "Env": env, "WorkingDir": "/app", "Labels": map[string]string{"elysian.managed": "true", "elysian.website.build": "true", "elysian.website.deployment-owner": e.owner}, "HostConfig": host})
	if err != nil {
		return "", err
	}
	id, _ := r["Id"].(string)
	if !containerIDPattern.MatchString(id) {
		return "", errors.New("构建容器 ID 无效")
	}
	return id, nil
}
func (e deploymentEngine) remove(id string) {
	if id == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, _ = e.transport.Request(ctx, seam.EngineRequest{Method: "DELETE", Path: "/containers/" + id, Query: url.Values{"force": {"true"}, "v": {"true"}}})
}
func (e deploymentEngine) put(ctx context.Context, id, root string) error {
	r, w := io.Pipe()
	done := make(chan error, 1)
	go func() { err := tarDirectory(ctx, root, w); _ = w.CloseWithError(err); done <- err }()
	resp, err := e.transport.Request(ctx, seam.EngineRequest{Method: "PUT", Path: "/containers/" + id + "/archive", Query: url.Values{"path": {"/app"}}, BodyReader: r, Timeout: e.limits.Timeout, ContentType: "application/x-tar"})
	_ = r.Close()
	writeErr := <-done
	if err != nil {
		return err
	}
	if writeErr != nil {
		return writeErr
	}
	if resp.Status >= 300 {
		return errors.New("无法传入构建工作区")
	}
	return nil
}
func (e deploymentEngine) secret(ctx context.Context, id, token string) error {
	var b bytes.Buffer
	tw := tar.NewWriter(&b)
	files := map[string]string{"token": token, "askpass": "#!/bin/sh\ncase \"$1\" in *Username*) printf '%s' oauth2;; *) cat /run/credentials/token;; esac\n"}
	for name, text := range files {
		mode := int64(0600)
		if name == "askpass" {
			mode = 0700
		}
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: mode, Size: int64(len(text)), Typeflag: tar.TypeReg}); err != nil {
			return err
		}
		if _, err := tw.Write([]byte(text)); err != nil {
			return err
		}
	}
	_ = tw.Close()
	r, err := e.transport.Request(ctx, seam.EngineRequest{Method: "PUT", Path: "/containers/" + id + "/archive", Query: url.Values{"path": {"/run/credentials"}}, Body: b.Bytes()})
	if err != nil {
		return err
	}
	if r.Status >= 300 {
		return errors.New("无法设置临时 Git 认证")
	}
	return nil
}

// Docker 非 TTY 日志是八字节帧头；逐帧写盘，限制单帧与总流长度。
func (e deploymentEngine) run(ctx context.Context, id string, log io.Writer) error {
	if _, err := e.json(ctx, "POST", "/containers/"+id+"/start", nil); err != nil {
		return err
	}
	logCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		reader, writer := io.Pipe()
		decodeDone := make(chan error, 1)
		go func() { decodeDone <- decodeDockerLogs(reader, log); _ = reader.Close() }()
		r, err := e.transport.Stream(logCtx, seam.EngineRequest{Method: "GET", Path: "/containers/" + id + "/logs", Query: url.Values{"stdout": {"true"}, "stderr": {"true"}, "follow": {"true"}}, MaxBytes: 64 << 20, ResponseWriter: writer}, nil)
		if err == nil && r.Status >= 300 {
			err = errors.New("读取构建日志失败")
		}
		_ = writer.CloseWithError(err)
		de := <-decodeDone
		if err == nil {
			err = de
		}
		done <- err
	}()
	resp, err := e.transport.Request(ctx, seam.EngineRequest{Method: "POST", Path: "/containers/" + id + "/wait", Query: url.Values{"condition": {"not-running"}}, Timeout: e.limits.Timeout})
	if err != nil {
		cancel()
		<-done
		return err
	}
	logErr := <-done
	if logErr != nil {
		return logErr
	}
	var out struct {
		StatusCode int
		Error      *struct{ Message string }
	}
	if resp.Status >= 300 || json.Unmarshal(resp.Body, &out) != nil {
		return errors.New("无法读取构建退出状态")
	}
	if out.StatusCode != 0 {
		return fmt.Errorf("容器执行失败，退出码 %d", out.StatusCode)
	}
	return nil
}
func decodeDockerLogs(r io.Reader, w io.Writer) error {
	for {
		var header [8]byte
		_, err := io.ReadFull(r, header[:])
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		n := int64(binary.BigEndian.Uint32(header[4:]))
		if n > 4<<20 {
			return errors.New("单条构建日志过大")
		}
		if _, err = io.CopyN(w, r, n); err != nil {
			return err
		}
	}
}
func (e deploymentEngine) export(ctx context.Context, id, path, root string) error {
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	r, w := io.Pipe()
	done := make(chan error, 1)
	go func() {
		b := extractBudget{limits: e.limits}
		err := extractTar(ctx, tar.NewReader(r), root, &b, filepath.Base(path))
		_ = r.CloseWithError(err)
		done <- err
	}()
	resp, err := e.transport.Stream(ctx, seam.EngineRequest{Method: "GET", Path: "/containers/" + id + "/archive", Query: url.Values{"path": {path}}, MaxBytes: e.limits.ExpandedBytes + int64(e.limits.Entries)*1024, ResponseWriter: w}, nil)
	if err == nil && resp.Status >= 300 {
		err = errors.New("导出产物目录失败")
	}
	_ = w.CloseWithError(err)
	extractErr := <-done
	if err != nil {
		return err
	}
	return extractErr
}
func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
func (e deploymentEngine) exec(ctx context.Context, id string, cmd []string, w io.Writer) error {
	out, err := e.json(ctx, "POST", "/containers/"+id+"/exec", map[string]any{"AttachStdout": true, "AttachStderr": true, "Cmd": cmd})
	if err != nil {
		return err
	}
	execID, _ := out["Id"].(string)
	if execID == "" {
		return errors.New("无法创建容器执行步骤")
	}
	r, p := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- decodeDockerLogs(r, w); _ = r.Close() }()
	b, _ := json.Marshal(map[string]bool{"Detach": false, "Tty": false})
	resp, err := e.transport.Stream(ctx, seam.EngineRequest{Method: "POST", Path: "/exec/" + execID + "/start", Body: b, ResponseWriter: p, MaxBytes: 64 << 20}, nil)
	_ = p.CloseWithError(err)
	de := <-done
	if err != nil {
		return err
	}
	if de != nil {
		return de
	}
	if resp.Status >= 300 {
		return errors.New("容器执行步骤失败")
	}
	out, err = e.json(ctx, "GET", "/exec/"+execID+"/json", nil)
	if err != nil {
		return err
	}
	if code, ok := out["ExitCode"].(float64); !ok || code != 0 {
		return errors.New("容器执行步骤返回失败")
	}
	return nil
}
