package files

/*
 * 文件管理服务编排的行为测试（filesService.test.ts 对等）：全部宿主访问走有状态
 * fake（内存文件树 + 命令账本，见 fakes_test.go），不执行任何真实命令、不碰真实
 * 文件系统。校验顺序与中文文案逐字对齐 web 侧 mock（apps/web/src/adapters/mock/
 * filesData.ts）；三种抢注时机的用例依赖 fake 的时序钩子。
 */

import (
	"context"
	"fmt"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

var serviceCtx = context.Background()

func mustList(t *testing.T, fn func() ([]fileEntry, error)) []fileEntry {
	t.Helper()
	entries, err := fn()
	if err != nil {
		t.Fatalf("list 失败：%v", err)
	}
	return entries
}

func entryByName(t *testing.T, entries []fileEntry, name string) fileEntry {
	t.Helper()
	for _, entry := range entries {
		if entry.Name == name {
			return entry
		}
	}
	t.Fatalf("找不到条目 %s：%v", name, entries)
	return fileEntry{}
}

func int64Ptr(v int64) *int64 { return &v }

func requireErrorExact(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("期望错误 %q，得到 nil", want)
	}
	if errMessage(err) != want {
		t.Fatalf("错误文案 %q，期望 %q", errMessage(err), want)
	}
	if !errIsInvalidRequest(err) {
		t.Fatalf("错误 %q 应为 400 语义（shared.InvalidRequestError）", want)
	}
}

func requireSystemErrorExact(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("期望错误 %q，得到 nil", want)
	}
	if errMessage(err) != want {
		t.Fatalf("错误文案 %q，期望 %q", errMessage(err), want)
	}
	if errIsInvalidRequest(err) {
		t.Fatalf("错误 %q 不应为 400 语义", want)
	}
}

func requireNoError(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("意外错误：%v", err)
	}
}

func requireZeroWriteCommands(t *testing.T, host *fakeFilesHost) {
	t.Helper()
	if len(host.writeCommands()) != 0 {
		t.Fatalf("应零写命令，账本：%v", host.writeCommands())
	}
}

func TestServiceList(t *testing.T) {
	t.Run("返回直接子项：目录无 sizeBytes、文件有；owner 经 getent 解析、查不到用 uid 呈现", func(t *testing.T) {
		service := newTestService(createFakeFilesHost(seedContainerTree()))
		entries := mustList(t, func() ([]fileEntry, error) { return service.List(serviceCtx, "/var/log") })
		syslog := entryByName(t, entries, "syslog")
		if syslog.Kind != "file" || syslog.SizeBytes == nil || *syslog.SizeBytes != 219530 || syslog.Mode != "640" || syslog.Owner != "root" {
			t.Fatalf("syslog = %+v", syslog)
		}
		nginx := entryByName(t, entries, "nginx")
		if nginx.Kind != "directory" || nginx.Owner != "root" || nginx.Mode != "755" {
			t.Fatalf("nginx = %+v", nginx)
		}
		if nginx.SizeBytes != nil {
			t.Fatalf("目录条目应省略 sizeBytes：%+v", nginx)
		}
		foreign := entryByName(t, entries, "foreign")
		if foreign.Owner != "12345" {
			t.Fatalf("foreign owner = %q，期望 uid 数字字符串", foreign.Owner)
		}
		current := entryByName(t, entries, "current")
		if current.ModifiedAt != fakeMtime.Format("2006-01-02T15:04:05.000Z") {
			t.Fatalf("current modifiedAt = %q", current.ModifiedAt)
		}
	})

	t.Run("断链符号链接回退 lstat 按文件呈现（大小是链接本身字节数）", func(t *testing.T) {
		service := newTestService(createFakeFilesHost(seedContainerTree()))
		entries := mustList(t, func() ([]fileEntry, error) { return service.List(serviceCtx, "/var/log") })
		current := entryByName(t, entries, "current")
		if current.Kind != "file" || current.SizeBytes == nil || *current.SizeBytes != int64(len("/var/log/nothere")) {
			t.Fatalf("current = %+v", current)
		}
	})

	t.Run("链接环条目回退 lstat 按链接自身呈现，一个环不炸整个列举", func(t *testing.T) {
		root := seedContainerTree()
		root.child("work").setChild("self-loop", fakeLinkNode("/work/self-loop"))
		service := newTestService(createFakeFilesHost(root))
		entries := mustList(t, func() ([]fileEntry, error) { return service.List(serviceCtx, "/work") })
		selfLoop := entryByName(t, entries, "self-loop")
		if selfLoop.Kind != "file" || selfLoop.SizeBytes == nil || *selfLoop.SizeBytes != int64(len("/work/self-loop")) {
			t.Fatalf("self-loop = %+v", selfLoop)
		}
		if _, ok := entryByNameSafe(entries, "report.txt"); !ok {
			t.Fatalf("其余条目照常返回：%v", entries)
		}
	})

	t.Run("目录不存在与路径是文件同文案；路径先归一化", func(t *testing.T) {
		service := newTestService(createFakeFilesHost(seedContainerTree()))
		_, err := service.List(serviceCtx, "/nope")
		requireErrorExact(t, err, "目录不存在：/nope")
		_, err = service.List(serviceCtx, "/etc/nginx/nginx.conf")
		requireErrorExact(t, err, "目录不存在：/etc/nginx/nginx.conf")
		if _, err := service.List(serviceCtx, "/var//log/"); err != nil {
			t.Fatalf("归一化后应放行：%v", err)
		}
	})

	t.Run("相对路径与 `.` 段在判据层拒绝（原样入参进文案）", func(t *testing.T) {
		service := newTestService(createFakeFilesHost(seedContainerTree()))
		_, err := service.List(serviceCtx, "var/log")
		requireErrorExact(t, err, "无效的文件路径：var/log")
		_, err = service.List(serviceCtx, "/var/./log")
		requireErrorExact(t, err, "无效的文件路径：/var/./log")
	})

	t.Run("超过 10000 条截断", func(t *testing.T) {
		children := make([]fakeNamedNode, 0, 10001)
		for index := 0; index < 10001; index++ {
			children = append(children, d(fmt.Sprintf("e%d", index), fakeFileNode(1)))
		}
		service := newTestService(createFakeFilesHost(fakeDirNode(d("many", fakeDirNode(children...)))))
		entries, err := service.List(serviceCtx, "/many")
		requireNoError(t, err)
		if len(entries) != 10000 {
			t.Fatalf("截断后应为 10000 条，得到 %d", len(entries))
		}
	})
}

func entryByNameSafe(entries []fileEntry, name string) (fileEntry, bool) {
	for _, entry := range entries {
		if entry.Name == name {
			return entry, true
		}
	}
	return fileEntry{}, false
}

