package terminals

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"elysian/server/internal/seam"
)

// 会话管理器的 fake 驱动测试（盘点 §8.1 对等移植）：可编排字节的 fake PtyProcess、
// 可控假钟与 fake 宿主依赖，锚定启动行、ready 帧形状、input/interrupt 写入字节、
// 空闲超时、断开清理、并发上限、节流合帧、truncated、exit 路径与补全上下文。
// 不 spawn 真进程、不起真实定时器。

func waitForWrites(t *testing.T, f *serviceFixture) {
	t.Helper()
	waitFor(t, func() bool { return len(f.pty.writesSnapshot()) >= 1 }, "启动行未写入")
}

func waitForReady(t *testing.T, f *serviceFixture) {
	t.Helper()
	waitFor(t, func() bool {
		frames, _ := f.frames.snapshot()
		return len(frameTypes(frames)) >= 1
	}, "ready 帧未到达")
}

func waitForPrompt(t *testing.T, f *serviceFixture, count int) {
	t.Helper()
	waitFor(t, func() bool {
		frames, _ := f.frames.snapshot()
		return strings.Count(strings.Join(frameTypes(frames), ","), "prompt") >= count
	}, "prompt 帧未到达")
}

func TestBuildPtyEnv分页器一律指向cat(t *testing.T) {
	env := buildPtyEnv("/root", HostShellSessionSpec.Env)
	for _, key := range []string{"PAGER", "GIT_PAGER", "SYSTEMD_PAGER", "MANPAGER"} {
		if env[key] != "cat" {
			t.Fatalf("%s = %q，期望 cat", key, env[key])
		}
	}
	if env["PROMPT_COMMAND"] != `printf "\x01PWD:%s\x02\n" "$PWD"` {
		t.Fatalf("PROMPT_COMMAND = %q", env["PROMPT_COMMAND"])
	}
}

func Test启动Spawn用env白名单与HOME身份写启动行(t *testing.T) {
	f := newServiceFixture(t, fixtureOpts{})
	waitForWrites(t, f)
	spec := f.spawnEnv()
	want := buildPtyEnv("/root", HostShellSessionSpec.Env)
	if len(spec.Env) != len(want) {
		t.Fatalf("spawn env 键数 %d，期望 %d（%v vs %v）", len(spec.Env), len(want), spec.Env, want)
	}
	for k, v := range want {
		if spec.Env[k] != v {
			t.Fatalf("spawn env[%s] = %q，期望 %q", k, spec.Env[k], v)
		}
	}
	if spec.StartupLine != HostShellSessionSpec.StartupLine {
		t.Fatalf("startup line 未透传：%q", spec.StartupLine)
	}
	if ident := f.spawnIdentity(); ident.HomeDir != "/root" || ident.User != "root" {
		t.Fatalf("spawn identity = %+v", ident)
	}
	writes := f.pty.writesSnapshot()
	if writes[0] != TERMINAL_STARTUP_LINE {
		t.Fatalf("首写入应为启动行：%q", writes[0])
	}
	// 启动行文本与栅格常量锚定（cols/rows 编进字面量，防漂移）。
	wantLine := "stty cols " + strconv.Itoa(TERMINAL_COLS) + " rows " + strconv.Itoa(TERMINAL_ROWS) +
		" -echo; set +H; printf '\\x01READY\\x02\\n'\n"
	if TERMINAL_STARTUP_LINE != wantLine {
		t.Fatalf("启动行原文不符：%q，期望 %q", TERMINAL_STARTUP_LINE, wantLine)
	}
	f.session.dispose(disposeClientClose)
}

func TestREADY哨兵后发ready帧(t *testing.T) {
	f := newServiceFixture(t, fixtureOpts{})
	waitForWrites(t, f)
	f.pty.pushText(testReady + "\r\n")
	waitForReady(t, f)
	frames, _ := f.frames.snapshot()
	ready, ok := frames[0].(frameReady)
	if !ok {
		t.Fatalf("首帧应为 ready：%+v", frames)
	}
	if ready.Session.User != "root" || ready.Session.HostLabel != "elysian-web-1" {
		t.Fatalf("ready 身份不符：%+v", ready.Session)
	}
	if ready.Session.Prompt != "root@elysian-web-1:~$ " {
		t.Fatalf("HOME 应显示 ~：%q", ready.Session.Prompt)
	}
	if ready.Session.ID == "" {
		t.Fatal("会话 id 不应为空")
	}
	if strings.Join(ready.Completion.Commands, ",") != "bash,ls,whoami" {
		t.Fatalf("命令表不符：%v", ready.Completion.Commands)
	}
	if f.listCmdN.Load() != 1 {
		t.Fatalf("listCommands 调用 %d 次，期望恰 1 次", f.listCmdN.Load())
	}
	f.session.dispose(disposeClientClose)
}

func TestReady是首帧compgen挂起时扣住(t *testing.T) {
	gate := make(chan struct{})
	f := newServiceFixture(t, fixtureOpts{commandsGate: gate})
	waitForWrites(t, f)
	f.pty.pushText(testReady + "\r\nout\r\n\x01PWD:/root\x02\r\n")
	// compgen 未完成：命令结束帧已产但被扣住，连接上没有任何帧。
	time.Sleep(100 * time.Millisecond)
	if frames, _ := f.frames.snapshot(); len(frames) != 0 {
		t.Fatalf("ready 未发出前不应有帧：%v", frameTypes(frames))
	}
	close(gate)
	waitFor(t, func() bool {
		frames, _ := f.frames.snapshot()
		return len(frameTypes(frames)) >= 3
	}, "补发帧未到达")
	frames, _ := f.frames.snapshot()
	types := frameTypes(frames)
	if len(types) != 3 || types[0] != "ready" || types[1] != "output" || types[2] != "prompt" {
		t.Fatalf("帧序 = %v，期望 [ready output prompt]", types)
	}
	f.session.dispose(disposeClientClose)
}

func Test两次连接的会话id不同(t *testing.T) {
	a := newServiceFixture(t, fixtureOpts{})
	b := newServiceFixture(t, fixtureOpts{})
	if a.session.ID() == b.session.ID() {
		t.Fatal("两次连接的会话 id 不应相同")
	}
	a.session.dispose(disposeClientClose)
	b.session.dispose(disposeClientClose)
}

func TestSpawn失败1011关闭并给中文reason不遗留会话槽(t *testing.T) {
	f := newServiceFixture(t, fixtureOpts{spawnErr: errors.New("script 不存在")})
	waitFor(t, func() bool {
		_, closes := f.frames.snapshot()
		return len(closes) >= 1
	}, "1011 关闭未到达")
	_, closes := f.frames.snapshot()
	if closes[0].code != 1011 || closes[0].reason != "终端进程启动失败：script 不存在" {
		t.Fatalf("关闭记录 = %+v", closes[0])
	}
	if count := f.svc.activeCount(); count != 0 {
		t.Fatalf("会话槽遗留：activeCount = %d", count)
	}
}

func Test客户端帧input补换行interrupt写中断ping回pong(t *testing.T) {
	f := newServiceFixture(t, fixtureOpts{})
	waitForWrites(t, f)
	f.pty.pushText(testReady + "\r\n")
	waitForReady(t, f)

	f.session.handleClientFrame(clientFrame{typ: clientFrameInput, data: "whoami"})
	writes := f.pty.writesSnapshot()
	if writes[len(writes)-1] != "whoami\n" {
		t.Fatalf("input 应补换行写入：%q", writes[len(writes)-1])
	}
	f.session.handleClientFrame(clientFrame{typ: clientFrameInterrupt})
	writes = f.pty.writesSnapshot()
	if writes[len(writes)-1] != "\x03" {
		t.Fatalf("interrupt 应写 \\x03：%q", writes[len(writes)-1])
	}
	f.session.handleClientFrame(clientFrame{typ: clientFramePing})
	waitFor(t, func() bool {
		frames, _ := f.frames.snapshot()
		return len(frameTypes(frames)) >= 2
	}, "pong 帧未到达")
	frames, _ := f.frames.snapshot()
	if _, ok := frames[len(frames)-1].(framePong); !ok {
		t.Fatalf("末帧应为 pong：%+v", frames)
	}
	f.session.dispose(disposeClientClose)
}