func TestServiceSize(t *testing.T) {
	t.Run("文件是自身大小；目录是全部后代之和（符号链接按链接字节计，目录不累计）", func(t *testing.T) {
		service := newTestService(createFakeFilesHost(seedContainerTree()))
		total, err := service.Size(serviceCtx, "/var/log/syslog")
		requireNoError(t, err)
		if total != 219530 {
			t.Fatalf("syslog size = %d", total)
		}
		total, err = service.Size(serviceCtx, "/var/log")
		requireNoError(t, err)
		want := int64(219530 + 200 + 50 + 8241 + len("/var/log/nothere"))
		if total != want {
			t.Fatalf("/var/log size = %d，期望 %d", total, want)
		}
		total, err = service.Size(serviceCtx, "/etc/nginx")
		requireNoError(t, err)
		if total != 1478+1834 {
			t.Fatalf("/etc/nginx size = %d", total)
		}
	})

	t.Run("起点不存在报中文（不会把 ENOENT 冒成 500）", func(t *testing.T) {
		service := newTestService(createFakeFilesHost(seedContainerTree()))
		_, err := service.Size(serviceCtx, "/nope")
		requireErrorExact(t, err, "目录不存在：/nope")
	})

	t.Run("起点是链接环：中文上下文报错，不冒英文 ELOOP", func(t *testing.T) {
		root := seedContainerTree()
		root.child("work").setChild("self-loop", fakeLinkNode("/work/self-loop"))
		service := newTestService(createFakeFilesHost(root))
		_, err := service.Size(serviceCtx, "/work/self-loop")
		if err == nil || !strings.HasPrefix(errMessage(err), "读取路径状态失败（/work/self-loop）") {
			t.Fatalf("期望中文上下文错误，得到 %v", err)
		}
	})

	t.Run("超预算如实报错：目录规模超出统计上限", func(t *testing.T) {
		service := newTestService(createHugeHost())
		_, err := service.Size(serviceCtx, "/big")
		requireErrorExact(t, err, "目录规模超出统计上限（50000 个条目），请缩小统计范围")
	})

	t.Run("指向虚拟 FS 的符号链接别名做起点：与直指 /proc 同样拒绝", func(t *testing.T) {
		root := seedContainerTree()
		root.child("tmp").setChild("proc-alias", fakeLinkNode("/proc"))
		service := newTestService(createFakeFilesHost(root))
		_, err := service.Size(serviceCtx, "/tmp/proc-alias")
		requireErrorExact(t, err, "拒绝操作系统虚拟目录：/tmp/proc-alias")
		// 文件别名（指向 /proc 内的伪文件）同样不许：口径按 realpath 判，不看条目种类。
		root.child("tmp").setChild("cpuinfo-alias", fakeLinkNode("/proc/cpuinfo"))
		fileAliasService := newTestService(createFakeFilesHost(root))
		_, err = fileAliasService.Size(serviceCtx, "/tmp/cpuinfo-alias")
		requireErrorExact(t, err, "拒绝操作系统虚拟目录：/tmp/cpuinfo-alias")
	})
}

var stagingPayloadPattern = regexp.MustCompile(`^/tmp/\.elysian-staging-[0-9a-f]{16}/\.payload$`)
var etcStagingPayloadPattern = regexp.MustCompile(`^/etc/\.elysian-staging-[0-9a-f]{16}/\.payload$`)

func TestServiceCopyEntry(t *testing.T) {
	t.Run("cp -a 数组传参深拷贝，回读返回新条目；重名依次派生「 副本」「 副本 2」", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		service := newTestService(host)
		first, err := service.CopyEntry(serviceCtx, "/etc/nginx/nginx.conf", "/tmp")
		requireNoError(t, err)
		if first.Name != "nginx.conf" || first.Kind != "file" || first.SizeBytes == nil || *first.SizeBytes != 1478 {
			t.Fatalf("first = %+v", first)
		}
		if node := host.nodeAt("/tmp/nginx.conf"); node == nil || node.kind != fakeFileKind {
			t.Fatalf("/tmp/nginx.conf 应为文件")
		}

		second, err := service.CopyEntry(serviceCtx, "/etc/nginx/nginx.conf", "/tmp")
		requireNoError(t, err)
		if second.Name != "nginx.conf 副本" {
			t.Fatalf("second name = %q", second.Name)
		}

		third, err := service.CopyEntry(serviceCtx, "/etc/nginx/nginx.conf", "/tmp")
		requireNoError(t, err)
		if third.Name != "nginx.conf 副本 2" {
			t.Fatalf("third name = %q", third.Name)
		}
		// cp -a 保留权限位：回读的 mode 与源一致。
		if node := host.nodeAt("/tmp/nginx.conf"); node.mode != 0o644 {
			t.Fatalf("cp -a 应保留权限位，得到 %o", node.mode)
		}

		// 命令形状：cp 一律只写独占创建的私有暂存目录，最终名由 rename(2) 发布。
		var copies []fakeCommand
		for _, command := range host.writeCommands() {
			if command.command == "cp" {
				copies = append(copies, command)
			}
		}
		if len(copies) != 3 {
			t.Fatalf("cp 命令 %d 条，期望 3：%v", len(copies), host.writeCommands())
		}
		for _, copy := range copies {
			if copy.args[0] != "-a" || copy.args[1] != "/etc/nginx/nginx.conf" || !stagingPayloadPattern.MatchString(copy.args[2]) {
				t.Fatalf("cp argv = %v", copy.args)
			}
		}
		wantRenames := []fakeRenameCall{
			{from: copies[0].args[2], to: "/tmp/nginx.conf"},
			{from: copies[1].args[2], to: "/tmp/nginx.conf 副本"},
			{from: copies[2].args[2], to: "/tmp/nginx.conf 副本 2"},
		}
		if !reflect.DeepEqual(host.renames, wantRenames) {
			t.Fatalf("renames = %v，期望 %v", host.renames, wantRenames)
		}
		// 暂存目录不留在目标目录里。
		for _, name := range host.childNamesOf("/tmp") {
			if len(name) >= 17 && name[:17] == ".elysian-staging-" {
				t.Fatalf("暂存目录残留：%v", host.childNamesOf("/tmp"))
			}
		}
	})

	t.Run("复制符号链接：回读与 list 同口径——活链接按指向呈现，复制后断链的按链接自身呈现", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		service := newTestService(host)

		// 活链接：cp -a 拷贝链接本身，回读按指向呈现（600 / www-data / 15 字节 / 目标时间戳）。
		liveCopy, err := service.CopyEntry(serviceCtx, "/work/report-link", "/tmp")
		requireNoError(t, err)
		wantLive := fileEntry{
			Name: "report-link", Kind: "file", Mode: "600", Owner: "www-data",
			SizeBytes: int64Ptr(15), ModifiedAt: fakeTargetMtime.Format("2006-01-02T15:04:05.000Z"),
		}
		if !reflect.DeepEqual(liveCopy, wantLive) {
			t.Fatalf("liveCopy = %+v，期望 %+v", liveCopy, wantLive)
		}
		if node := host.nodeAt("/tmp/report-link", false); node == nil || node.kind != fakeLinkKind {
			t.Fatalf("/tmp/report-link 应仍是符号链接")
		}

		// 相对目标链接（→ rel.txt）复制到 /etc 后断链（cp -a 保留相对目标文本）：
		// 复制本身已成功，回读必须按链接自身呈现，而不是抛「读取条目状态失败」。
		danglingCopy, err := service.CopyEntry(serviceCtx, "/work/rel-link.txt", "/etc")
		requireNoError(t, err)
		wantDangling := fileEntry{
			Name: "rel-link.txt", Kind: "file", Mode: "777", Owner: "root",
			SizeBytes: int64Ptr(int64(len("rel.txt"))), ModifiedAt: fakeMtime.Format("2006-01-02T15:04:05.000Z"),
		}
		if !reflect.DeepEqual(danglingCopy, wantDangling) {
			t.Fatalf("danglingCopy = %+v，期望 %+v", danglingCopy, wantDangling)
		}
		if node := host.nodeAt("/etc/rel-link.txt", false); node == nil || node.kind != fakeLinkKind {
			t.Fatalf("/etc/rel-link.txt 应仍是符号链接")
		}
	})

	t.Run("校验顺序与文案逐字对齐 mock：根目录、源不存在、目标目录不存在或路径是文件", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		service := newTestService(host)
		_, err := service.CopyEntry(serviceCtx, "/", "/tmp")
		requireErrorExact(t, err, "根目录不能复制")
		_, err = service.CopyEntry(serviceCtx, "/nope", "/tmp")
		requireErrorExact(t, err, "目录不存在：/nope")
		_, err = service.CopyEntry(serviceCtx, "/etc/nginx/nginx.conf", "/nope")
		requireErrorExact(t, err, "目录不存在：/nope")
		_, err = service.CopyEntry(serviceCtx, "/etc/nginx/nginx.conf", "/var/www/index.html")
		requireErrorExact(t, err, "目录不存在：/var/www/index.html")
		requireZeroWriteCommands(t, host)
	})

	t.Run("目标在源目录内部（含相等）拒绝且零命令；源是 /proc 拒绝", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		service := newTestService(host)
		_, err := service.CopyEntry(serviceCtx, "/etc", "/etc/nginx")
		requireErrorExact(t, err, "不能把目录复制到它自己内部")
		_, err = service.CopyEntry(serviceCtx, "/etc", "/etc")
		requireErrorExact(t, err, "不能把目录复制到它自己内部")
		_, err = service.CopyEntry(serviceCtx, "/proc", "/tmp")
		requireErrorExact(t, err, "拒绝操作系统虚拟目录：/proc")
		requireZeroWriteCommands(t, host)
	})

	t.Run("目标目录落写禁区（含经符号链接换链到 /root/.ssh）拒绝且零命令", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		service := newTestService(host)
		_, err := service.CopyEntry(serviceCtx, "/var/www/index.html", "/root/.Elysian/data")
		requireErrorExact(t, err, "拒绝操作受保护路径：/root/.Elysian/data")
		// 字符串上是 /root/keys-link，realpath 后是 /root/.ssh——第二道检查命中。
		_, err = service.CopyEntry(serviceCtx, "/var/www/index.html", "/root/keys-link")
		requireErrorExact(t, err, "拒绝操作受保护路径：/root/.ssh")
		requireZeroWriteCommands(t, host)
	})

	t.Run("派生目标完整路径落写禁区：源名恰好补齐禁区路径时拒绝且零命令", func(t *testing.T) {
		host := createHostWithoutRootSsh()
		service := newTestService(host)
		_, err := service.CopyEntry(serviceCtx, "/home/deploy/.ssh", "/root")
		requireErrorExact(t, err, "拒绝操作受保护路径：/root/.ssh")
		requireZeroWriteCommands(t, host)
		if host.nodeAt("/root/.ssh") != nil {
			t.Fatal("保护区内不得出现新条目")
		}
	})

	t.Run("预检超预算拒绝且零命令", func(t *testing.T) {
		host := createHugeHost()
		service := newTestService(host)
		_, err := service.CopyEntry(serviceCtx, "/big", "/tmp")
		requireErrorExact(t, err, "目录规模超出操作上限（50000 个条目）")
		requireZeroWriteCommands(t, host)
	})

	t.Run("文件的目标名在占用检查之后被抢注为符号链接：cp 不写穿禁区文件，按占用法则派副本名发布", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		planted := plantSymlinkAfterFirstReaddir(host, "/tmp/nginx.conf", "/root/.ssh/authorized_keys")
		service := newTestService(host)

		copied, err := service.CopyEntry(serviceCtx, "/etc/nginx/nginx.conf", "/tmp")
		requireNoError(t, err)

		if !planted() {
			t.Fatal("抢注窗口未触发（空转绿灯）")
		}
		// 抢注的名字按「已占用」处理（lstat 不跟随）：产物落在派生出的副本名上。
		if copied.Name != "nginx.conf 副本" || copied.SizeBytes == nil || *copied.SizeBytes != 1478 {
			t.Fatalf("copied = %+v", copied)
		}
		if node := host.nodeAt("/tmp/nginx.conf", false); node == nil || node.kind != fakeLinkKind {
			t.Fatalf("/tmp/nginx.conf 应保持为抢注的链接")
		}
		// 禁区文件零改写：写穿会把大小与权限位改成源文件的。
		if node := host.nodeAt("/root/.ssh/authorized_keys"); node.size != 394 || node.mode != 0o600 {
			t.Fatalf("禁区文件被改写：%+v", node)
		}
		// cp 只写私有暂存目录（0700），最终名由 rename(2) 发布。
		var cpCommand *fakeCommand
		for i := range host.writeCommands() {
			if host.writeCommands()[i].command == "cp" {
				cpCommand = &host.writeCommands()[i]
			}
		}
		if cpCommand == nil || cpCommand.args[0] != "-a" || !regexp.MustCompile(`^/tmp/\.elysian-staging-[0-9a-f]+/\.payload$`).MatchString(cpCommand.args[2]) {
			t.Fatalf("cp argv = %v", cpCommand)
		}
		wantRenames := []fakeRenameCall{{from: cpCommand.args[2], to: "/tmp/nginx.conf 副本"}}
		if !reflect.DeepEqual(host.renames, wantRenames) {
			t.Fatalf("renames = %v，期望 %v", host.renames, wantRenames)
		}
		for _, name := range host.childNamesOf("/tmp") {
			if len(name) >= 17 && name[:17] == ".elysian-staging-" {
				t.Fatalf("暂存目录残留：%v", host.childNamesOf("/tmp"))
			}
		}
	})

	t.Run("目录的目标名在占用检查之后被抢注：目录产物同样不写穿，派生副本名发布", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		planted := plantSymlinkAfterFirstReaddir(host, "/tmp/nginx", "/root/.ssh/authorized_keys")
		service := newTestService(host)

		copied, err := service.CopyEntry(serviceCtx, "/etc/nginx", "/tmp")
		requireNoError(t, err)

		if !planted() {
			t.Fatal("抢注窗口未触发")
		}
		if copied.Name != "nginx 副本" || copied.Kind != "directory" {
			t.Fatalf("copied = %+v", copied)
		}
		if node := host.nodeAt("/tmp/nginx 副本/nginx.conf"); node == nil || node.size != 1478 {
			t.Fatalf("副本目录内容异常：%v", host.nodeAt("/tmp/nginx 副本/nginx.conf"))
		}
		if node := host.nodeAt("/tmp/nginx", false); node == nil || node.kind != fakeLinkKind {
			t.Fatalf("/tmp/nginx 应保持为链接")
		}
		if node := host.nodeAt("/root/.ssh/authorized_keys"); node.size != 394 || node.mode != 0o600 {
			t.Fatalf("禁区文件被改写：%+v", node)
		}
	})

	t.Run("复核之后才被抢注（最坏窗口）：文件产物的 rename 替换链接本身，仍不写穿", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		planted := plantSymlinkAfterLstat(host, "/tmp/nginx.conf", "/root/.ssh/authorized_keys")
		service := newTestService(host)

		copied, err := service.CopyEntry(serviceCtx, "/etc/nginx/nginx.conf", "/tmp")
		requireNoError(t, err)

		if !planted() {
			t.Fatal("抢注窗口未触发")
		}
		if copied.Name != "nginx.conf" || copied.SizeBytes == nil || *copied.SizeBytes != 1478 {
			t.Fatalf("copied = %+v", copied)
		}
		// 抢注的链接被替换成产物本身（rename 不跟随最终组件），禁区文件保持原值。
		if node := host.nodeAt("/tmp/nginx.conf", false); node == nil || node.kind != fakeFileKind {
			t.Fatalf("/tmp/nginx.conf 应已被产物替换")
		}
		if node := host.nodeAt("/root/.ssh/authorized_keys"); node.size != 394 || node.mode != 0o600 {
			t.Fatalf("禁区文件被改写：%+v", node)
		}
	})

	t.Run("复核之后才被抢注（最坏窗口）：目录产物以 ENOTDIR 失败后换副本名重试，仍不写穿", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		planted := plantSymlinkAfterLstat(host, "/tmp/nginx", "/root/.ssh/authorized_keys")
		service := newTestService(host)

		copied, err := service.CopyEntry(serviceCtx, "/etc/nginx", "/tmp")
		requireNoError(t, err)

		if !planted() {
			t.Fatal("抢注窗口未触发")
		}
		// rename(2) 不允许「目录覆盖非目录」：抢注的链接让首次发布失败，换副本名后成功。
		if copied.Name != "nginx 副本" {
			t.Fatalf("copied name = %q", copied.Name)
		}
		if node := host.nodeAt("/tmp/nginx 副本/nginx.conf"); node == nil || node.size != 1478 {
			t.Fatal("副本目录内容异常")
		}
		if node := host.nodeAt("/root/.ssh/authorized_keys"); node.size != 394 {
			t.Fatalf("禁区文件被改写：%+v", node)
		}
	})

	t.Run("暂存目录落点被换链进保护区：锚点捕获后换链，cp 执行前拒绝且不留残余", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		// 源名与 /root/.ssh 既有条目同名：deriveUniqueName 会派生「 副本」名。
		host.nodeAt("/var/www").setChild("authorized_keys", fakeFileNode(120))
		planted := swapDirAfterFirstRealpath(host, "/tmp", "/root/.ssh")
		service := newTestService(host)

		_, err := service.CopyEntry(serviceCtx, "/var/www/authorized_keys", "/tmp")
		requireSystemErrorExact(t, err, "目标目录在操作期间被替换，已中止：/tmp")

		if !planted() {
			t.Fatal("换链窗口未触发")
		}
		// cp 一条都没执行；/root/.ssh 里既无产物也无暂存残留（finally 已清理换链后误建的暂存）。
		for _, command := range host.writeCommands() {
			if command.command == "cp" {
				t.Fatalf("不应执行 cp：%v", host.writeCommands())
			}
		}
		if names := host.childNamesOf("/root/.ssh"); !reflect.DeepEqual(names, []string{"authorized_keys"}) {
			t.Fatalf("/root/.ssh 子项 = %v", names)
		}
		if node := host.nodeAt("/root/.ssh/authorized_keys"); node.size != 394 {
			t.Fatalf("禁区文件被改写：%+v", node)
		}
	})
}