func Test输出节流行先进缓冲50ms到点合为一帧(t *testing.T) {
	f := newServiceFixture(t, fixtureOpts{})
	waitForWrites(t, f)
	f.pty.pushText(testReady + "\r\none\r\ntwo\r\n")
	time.Sleep(80 * time.Millisecond) // 泵已消费：两行都在缓冲，定时器未触发
	frames, _ := f.frames.snapshot()
	for _, fr := range frames {
		if _, ok := fr.(frameOutput); ok {
			t.Fatalf("50ms 内不应有 output 帧：%v", frameTypes(frames))
		}
	}
	f.clock.advance(TERMINAL_FLUSH_INTERVAL)
	waitFor(t, func() bool {
		frames, _ := f.frames.snapshot()
		return len(frameTypes(frames)) >= 2
	}, "合帧 output 未到达")
	frames, _ = f.frames.snapshot()
	var outputs []frameOutput
	for _, fr := range frames {
		if out, ok := fr.(frameOutput); ok {
			outputs = append(outputs, out)
		}
	}
	if len(outputs) != 1 {
		t.Fatalf("恰应有一帧 output，得 %d", len(outputs))
	}
	if strings.Join(outputs[0].Lines, "|") != "one|two" {
		t.Fatalf("合帧行 = %v", outputs[0].Lines)
	}
	f.session.dispose(disposeClientClose)
}

func Test输出节流累计4096字节立即flush(t *testing.T) {
	f := newServiceFixture(t, fixtureOpts{})
	waitForWrites(t, f)
	f.pty.pushText(testReady + "\r\n" + strings.Repeat("x", TERMINAL_FLUSH_MAX_BYTES) + "\r\n")
	waitFor(t, func() bool {
		frames, _ := f.frames.snapshot()
		return len(frameTypes(frames)) >= 2
	}, "立即 flush 未到达（不应等定时器）")
	f.session.dispose(disposeClientClose)
}

func TestPWD哨兵flush余行prompt帧带新提示符与文件表(t *testing.T) {
	f := newServiceFixture(t, fixtureOpts{})
	waitForWrites(t, f)
	f.pty.pushText(testReady + "\r\nresult\r\n\x01PWD:/tmp\x02\r\n")
	waitForPrompt(t, f, 1)
	frames, _ := f.frames.snapshot()
	var prompt *framePrompt
	outputIdx, promptIdx := -1, -1
	for i, fr := range frames {
		switch v := fr.(type) {
		case frameOutput:
			outputIdx = i
		case framePrompt:
			promptIdx = i
			p := v
			prompt = &p
		}
	}
	if prompt == nil {
		t.Fatal("prompt 帧缺失")
	}
	if prompt.Prompt != "root@elysian-web-1:/tmp$ " || prompt.Cwd != "/tmp" {
		t.Fatalf("prompt 帧不符：%+v", prompt)
	}
	if prompt.Completion.Files == nil || strings.Join(*prompt.Completion.Files, ",") != "apps,docs" {
		t.Fatalf("文件表不符：%v", prompt.Completion.Files)
	}
	if calls := f.listDirCalls(); len(calls) != 1 || calls[0] != "/tmp" {
		t.Fatalf("readdir 调用 = %v，期望恰一次 /tmp", calls)
	}
	if outputIdx == -1 || outputIdx > promptIdx {
		t.Fatalf("output 帧应先于 prompt 帧（output=%d prompt=%d）", outputIdx, promptIdx)
	}
	f.session.dispose(disposeClientClose)
}