func TestServiceMoveEntry(t *testing.T) {
	t.Run("mv -T 数组传参，重名同样派生副本名，回读返回新位置条目", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		service := newTestService(host)
		moved, err := service.MoveEntry(serviceCtx, "/var/www/index.html", "/tmp")
		requireNoError(t, err)
		if moved.Name != "index.html" || moved.Kind != "file" || moved.SizeBytes == nil || *moved.SizeBytes != 512 {
			t.Fatalf("moved = %+v", moved)
		}
		want := []fakeCommand{{command: "mv", args: []string{"-T", "/var/www/index.html", "/tmp/index.html"}}}
		if !reflect.DeepEqual(host.writeCommands(), want) {
			t.Fatalf("writeCommands = %v，期望 %v", host.writeCommands(), want)
		}
		if host.nodeAt("/var/www/index.html") != nil {
			t.Fatal("源应消失")
		}
		if node := host.nodeAt("/tmp/index.html"); node == nil || node.size != 512 {
			t.Fatal("/tmp/index.html 内容异常")
		}

		if _, err := service.MoveEntry(serviceCtx, "/var/www/style.css", "/tmp"); err != nil {
			t.Fatalf("移动 style.css 失败：%v", err)
		}
		if host.nodeAt("/tmp/style.css") == nil {
			t.Fatal("/tmp/style.css 应存在")
		}
		if _, err := service.MoveEntry(serviceCtx, "/home/deploy/deploy.sh", "/tmp"); err != nil {
			t.Fatalf("移动 deploy.sh 失败：%v", err)
		}
		// 目标重名同样派生副本名：/tmp 已有 deploy.sh，再移入同名条目。
		again, err := service.MoveEntry(serviceCtx, "/srv/deploy.sh", "/tmp")
		requireNoError(t, err)
		if again.Name != "deploy.sh 副本" {
			t.Fatalf("again name = %q", again.Name)
		}
	})

	t.Run("校验顺序与文案逐字对齐 mock：根目录、移进自身、源不存在、目标不存在、目标与源目录相同", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		service := newTestService(host)
		_, err := service.MoveEntry(serviceCtx, "/", "/tmp")
		requireErrorExact(t, err, "根目录不能移动")
		_, err = service.MoveEntry(serviceCtx, "/etc", "/etc/nginx")
		requireErrorExact(t, err, "不能把目录移动到它自己内部")
		_, err = service.MoveEntry(serviceCtx, "/etc", "/etc")
		requireErrorExact(t, err, "不能把目录移动到它自己内部")
		_, err = service.MoveEntry(serviceCtx, "/nope", "/tmp")
		requireErrorExact(t, err, "目录不存在：/nope")
		_, err = service.MoveEntry(serviceCtx, "/var/www/index.html", "/nope")
		requireErrorExact(t, err, "目录不存在：/nope")
		_, err = service.MoveEntry(serviceCtx, "/var/www/index.html", "/var/www")
		requireErrorExact(t, err, "目标目录与源目录相同")
		requireZeroWriteCommands(t, host)
	})

	t.Run("源在卷真身 /var/lib/elysian、目标落 /root/.bun 都拒绝且零命令", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		service := newTestService(host)
		_, err := service.MoveEntry(serviceCtx, "/var/lib/elysian/data/metrics.sqlite", "/tmp")
		requireErrorExact(t, err, "拒绝操作受保护路径：/var/lib/elysian/data/metrics.sqlite")
		_, err = service.MoveEntry(serviceCtx, "/var/www/index.html", "/root/.bun")
		requireErrorExact(t, err, "拒绝操作受保护路径：/root/.bun")
		requireZeroWriteCommands(t, host)
	})

	t.Run("源是符号链接且指向 /root/.ssh（换链绕过尝试）：realpath 复核命中，零命令", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		service := newTestService(host)
		_, err := service.MoveEntry(serviceCtx, "/root/keys-link", "/tmp")
		requireErrorExact(t, err, "拒绝操作受保护路径：/root/.ssh")
		requireZeroWriteCommands(t, host)
	})

	t.Run("派生目标完整路径落写禁区：源名恰好补齐禁区路径时拒绝且零命令", func(t *testing.T) {
		host := createHostWithoutRootSsh()
		service := newTestService(host)
		_, err := service.MoveEntry(serviceCtx, "/home/deploy/.ssh", "/root")
		requireErrorExact(t, err, "拒绝操作受保护路径：/root/.ssh")
		requireZeroWriteCommands(t, host)
		if host.nodeAt("/root/.ssh") != nil {
			t.Fatal("保护区内不得出现新条目")
		}
	})

	t.Run("目标目录在锚点捕获后被换成指向保护区的符号链接：拒绝执行且零写命令", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		planted := swapDirAfterFirstRealpath(host, "/tmp", "/root/.Elysian")
		service := newTestService(host)

		_, err := service.MoveEntry(serviceCtx, "/var/www/index.html", "/tmp")
		requireSystemErrorExact(t, err, "目标目录在操作期间被替换，已中止：/tmp")

		if !planted() {
			t.Fatal("换链窗口未触发")
		}
		requireZeroWriteCommands(t, host)
		if host.nodeAt("/var/www/index.html") == nil {
			t.Fatal("源不应被动过")
		}
		if host.nodeAt("/root/.Elysian/index.html") != nil {
			t.Fatal("保护区内不得出现产物")
		}
	})
}

func TestServiceRenameEntry(t *testing.T) {
	t.Run("非法名称逐字对齐 mock（原样入参进文案）；根目录与父目录、条目不存在依次检查", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		service := newTestService(host)
		for _, bad := range []string{"", " ", "a/b", ".", "..", "fo\no"} {
			_, err := service.RenameEntry(serviceCtx, "/var/www/index.html", bad)
			requireErrorExact(t, err, "无效的名称："+bad)
		}
		_, err := service.RenameEntry(serviceCtx, "/", "x")
		requireErrorExact(t, err, "根目录不能重命名")
		_, err = service.RenameEntry(serviceCtx, "/nope/x", "y")
		requireErrorExact(t, err, "目录不存在：/nope")
		_, err = service.RenameEntry(serviceCtx, "/var/www/nothere", "y")
		requireErrorExact(t, err, "条目不存在：/var/www/nothere")
		if len(host.renames) != 0 {
			t.Fatalf("应零重命名：%v", host.renames)
		}
	})

	t.Run("名字没变（含 trim 后相同）不执行任何命令，原样回读返回", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		service := newTestService(host)
		unchanged, err := service.RenameEntry(serviceCtx, "/var/www/index.html", "index.html")
		requireNoError(t, err)
		if unchanged.Name != "index.html" || unchanged.SizeBytes == nil || *unchanged.SizeBytes != 512 {
			t.Fatalf("unchanged = %+v", unchanged)
		}
		trimmed, err := service.RenameEntry(serviceCtx, "/var/www/index.html", "  index.html ")
		requireNoError(t, err)
		if trimmed.Name != "index.html" {
			t.Fatalf("trimmed = %+v", trimmed)
		}
		if len(host.renames) != 0 {
			t.Fatalf("应零重命名：%v", host.renames)
		}
	})

	t.Run("名字没变时的回读与 list 同口径：符号链接按指向呈现，不是链接自身的 777", func(t *testing.T) {
		service := newTestService(createFakeFilesHost(seedContainerTree()))
		entry, err := service.RenameEntry(serviceCtx, "/work/report-link", "report-link")
		requireNoError(t, err)
		want := fileEntry{
			Name: "report-link", Kind: "file", Mode: "600", Owner: "www-data",
			SizeBytes: int64Ptr(15), ModifiedAt: fakeTargetMtime.Format("2006-01-02T15:04:05.000Z"),
		}
		if !reflect.DeepEqual(entry, want) {
			t.Fatalf("entry = %+v，期望 %+v", entry, want)
		}
	})

	t.Run("同级重名报错；成功改名走注入的 renamePath 并回读（名字取 trim 后的值）", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		service := newTestService(host)
		_, err := service.RenameEntry(serviceCtx, "/var/www/index.html", "style.css")
		requireErrorExact(t, err, "同名条目已存在：style.css")
		renamed, err := service.RenameEntry(serviceCtx, "/var/www/index.html", " home.html ")
		requireNoError(t, err)
		if renamed.Name != "home.html" {
			t.Fatalf("renamed = %+v", renamed)
		}
		want := []fakeRenameCall{{from: "/var/www/index.html", to: "/var/www/home.html"}}
		if !reflect.DeepEqual(host.renames, want) {
			t.Fatalf("renames = %v，期望 %v", host.renames, want)
		}
		if node := host.nodeAt("/var/www/home.html"); node == nil || node.size != 512 {
			t.Fatal("/var/www/home.html 内容异常")
		}
	})

	t.Run("源落写禁区拒绝且零重命名", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		service := newTestService(host)
		_, err := service.RenameEntry(serviceCtx, "/root/.ssh/authorized_keys", "x")
		requireErrorExact(t, err, "拒绝操作受保护路径：/root/.ssh/authorized_keys")
		if len(host.renames) != 0 {
			t.Fatalf("应零重命名：%v", host.renames)
		}
	})

	t.Run("目标名恰好补齐禁区路径时拒绝且零重命名", func(t *testing.T) {
		host := createHostWithoutRootSsh()
		service := newTestService(host)
		host.nodeAt("/root").setChild("old.name", fakeFileNode(10))
		_, err := service.RenameEntry(serviceCtx, "/root/old.name", ".ssh")
		requireErrorExact(t, err, "拒绝操作受保护路径：/root/.ssh")
		if len(host.renames) != 0 {
			t.Fatalf("应零重命名：%v", host.renames)
		}
		if host.nodeAt("/root/.ssh") != nil {
			t.Fatal("保护区内不得出现条目")
		}
	})

	t.Run("父目录在锚点捕获后被换链：拒绝 rename 且不写穿", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		planted := swapDirAfterFirstRealpath(host, "/var/www", "/root/.ssh")
		service := newTestService(host)

		_, err := service.RenameEntry(serviceCtx, "/var/www/index.html", "home.html")
		requireSystemErrorExact(t, err, "目标目录在操作期间被替换，已中止：/var/www")

		if !planted() {
			t.Fatal("换链窗口未触发")
		}
		if len(host.renames) != 0 {
			t.Fatalf("应零重命名：%v", host.renames)
		}
		if host.nodeAt("/root/.ssh/home.html") != nil {
			t.Fatal("保护区内不得出现产物")
		}
	})
}