func Test文件表超512项回null(t *testing.T) {
	f := newServiceFixture(t, fixtureOpts{listDir: func(string) ([]string, error) {
		names := make([]string, TERMINAL_COMPLETION_FILES_MAX+1)
		for i := range names {
			names[i] = "f" + strconv.Itoa(i)
		}
		return names, nil
	}})
	waitForWrites(t, f)
	f.pty.pushText(testReady + "\r\n\x01PWD:/root\x02\r\n")
	waitForPrompt(t, f, 1)
	frames, _ := f.frames.snapshot()
	for _, fr := range frames {
		if p, ok := fr.(framePrompt); ok {
			if p.Completion.Files != nil {
				t.Fatalf("超限文件表应为 null：%v", *p.Completion.Files)
			}
		}
	}
	f.session.dispose(disposeClientClose)
}

func Test命令表超上限截断(t *testing.T) {
	f := newServiceFixture(t, fixtureOpts{listCommands: func(context.Context) ([]string, error) {
		names := make([]string, TERMINAL_COMPLETION_COMMANDS_MAX+5)
		for i := range names {
			names[i] = "cmd" + strconv.Itoa(i)
		}
		return names, nil
	}})
	waitForWrites(t, f)
	f.pty.pushText(testReady + "\r\n")
	waitForReady(t, f)
	frames, _ := f.frames.snapshot()
	ready := frames[0].(frameReady)
	if len(ready.Completion.Commands) != TERMINAL_COMPLETION_COMMANDS_MAX {
		t.Fatalf("命令表长度 %d，期望截断到 %d", len(ready.Completion.Commands), TERMINAL_COMPLETION_COMMANDS_MAX)
	}
	f.session.dispose(disposeClientClose)
}

func TestCompgen失败降级空命令表(t *testing.T) {
	f := newServiceFixture(t, fixtureOpts{listCommands: func(context.Context) ([]string, error) {
		return nil, errors.New("compgen 失败")
	}})
	waitForWrites(t, f)
	f.pty.pushText(testReady + "\r\n")
	waitForReady(t, f)
	frames, _ := f.frames.snapshot()
	ready := frames[0].(frameReady)
	if len(ready.Completion.Commands) != 0 {
		t.Fatalf("compgen 失败应降级空表：%v", ready.Completion.Commands)
	}
	f.session.dispose(disposeClientClose)
}

func Test单轮预算超限prompt帧前补truncated并重置(t *testing.T) {
	f := newServiceFixture(t, fixtureOpts{})
	waitForWrites(t, f)
	f.pty.pushText(testReady + "\r\n" + strings.Repeat("y", 300000) + "\r\n\x01PWD:/root\x02\r\n")
	waitForPrompt(t, f, 1)
	// 第二个哨兵必须跟过真实输入才有效（伪造哨兵不再重置预算）。
	f.session.handleClientFrame(clientFrame{typ: clientFrameInput, data: "true"})
	f.pty.pushText("ok\r\n\x01PWD:/root\x02\r\n")
	waitForPrompt(t, f, 2)
	frames, _ := f.frames.snapshot()
	var truncated *frameTruncated
	var outputs []frameOutput
	for _, fr := range frames {
		switch v := fr.(type) {
		case frameTruncated:
			tr := v
			truncated = &tr
		case frameOutput:
			outputs = append(outputs, v)
		}
	}
	if truncated == nil {
		t.Fatal("truncated 帧缺失")
	}
	if truncated.DroppedBytes != 300000 {
		t.Fatalf("droppedBytes = %d，期望 300000", truncated.DroppedBytes)
	}
	// 超预算行不出现在 output 帧；预算重置后的 ok 行随下一个命令结束正常输出。
	if len(outputs) != 1 || strings.Join(outputs[0].Lines, "") != "ok" {
		t.Fatalf("output 帧应为恰 [ok]：%+v", outputs)
	}
	f.session.dispose(disposeClientClose)
}