func TestServiceCompressEntry(t *testing.T) {
	t.Run("tar 数组传参（`--` 分隔防名字当选项），回读返回压缩包条目；同名压缩包已存在报错", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		service := newTestService(host)
		archive, err := service.CompressEntry(serviceCtx, "/etc/nginx")
		requireNoError(t, err)
		if archive.Name != "nginx.tar.gz" || archive.Kind != "file" {
			t.Fatalf("archive = %+v", archive)
		}
		// tar 只写私有暂存目录，`--` 分隔与 -C 语义不变；最终名由 rename(2) 发布。
		var tarCommand *fakeCommand
		for i := range host.writeCommands() {
			if host.writeCommands()[i].command == "tar" {
				tarCommand = &host.writeCommands()[i]
			}
		}
		if tarCommand == nil || tarCommand.args[0] != "-czf" || !etcStagingPayloadPattern.MatchString(tarCommand.args[1]) {
			t.Fatalf("tar argv = %v", tarCommand)
		}
		if got := tarCommand.args[2:]; !reflect.DeepEqual(got, []string{"-C", "/etc", "--", "nginx"}) {
			t.Fatalf("tar argv 尾段 = %v", got)
		}
		wantRenames := []fakeRenameCall{{from: tarCommand.args[1], to: "/etc/nginx.tar.gz"}}
		if !reflect.DeepEqual(host.renames, wantRenames) {
			t.Fatalf("renames = %v，期望 %v", host.renames, wantRenames)
		}
		if node := host.nodeAt("/etc/nginx.tar.gz"); node == nil || node.kind != fakeFileKind {
			t.Fatal("/etc/nginx.tar.gz 应为文件")
		}
		for _, name := range host.childNamesOf("/etc") {
			if len(name) >= 17 && name[:17] == ".elysian-staging-" {
				t.Fatalf("暂存目录残留：%v", host.childNamesOf("/etc"))
			}
		}
		_, err = service.CompressEntry(serviceCtx, "/etc/nginx")
		requireErrorExact(t, err, "同名压缩包已存在：nginx.tar.gz")
	})

	t.Run("校验顺序与文案逐字对齐 mock：根目录、父目录不存在、源不存在", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		service := newTestService(host)
		_, err := service.CompressEntry(serviceCtx, "/")
		requireErrorExact(t, err, "根目录不能压缩")
		_, err = service.CompressEntry(serviceCtx, "/nope/x")
		requireErrorExact(t, err, "目录不存在：/nope")
		_, err = service.CompressEntry(serviceCtx, "/var/www/nothere")
		requireErrorExact(t, err, "目录不存在：/var/www/nothere")
		requireZeroWriteCommands(t, host)
	})

	t.Run("源落写禁区与预检超预算都拒绝且零命令", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		service := newTestService(host)
		_, err := service.CompressEntry(serviceCtx, "/root/.bun")
		requireErrorExact(t, err, "拒绝操作受保护路径：/root/.bun")
		requireZeroWriteCommands(t, host)

		hugeHost := createHugeHost()
		huge := newTestService(hugeHost)
		_, err = huge.CompressEntry(serviceCtx, "/big")
		requireErrorExact(t, err, "目录规模超出操作上限（50000 个条目）")
		requireZeroWriteCommands(t, hugeHost)
	})

	t.Run("压缩包名在预检窗口被抢注为符号链接：tar 不写穿禁区文件，按 mock 语义报同名已存在", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		planted := plantSymlinkAfterFirstReaddir(host, "/etc/nginx.tar.gz", "/root/.ssh/authorized_keys")
		service := newTestService(host)

		_, err := service.CompressEntry(serviceCtx, "/etc/nginx")
		requireErrorExact(t, err, "同名压缩包已存在：nginx.tar.gz")

		if !planted() {
			t.Fatal("抢注窗口未触发")
		}
		// tar 只写私有暂存目录；发布复核发现名字已被抢注，按 mock 文案报出而不是替换或写穿。
		if node := host.nodeAt("/etc/nginx.tar.gz", false); node == nil || node.kind != fakeLinkKind {
			t.Fatalf("/etc/nginx.tar.gz 应保持为链接")
		}
		if node := host.nodeAt("/root/.ssh/authorized_keys"); node.size != 394 || node.mode != 0o600 {
			t.Fatalf("禁区文件被改写：%+v", node)
		}
		var tarCommand *fakeCommand
		for i := range host.writeCommands() {
			if host.writeCommands()[i].command == "tar" {
				tarCommand = &host.writeCommands()[i]
			}
		}
		if tarCommand == nil || !regexp.MustCompile(`^/etc/\.elysian-staging-[0-9a-f]+/\.payload$`).MatchString(tarCommand.args[1]) {
			t.Fatalf("tar argv = %v", tarCommand)
		}
		for _, name := range host.childNamesOf("/etc") {
			if len(name) >= 17 && name[:17] == ".elysian-staging-" {
				t.Fatalf("暂存目录残留：%v", host.childNamesOf("/etc"))
			}
		}
	})

	t.Run("父目录在锚点捕获后被换链：拒绝压缩与发布且零命令", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		planted := swapDirAfterFirstRealpath(host, "/srv", "/root/.Elysian")
		service := newTestService(host)

		_, err := service.CompressEntry(serviceCtx, "/srv/deploy.sh")
		requireSystemErrorExact(t, err, "目标目录在操作期间被替换，已中止：/srv")

		if !planted() {
			t.Fatal("换链窗口未触发")
		}
		requireZeroWriteCommands(t, host)
		// 换链后误建进保护区的暂存目录已被 finally 清理，保护区无任何新条目。
		if names := host.childNamesOf("/root/.Elysian"); !reflect.DeepEqual(names, []string{"data"}) {
			t.Fatalf("/root/.Elysian 子项 = %v", names)
		}
	})
}

func TestServiceChmod(t *testing.T) {
	t.Run("校验顺序与文案逐字对齐 mock：根目录、权限位、空所有者、路径不存在、递归非目录", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		service := newTestService(host)
		err := service.Chmod(serviceCtx, "/", filePermissionInput{mode: "755", owner: "root", recursive: false})
		requireErrorExact(t, err, "根目录不能改权限")
		err = service.Chmod(serviceCtx, "/etc/nginx", filePermissionInput{mode: "888", owner: "root", recursive: false})
		requireErrorExact(t, err, "无效的权限位：888")
		err = service.Chmod(serviceCtx, "/etc/nginx", filePermissionInput{mode: "755", owner: "  ", recursive: false})
		requireErrorExact(t, err, "所有者不能为空")
		err = service.Chmod(serviceCtx, "/nope/x", filePermissionInput{mode: "755", owner: "root", recursive: false})
		requireErrorExact(t, err, "目录不存在：/nope/x")
		err = service.Chmod(serviceCtx, "/etc/nginx/nginx.conf", filePermissionInput{mode: "755", owner: "root", recursive: true})
		requireErrorExact(t, err, "只有目录可以连同子目录一起改权限")
		if len(host.chmodCalls) != 0 {
			t.Fatalf("应零命令：%v", host.chmodCalls)
		}
	})

	t.Run("owner 名与账号反查：非法名与查无账号的中文错误", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		service := newTestService(host)
		err := service.Chmod(serviceCtx, "/etc/nginx", filePermissionInput{mode: "755", owner: "Bad Name", recursive: false})
		requireErrorExact(t, err, "无效的所有者名：Bad Name")
		err = service.Chmod(serviceCtx, "/etc/nginx", filePermissionInput{mode: "755", owner: "ghost", recursive: false})
		requireErrorExact(t, err, "未找到系统账号：ghost")
		if len(host.chmodCalls) != 0 {
			t.Fatalf("应零命令：%v", host.chmodCalls)
		}
	})

	t.Run("非递归：chmodNoFollow + chownNoFollow 落到条目本身，后代不动", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		service := newTestService(host)
		requireNoError(t, service.Chmod(serviceCtx, "/etc/nginx/nginx.conf", filePermissionInput{mode: "600", owner: "deploy", recursive: false}))
		wantChmod := []fakeChmodCall{{path: "/etc/nginx/nginx.conf", mode: 0o600}}
		wantChown := []fakeChownCall{{path: "/etc/nginx/nginx.conf", uid: 1000, gid: 1000}}
		if !reflect.DeepEqual(host.chmodCalls, wantChmod) {
			t.Fatalf("chmodCalls = %v，期望 %v", host.chmodCalls, wantChmod)
		}
		if !reflect.DeepEqual(host.chownCalls, wantChown) {
			t.Fatalf("chownCalls = %v，期望 %v", host.chownCalls, wantChown)
		}
		if node := host.nodeAt("/etc/nginx/nginx.conf"); node.mode != 0o600 {
			t.Fatalf("mode = %o", node.mode)
		}
		if node := host.nodeAt("/etc/nginx/conf.d"); node.mode != 0o755 {
			t.Fatalf("后代不应被动：mode = %o", node.mode)
		}
	})

	t.Run("最终组件是符号链接：显式中文拒绝，绝不改到链接目标上", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		service := newTestService(host)
		err := service.Chmod(serviceCtx, "/var/log/current", filePermissionInput{mode: "644", owner: "root", recursive: false})
		requireErrorExact(t, err, "不能对符号链接执行该操作：/var/log/current")
		if len(host.chmodCalls) != 0 {
			t.Fatalf("应零命令：%v", host.chmodCalls)
		}
	})

	t.Run("递归：收集段先于执行段，后代全部改到，符号链接后代跳过", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		service := newTestService(host)
		requireNoError(t, service.Chmod(serviceCtx, "/var/log", filePermissionInput{mode: "750", owner: "www-data", recursive: true}))
		paths := map[string]bool{}
		for _, call := range host.chmodCalls {
			paths[call.path] = true
		}
		want := []string{"/var/log", "/var/log/syslog", "/var/log/auth.log", "/var/log/foreign", "/var/log/nginx", "/var/log/nginx/access.log"}
		if len(paths) != len(want) {
			t.Fatalf("chmod 路径集 = %v，期望 %v", paths, want)
		}
		for _, path := range want {
			if !paths[path] {
				t.Fatalf("缺少 %s：%v", path, paths)
			}
		}
		// 符号链接后代不在收集列表：fake 的 chmodNoFollow 对链接抛 ELOOP，进了列表这里就会红。
		if paths["/var/log/current"] {
			t.Fatalf("符号链接后代不应进收集列表：%v", paths)
		}
		if node := host.nodeAt("/var/log/current", false); node.mode != 0o777 {
			t.Fatalf("链接自身 mode 应保持 777：%o", node.mode)
		}
		if node := host.nodeAt("/var/log/nginx/access.log"); node.uid != 33 {
			t.Fatalf("后代属主应改为 www-data：%d", node.uid)
		}
	})

	t.Run("chmod -R /root：收集列表含保护区后代，整体拒绝且命令账本为零", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		service := newTestService(host)
		err := service.Chmod(serviceCtx, "/root", filePermissionInput{mode: "755", owner: "root", recursive: true})
		requireErrorExact(t, err, "拒绝操作受保护路径：/root/.ssh")
		if len(host.chmodCalls) != 0 || len(host.chownCalls) != 0 {
			t.Fatalf("应零命令：chmod=%v chown=%v", host.chmodCalls, host.chownCalls)
		}
	})

	t.Run("直接点名的禁区路径同样拒绝（/app、/root/.Elysian、/proc）", func(t *testing.T) {
		host := createFakeFilesHost(seedContainerTree())
		service := newTestService(host)
		for _, path := range []string{"/app", "/root/.Elysian/data", "/proc/cpuinfo"} {
			err := service.Chmod(serviceCtx, path, filePermissionInput{mode: "755", owner: "root", recursive: false})
			if err == nil || !strings.HasPrefix(errMessage(err), "拒绝操作受保护路径：") {
				t.Fatalf("%s 应拒绝，得到 %v", path, err)
			}
		}
		if len(host.chmodCalls) != 0 {
			t.Fatalf("应零命令：%v", host.chmodCalls)
		}
	})

	t.Run("递归收集超预算：在收集段拒绝，不留半改状态", func(t *testing.T) {
		host := createHugeHost()
		service := newTestService(host)
		err := service.Chmod(serviceCtx, "/big", filePermissionInput{mode: "755", owner: "root", recursive: true})
		requireErrorExact(t, err, "目录规模超出操作上限（50000 个条目）")
		if len(host.chmodCalls) != 0 {
			t.Fatalf("应零命令：%v", host.chmodCalls)
		}
	})
}