func Test伪造哨兵洪水只认首个(t *testing.T) {
	f := newServiceFixture(t, fixtureOpts{})
	waitForWrites(t, f)
	// READY 后的首提示符哨兵有效；其后 100 轮「4096 字节行 + 伪造哨兵」全部无输入跟进。
	flood := testReady + "\r\n\x01PWD:/root\x02\r\n"
	for i := 0; i < 100; i++ {
		flood += strings.Repeat("z", 4096) + "\r\n\x01PWD:/root\x02\r\n"
	}
	f.pty.pushText(flood)
	waitForPrompt(t, f, 1)
	time.Sleep(200 * time.Millisecond)
	frames, _ := f.frames.snapshot()
	promptCount := 0
	for _, ty := range frameTypes(frames) {
		if ty == "prompt" {
			promptCount++
		}
	}
	if promptCount != 1 {
		t.Fatalf("prompt 帧数 = %d，期望 1（伪造哨兵不再逐一触发）", promptCount)
	}
	if calls := f.listDirCalls(); len(calls) != 1 || calls[0] != "/root" {
		t.Fatalf("readdir 调用 = %v，期望恰一次 /root", calls)
	}
	// 预算未被逐轮重置：100 行 × 4096 字节中超出 256 KiB 的 36 行被丢弃记账。
	if got := outputLineCount(frames); got != 64 {
		t.Fatalf("透传行数 = %d，期望 64", got)
	}
	f.pty.emulateExit(0)
	waitFor(t, func() bool {
		frames, _ = f.frames.snapshot()
		return strings.Contains(strings.Join(frameTypes(frames), ","), "exit")
	}, "exit 帧未到达")
	var truncated *frameTruncated
	for _, fr := range frames {
		if tr, ok := fr.(frameTruncated); ok {
			truncated = &tr
		}
	}
	if truncated == nil || truncated.DroppedBytes != 36*4096 {
		t.Fatalf("truncated = %+v，期望 droppedBytes %d", truncated, 36*4096)
	}
	f.session.dispose(disposeClientClose)
}

func Test排队深度超限1008断开并清理(t *testing.T) {
	gate := make(chan struct{})
	f := newServiceFixture(t, fixtureOpts{listDirGate: gate})
	waitForWrites(t, f)
	f.pty.pushText(testReady + "\r\n")
	waitForReady(t, f)
	sess := f.session.(*session)
	// 每轮真实 input 解锁一个哨兵：合法 prompt 事件在慢链上排队（readdir 挂起，
	// worker 阻塞在首个任务上）。逐轮等待入队，保证 input → 哨兵的次序。
	for i := 0; i < TERMINAL_ORDERED_QUEUE_MAX+10; i++ {
		f.session.handleClientFrame(clientFrame{typ: clientFrameInput, data: ":"})
		f.pty.pushText("\x01PWD:/root\x02\r\n")
		want := i + 1
		if want > TERMINAL_ORDERED_QUEUE_MAX {
			want = TERMINAL_ORDERED_QUEUE_MAX // 超限后 disposed，深度不再增长
		}
		waitFor(t, func() bool {
			sess.chainMu.Lock()
			defer sess.chainMu.Unlock()
			return sess.queued >= want
		}, "第 "+strconv.Itoa(i)+" 轮任务未入队")
	}
	waitFor(t, func() bool {
		_, closes := f.frames.snapshot()
		for _, c := range closes {
			if c.code == 1008 && c.reason == "终端输出队列超限" {
				return true
			}
		}
		return false
	}, "1008 队列超限关闭未到达")
	waitFor(t, func() bool { return f.pty.killCountValue() >= 1 }, "kill 未发生")
	close(gate)
	f.session.dispose(disposeClientClose)
}

func Test空闲超时30分钟无帧触发kill与4000关闭(t *testing.T) {
	f := newServiceFixture(t, fixtureOpts{})
	waitForWrites(t, f)
	f.pty.pushText(testReady + "\r\n")
	waitForReady(t, f)
	f.clock.advance(TERMINAL_IDLE_TIMEOUT - time.Millisecond)
	time.Sleep(50 * time.Millisecond)
	if _, closes := f.frames.snapshot(); len(closes) != 0 {
		t.Fatalf("超时前不应关闭：%+v", closes)
	}
	f.clock.advance(time.Millisecond)
	waitFor(t, func() bool { return f.pty.killCountValue() >= 1 }, "kill 未发生")
	_, closes := f.frames.snapshot()
	if len(closes) != 1 || closes[0].code != 4000 || closes[0].reason != "终端会话空闲超时" {
		t.Fatalf("关闭记录 = %+v，期望恰一条 4000 空闲超时", closes)
	}
	if f.pty.killCountValue() != 1 {
		t.Fatalf("kill 恰应一次，得 %d", f.pty.killCountValue())
	}
}

func Test任意客户端帧重置空闲计时(t *testing.T) {
	f := newServiceFixture(t, fixtureOpts{})
	waitForWrites(t, f)
	f.pty.pushText(testReady + "\r\n")
	waitForReady(t, f)
	f.clock.advance(TERMINAL_IDLE_TIMEOUT - time.Millisecond)
	f.session.handleClientFrame(clientFrame{typ: clientFramePing})
	f.clock.advance(TERMINAL_IDLE_TIMEOUT - time.Millisecond)
	time.Sleep(50 * time.Millisecond)
	if _, closes := f.frames.snapshot(); len(closes) != 0 {
		t.Fatalf("ping 已重置计时，不应关闭：%+v", closes)
	}
	f.clock.advance(time.Millisecond)
	waitFor(t, func() bool {
		_, closes := f.frames.snapshot()
		return len(closes) >= 1
	}, "重置后的空闲关闭未到达")
	_, closes := f.frames.snapshot()
	if closes[0].code != 4000 || closes[0].reason != "终端会话空闲超时" {
		t.Fatalf("关闭记录 = %+v", closes[0])
	}
}

func Test断开清理dispose幂等kill恰一次(t *testing.T) {
	f := newServiceFixture(t, fixtureOpts{})
	waitForWrites(t, f)
	f.pty.pushText(testReady + "\r\n")
	waitForReady(t, f)
	f.session.dispose(disposeClientClose)
	f.session.dispose(disposeClientClose)
	time.Sleep(50 * time.Millisecond)
	if f.pty.killCountValue() != 1 {
		t.Fatalf("kill 恰应一次，得 %d", f.pty.killCountValue())
	}
	if _, closes := f.frames.snapshot(); len(closes) != 0 {
		t.Fatalf("客户端关闭路径不向连接发关闭帧：%+v", closes)
	}
}

func TestPTY自然退出flush余行exit帧与1000关闭(t *testing.T) {
	f := newServiceFixture(t, fixtureOpts{})
	waitForWrites(t, f)
	f.pty.pushText(testReady + "\r\nlast words\r\n")
	f.pty.emulateExit(3)
	waitFor(t, func() bool {
		frames, _ := f.frames.snapshot()
		return strings.Contains(strings.Join(frameTypes(frames), ","), "exit")
	}, "exit 帧未到达")
	waitFor(t, func() bool {
		_, closes := f.frames.snapshot()
		return len(closes) >= 1
	}, "1000 关闭未到达")
	frames, closes := f.frames.snapshot()
	var exit *frameExit
	for _, fr := range frames {
		if e, ok := fr.(frameExit); ok {
			ex := e
			exit = &ex
		}
	}
	if exit == nil || exit.ExitCode != 3 {
		t.Fatalf("exit 帧 = %+v，期望退出码 3", exit)
	}
	if closes[0].code != 1000 || closes[0].reason != "" {
		t.Fatalf("关闭记录 = %+v，期望 {1000 \"\"}", closes[0])
	}
	if f.pty.killCountValue() != 0 {
		t.Fatalf("自然退出不应 kill，得 %d", f.pty.killCountValue())
	}
	waitFor(t, func() bool {
		frames, _ := f.frames.snapshot()
		return containsLine(frames, "last words")
	}, "余行未 flush")
}

func containsLine(frames []terminalFrame, want string) bool {
	for _, fr := range frames {
		if out, ok := fr.(frameOutput); ok {
			for _, line := range out.Lines {
				if line == want {
					return true
				}
			}
		}
	}
	return false
}

func TestREADY之前进程死亡不发ready走exit路径(t *testing.T) {
	f := newServiceFixture(t, fixtureOpts{})
	waitForWrites(t, f)
	f.pty.emulateExit(0)
	waitFor(t, func() bool {
		frames, _ := f.frames.snapshot()
		return strings.Contains(strings.Join(frameTypes(frames), ","), "exit")
	}, "exit 帧未到达")
	frames, _ := f.frames.snapshot()
	for _, fr := range frames {
		if _, ok := fr.(frameReady); ok {
			t.Fatal("READY 前死亡不应发 ready 帧")
		}
	}
	f.session.dispose(disposeClientClose)
}