func TestServiceSearch(t *testing.T) {
	t.Run("空关键词（含纯空白）返回空数组", func(t *testing.T) {
		service := newTestService(createFakeFilesHost(seedContainerTree()))
		results, err := service.Search(serviceCtx, "")
		requireNoError(t, err)
		if len(results) != 0 {
			t.Fatalf("空关键词应回空数组：%v", results)
		}
		results, err = service.Search(serviceCtx, "   ")
		requireNoError(t, err)
		if len(results) != 0 {
			t.Fatalf("纯空白关键词应回空数组：%v", results)
		}
	})

	t.Run("契约口径：去全部空白+小写，名称与完整路径任一命中；结果带绝对 path 与条目字段", func(t *testing.T) {
		service := newTestService(createFakeFilesHost(seedContainerTree()))
		results, err := service.Search(serviceCtx, "syslog")
		requireNoError(t, err)
		if len(results) != 1 || results[0].Path != "/var/log/syslog" {
			t.Fatalf("syslog 结果 = %v", results)
		}
		if results[0].Name != "syslog" || results[0].Kind != "file" || results[0].Owner != "root" {
			t.Fatalf("结果字段 = %+v", results[0])
		}

		spaced, err := service.Search(serviceCtx, " SYS log ")
		requireNoError(t, err)
		if len(spaced) != 1 || spaced[0].Path != "/var/log/syslog" {
			t.Fatalf("去空白口径结果 = %v", spaced)
		}

		// 路径命中：elysian.conf 的名字不含 nginx，但所在路径含；/var/log/nginx 同理由路径命中。
		byPath, err := service.Search(serviceCtx, "nginx")
		requireNoError(t, err)
		got := make([]string, 0, len(byPath))
		for _, result := range byPath {
			got = append(got, result.Path)
		}
		want := []string{
			"/etc/nginx",
			"/etc/nginx/conf.d",
			"/etc/nginx/conf.d/elysian.conf",
			"/etc/nginx/nginx.conf",
			"/var/log/nginx",
			"/var/log/nginx/access.log",
		}
		if !reflect.DeepEqual(sortedStrings(got), sortedStrings(want)) {
			t.Fatalf("路径命中 = %v，期望 %v", sortedStrings(got), sortedStrings(want))
		}
	})

	t.Run("剪枝清单：/proc、node_modules 段与 /root/.bun 整树跳过，预算留给系统文件", func(t *testing.T) {
		service := newTestService(createFakeFilesHost(seedContainerTree()))
		for _, keyword := range []string{"cpuinfo", "index.js", "cache.bin"} {
			results, err := service.Search(serviceCtx, keyword)
			requireNoError(t, err)
			if len(results) != 0 {
				t.Fatalf("剪枝对象 %s 不应命中：%v", keyword, results)
			}
		}
		// 同名不剪的对照：node_modules 之外的 index.ts 正常命中。
		results, err := service.Search(serviceCtx, "index.ts")
		requireNoError(t, err)
		if len(results) != 2 {
			t.Fatalf("index.ts 应命中 2 条：%v", results)
		}
	})

	t.Run("owner 解析与 list 同款（一次 getent 建映射）", func(t *testing.T) {
		service := newTestService(createFakeFilesHost(seedContainerTree()))
		results, err := service.Search(serviceCtx, "deploy.sh")
		requireNoError(t, err)
		if len(results) == 0 {
			t.Fatal("deploy.sh 应有命中")
		}
		// walk 先访 home 子树（LIFO），首条是 /home/deploy/deploy.sh。
		if results[0].Owner != "deploy" {
			t.Fatalf("owner = %q，期望 deploy（结果 %v）", results[0].Owner, results)
		}
	})

	t.Run("结果超过 1000 条时触顶截断", func(t *testing.T) {
		children := make([]fakeNamedNode, 0, 1001)
		for index := 0; index < 1001; index++ {
			children = append(children, d(fmt.Sprintf("hit%d", index), fakeFileNode(1)))
		}
		service := newTestService(createFakeFilesHost(fakeDirNode(d("many", fakeDirNode(children...)))))
		results, err := service.Search(serviceCtx, "hit")
		requireNoError(t, err)
		if len(results) != 1000 {
			t.Fatalf("截断后应为 1000 条，得到 %d", len(results))
		}
	})

	t.Run("命中符号链接按指向呈现（契约口径）：活链接取指向的字段，断链才回退链接自身", func(t *testing.T) {
		service := newTestService(createFakeFilesHost(seedContainerTree()))

		// 活链接 report-link → report.txt：mode 600 / www-data / 15 字节 / 目标时间戳
		//（链接自身是 777 / root / 路径字节数 / 链接时间戳，两者在四个字段上都不同）。
		live, err := service.Search(serviceCtx, "report-link")
		requireNoError(t, err)
		wantLive := []fileSearchResult{{
			fileEntry: fileEntry{
				Name: "report-link", Kind: "file", Mode: "600", Owner: "www-data",
				SizeBytes: int64Ptr(15), ModifiedAt: fakeTargetMtime.Format("2006-01-02T15:04:05.000Z"),
			},
			Path: "/work/report-link",
		}}
		if !reflect.DeepEqual(live, wantLive) {
			t.Fatalf("活链接结果 = %+v，期望 %+v", live, wantLive)
		}

		// 断链：回退 lstat 按链接自身呈现，与 list 的降级同款。
		dangling, err := service.Search(serviceCtx, "dangling-link")
		requireNoError(t, err)
		wantDangling := []fileSearchResult{{
			fileEntry: fileEntry{
				Name: "dangling-link", Kind: "file", Mode: "777", Owner: "root",
				SizeBytes: int64Ptr(int64(len("/work/nothere"))), ModifiedAt: fakeMtime.Format("2006-01-02T15:04:05.000Z"),
			},
			Path: "/work/dangling-link",
		}}
		if !reflect.DeepEqual(dangling, wantDangling) {
			t.Fatalf("断链结果 = %+v，期望 %+v", dangling, wantDangling)
		}
	})

	t.Run("同一路径在 list 与 search 里的条目字段逐字一致（呈现口径只有一份）", func(t *testing.T) {
		service := newTestService(createFakeFilesHost(seedContainerTree()))
		listed, err := service.List(serviceCtx, "/work")
		requireNoError(t, err)
		found, err := service.Search(serviceCtx, "work")
		requireNoError(t, err)
		if len(listed) == 0 {
			t.Fatal("/work 应有条目")
		}
		byPath := map[string]fileSearchResult{}
		for _, result := range found {
			byPath[result.Path] = result
		}
		for _, entry := range listed {
			result, ok := byPath["/work/"+entry.Name]
			if !ok {
				t.Fatalf("search 缺少 /work/%s：%v", entry.Name, found)
			}
			want := fileSearchResult{fileEntry: entry, Path: "/work/" + entry.Name}
			if !reflect.DeepEqual(result, want) {
				t.Fatalf("字段不一致：list %+v vs search %+v", entry, result)
			}
		}
	})

	t.Run("遍历不展开指向祖先目录的活链接：搜索在环上收敛而不是无限下探", func(t *testing.T) {
		service := newTestService(createFakeFilesHost(seedContainerTree()))
		// work/loop → /work：遍历若跟随链接就会成环；命中路径里不再出现 work/loop/... 的重复展开。
		results, err := service.Search(serviceCtx, "work")
		requireNoError(t, err)
		got := make([]string, 0, len(results))
		for _, result := range results {
			got = append(got, result.Path)
		}
		want := []string{
			"/work", "/work/dangling-link", "/work/loop",
			"/work/rel-link.txt", "/work/rel.txt", "/work/report-link", "/work/report.txt",
		}
		if !reflect.DeepEqual(sortedStrings(got), sortedStrings(want)) {
			t.Fatalf("结果 = %v，期望 %v", sortedStrings(got), sortedStrings(want))
		}
	})
}