func Test并发上限第6个会话被拒释放后可再开(t *testing.T) {
	host := seam.TerminalHostDeps{
		SpawnPty: func(context.Context, seam.ShellSessionSpec, seam.TerminalIdentity) (seam.PtyProcess, error) {
			return newFakePty(), nil
		},
		ListCommands: func(context.Context) ([]string, error) { return nil, nil },
		ListDir:      func(string) ([]string, error) { return []string{}, nil },
	}
	identity := func() seam.TerminalIdentity {
		return seam.TerminalIdentity{User: "root", HostLabel: "h", HomeDir: "/root"}
	}
	svc := newService(host, identity, HostShellSessionSpec, TERMINAL_MAX_SESSIONS, newFakeClock())
	sessions := []sessionHandle{}
	for i := 0; i < TERMINAL_MAX_SESSIONS; i++ {
		h := svc.tryOpen(&frameRecorder{})
		if h == nil {
			t.Fatalf("前 %d 个会话不应被拒（第 %d 个被拒）", TERMINAL_MAX_SESSIONS, i+1)
		}
		sessions = append(sessions, h)
	}
	if svc.activeCount() != TERMINAL_MAX_SESSIONS {
		t.Fatalf("activeCount = %d", svc.activeCount())
	}
	if h := svc.tryOpen(&frameRecorder{}); h != nil {
		t.Fatal("第 6 个会话应被拒")
	}
	sessions[0].dispose(disposeClientClose)
	if svc.activeCount() != TERMINAL_MAX_SESSIONS-1 {
		t.Fatalf("释放后 activeCount = %d，期望 %d", svc.activeCount(), TERMINAL_MAX_SESSIONS-1)
	}
	if h := svc.tryOpen(&frameRecorder{}); h == nil {
		t.Fatal("释放后应可再开")
	} else {
		h.dispose(disposeClientClose)
	}
	for _, h := range sessions[1:] {
		h.dispose(disposeClientClose)
	}
}

func TestDisposeShell收尾钩子(t *testing.T) {
	var mu sync.Mutex
	var pids []string
	f := newServiceFixture(t, fixtureOpts{disposeShell: func(pid string) {
		mu.Lock()
		pids = append(pids, pid)
		mu.Unlock()
	}})
	f.pty.pushText("\x01READY:4194304\x02\r\n")
	waitForReady(t, f)
	f.session.dispose(disposeClientClose)
	mu.Lock()
	defer mu.Unlock()
	if len(pids) != 1 || pids[0] != "4194304" {
		t.Fatalf("disposeShell 收到 %v，期望 [4194304]", pids)
	}
}

func Test未见READY哨兵时dispose不调用钩子(t *testing.T) {
	var mu sync.Mutex
	var pids []string
	f := newServiceFixture(t, fixtureOpts{disposeShell: func(pid string) {
		mu.Lock()
		pids = append(pids, pid)
		mu.Unlock()
	}})
	f.pty.pushText("noise\r\n")
	f.session.dispose(disposeClientClose)
	mu.Lock()
	defer mu.Unlock()
	if len(pids) != 0 {
		t.Fatalf("未见哨兵不应调用钩子：%v", pids)
	}
}

func Test会话uuid形态(t *testing.T) {
	a, b := newSessionUUID(), newSessionUUID()
	if a == b {
		t.Fatal("两次生成的会话 id 不应相同")
	}
	for _, id := range []string{a, b} {
		if len(id) != 36 {
			t.Fatalf("uuid 长度 %d：%q", len(id), id)
		}
		if id[14] != '4' {
			t.Fatalf("version 4 位不符：%q", id)
		}
		switch id[19] {
		case '8', '9', 'a', 'b':
		default:
			t.Fatalf("variant 位不符：%q", id)
		}
	}
}
