package harness

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"elysian/server/internal/agent/harness/model"
)

// imagesTestClient 收集每次推理请求的消息形状：图片张数与文本注记；
// 记忆整理请求一律返回非法答复，使历史输入事实不被记忆覆盖，便于断言重放行为。
type imagesTestClient struct {
	mu       sync.Mutex
	requests []model.Request
}

func (c *imagesTestClient) complete(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
	if request.ToolChoice == "store_working_memory" {
		return finalReply("记忆整理不适用"), nil
	}
	c.mu.Lock()
	c.requests = append(c.requests, request)
	c.mu.Unlock()
	return finalReply("已看完图片"), nil
}

func (c *imagesTestClient) last() model.Request {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.requests) == 0 {
		return model.Request{}
	}
	return c.requests[len(c.requests)-1]
}

func imagesIn(request model.Request) int {
	total := 0
	for _, msg := range request.Messages {
		total += len(msg.Images)
	}
	return total
}

// visionSession 在默认无图模型之外补一个声明 image 能力的模型并建会话。
func visionSession(t *testing.T, m *Manager) Session {
	t.Helper()
	secret := "test-only-secret-never-persist-in-runtime"
	profile, err := m.CreateModelProfile(model.Input{Provider: model.ProviderOpenAICompatible, APIFormat: model.FormatChatCompletions, BaseURL: "http://127.0.0.1:9/v1", Model: "vision-test", ContextTokens: 65536, OutputTokens: 4096, Capabilities: model.Capabilities{Text: true, Tools: true, Image: true, Source: "test"}, Active: true, Credential: &secret})
	if err != nil {
		t.Fatal(err)
	}
	session, err := m.CreateSession(context.Background(), CreateSessionInput{Title: "带图会话", ModelProfileID: profile.ID, ModelRevision: profile.Revision})
	if err != nil {
		t.Fatal(err)
	}
	return session
}

func uploadOne(t *testing.T, m *Manager, content []byte) AttachmentRef {
	t.Helper()
	items, err := m.CreateAttachments(context.Background(), []AttachmentUpload{{Name: "图.png", Content: content}})
	if err != nil {
		t.Fatal(err)
	}
	return AttachmentRef{ID: items[0].ID}
}

func switchToPlainModel(t *testing.T, m *Manager, plain Session, target Session) {
	t.Helper()
	if _, err := m.SwitchSessionModel(context.Background(), target.ID, SwitchModelInput{ModelProfileID: plain.ModelProfileID, ModelRevision: plain.ModelRevision}); err != nil {
		t.Fatal(err)
	}
}

func TestAgentImageGateAndSubmitRecheck(t *testing.T) {
	client := &imagesTestClient{}
	m, plain, _ := agentManager(t, client.complete, nil)
	ctx := context.Background()
	ref := uploadOne(t, m, testPNGBytes(t, 2, 2))
	if _, _, err := m.CreateTask(ctx, plain.ID, AgentInput{RequestID: "gate-new", Content: "看图说话", Attachments: []AttachmentRef{ref}}); err == nil || err.(*Error).Code != "image-unsupported" {
		t.Fatalf("无图模型新建发送未拒绝：%v", err)
	}
	vision := visionSession(t, m)
	png := testPNGBytes(t, 1, 1)
	// 分批上传绕过单请求限额：两批各 3 张小图，一次提交 5 个引用仍被提交侧复检拦截。
	var refs []AttachmentRef
	for batch := 0; batch < 2; batch++ {
		uploads := []AttachmentUpload{{Name: "图.png", Content: png}, {Name: "图.png", Content: png}, {Name: "图.png", Content: png}}
		items, err := m.CreateAttachments(ctx, uploads)
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range items {
			refs = append(refs, AttachmentRef{ID: item.ID})
		}
	}
	if _, _, err := m.CreateTask(ctx, vision.ID, AgentInput{RequestID: "split-batch", Content: "五张图", Attachments: refs}); err == nil || err.(*Error).Code != "attachment-too-many" {
		t.Fatalf("分批攒图未拦截：%v", err)
	}
	// 分批上传两张各 2.5 MiB（单批一张合法），一次提交合计超 4 MiB 被拒。
	big1 := uploadOne(t, m, paddedImage(t, png, 2621440))
	big2 := uploadOne(t, m, paddedImage(t, png, 2621440))
	if _, _, err := m.CreateTask(ctx, vision.ID, AgentInput{RequestID: "split-bytes", Content: "两张大图", Attachments: []AttachmentRef{big1, big2}}); err == nil || err.(*Error).Code != "attachment-message-too-large" {
		t.Fatalf("分批攒字节未拦截：%v", err)
	}
	if _, _, err := m.CreateTask(ctx, vision.ID, AgentInput{RequestID: "missing", Content: "引用不存在", Attachments: []AttachmentRef{{ID: "no-such-attachment"}}}); err == nil || err.(*Error).Code != "attachment-invalid" {
		t.Fatalf("不存在引用未拒绝：%v", err)
	}
	// 附件已绑定其他会话时同样拒绝，且不留下任何半次接受。
	first, _, err := m.CreateTask(ctx, vision.ID, AgentInput{RequestID: "claim", Content: "占用附件", Attachments: []AttachmentRef{ref}})
	if err != nil {
		t.Fatal(err)
	}
	runtimeFinished(t, m, first.ID)
	other := visionSession(t, m)
	if _, _, err := m.CreateTask(ctx, other.ID, AgentInput{RequestID: "steal", Content: "抢附件", Attachments: []AttachmentRef{ref}}); err == nil || err.(*Error).Code != "attachment-invalid" {
		t.Fatalf("跨会话复用未拒绝：%v", err)
	}
	// canonical：重复 id 与去重后输入视为同一幂等键；同一 requestId 换附件集合即冲突。
	run, _, err := m.CreateTask(ctx, vision.ID, AgentInput{RequestID: "dedup", Content: "重复引用", Attachments: []AttachmentRef{ref, ref}})
	if err != nil {
		t.Fatal(err)
	}
	runtimeFinished(t, m, run.ID)
	if _, duplicate, err := m.CreateTask(ctx, vision.ID, AgentInput{RequestID: "dedup", Content: "重复引用", Attachments: []AttachmentRef{ref}}); err != nil || !duplicate {
		t.Fatalf("重复 id 与去重后输入未视为同一幂等键：%v %v", err, duplicate)
	}
	if _, _, err := m.CreateTask(ctx, vision.ID, AgentInput{RequestID: "dedup", Content: "重复引用", Attachments: []AttachmentRef{ref, uploadOne(t, m, png)}}); err == nil || err.(*Error).Code != "request-conflict" {
		t.Fatalf("附件集合变化未冲突：%v", err)
	}
}

func TestAgentImageEditResendReusesBoundAttachment(t *testing.T) {
	client := &imagesTestClient{}
	m, plain, _ := agentManager(t, client.complete, nil)
	ctx := context.Background()
	vision := visionSession(t, m)
	ref := uploadOne(t, m, testPNGBytes(t, 3, 3))
	first, _, err := m.CreateTask(ctx, vision.ID, AgentInput{RequestID: "vision-first", Content: "第一轮带图", Attachments: []AttachmentRef{ref}})
	if err != nil {
		t.Fatal(err)
	}
	runtimeFinished(t, m, first.ID)
	page, err := m.Messages(ctx, vision.ID, "0", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 || len(page.Items[0].Attachments) != 1 || page.Items[0].Attachments[0].ID != ref.ID {
		t.Fatalf("带图消息未落附件描述符：%+v", page.Items)
	}
	// 编辑重发复用已绑定本会话的附件 id：绑定谓词放行，不回滚。
	target := page.Items[0].ID
	resend, _, err := m.ContinueTask(ctx, first.TaskID, AgentInput{RequestID: "vision-edit", Content: "改写后的问题", ReplaceMessageID: target, Attachments: []AttachmentRef{ref}})
	if err != nil {
		t.Fatal(err)
	}
	runtimeFinished(t, m, resend.ID)
	if imagesIn(client.last()) != 1 {
		t.Fatalf("编辑重发未重挂图片：%d", imagesIn(client.last()))
	}
	// 切到无图模型后，编辑重发携带原轮附件同样被服务端门禁拒绝。
	switchToPlainModel(t, m, plain, vision)
	if _, _, err = m.ContinueTask(ctx, first.TaskID, AgentInput{RequestID: "vision-edit-again", Content: "再改一次", ReplaceMessageID: target, Attachments: []AttachmentRef{ref}}); err == nil || err.(*Error).Code != "image-unsupported" {
		t.Fatalf("无图模型编辑重发未拒绝：%v", err)
	}
}

func TestAgentImageHistoryDegradesWithoutImageSupport(t *testing.T) {
	client := &imagesTestClient{}
	m, plain, _ := agentManager(t, client.complete, nil)
	ctx := context.Background()
	vision := visionSession(t, m)
	ref := uploadOne(t, m, testPNGBytes(t, 2, 2))
	first, _, err := m.CreateTask(ctx, vision.ID, AgentInput{RequestID: "history-image", Content: "第一轮带图", Attachments: []AttachmentRef{ref}})
	if err != nil {
		t.Fatal(err)
	}
	runtimeFinished(t, m, first.ID)
	switchToPlainModel(t, m, plain, vision)
	next, _, err := m.ContinueTask(ctx, first.TaskID, AgentInput{RequestID: "history-text", Content: "纯文本续发"})
	if err != nil {
		t.Fatal(err)
	}
	runtimeFinished(t, m, next.ID)
	request := client.last()
	if imagesIn(request) != 0 {
		t.Fatalf("无图模型续发仍携带图片：%d", imagesIn(request))
	}
	found := false
	for _, msg := range request.Messages {
		if strings.Contains(msg.Content, "（该轮附图 1 张，当前模型不支持图片输入，未重发）") {
			found = true
		}
	}
	if !found {
		t.Fatal("历史图片未降级为文字注记")
	}
}

func TestAgentImageHistoryReplayBudget(t *testing.T) {
	client := &imagesTestClient{}
	m, _, _ := agentManager(t, client.complete, nil)
	ctx := context.Background()
	vision := visionSession(t, m)
	png := paddedImage(t, testPNGBytes(t, 1, 1), 3145728)
	older := uploadOne(t, m, png)
	first, _, err := m.CreateTask(ctx, vision.ID, AgentInput{RequestID: "budget-first", Content: "第一轮大图", Attachments: []AttachmentRef{older}})
	if err != nil {
		t.Fatal(err)
	}
	runtimeFinished(t, m, first.ID)
	second, _, err := m.ContinueTask(ctx, first.TaskID, AgentInput{RequestID: "budget-second", Content: "第二轮大图", Attachments: []AttachmentRef{uploadOne(t, m, png)}})
	if err != nil {
		t.Fatal(err)
	}
	runtimeFinished(t, m, second.ID)
	next, _, err := m.ContinueTask(ctx, first.TaskID, AgentInput{RequestID: "budget-third", Content: "第三轮纯文本"})
	if err != nil {
		t.Fatal(err)
	}
	runtimeFinished(t, m, next.ID)
	request := client.last()
	// 两轮各 3 MiB：本轮无图，历史最近优先占满 5 MiB 预算，较早一轮只剩容量注记。
	if got := imagesIn(request); got != 1 {
		t.Fatalf("预算内应只重挂一张图：%d", got)
	}
	found := false
	for _, msg := range request.Messages {
		if strings.Contains(msg.Content, "（该轮附图 1 张因容量未重发）") {
			found = true
		}
	}
	if !found {
		t.Fatal("超预算历史未注记")
	}
}

func TestEstimateRequestExcludesImageBytes(t *testing.T) {
	request := model.Request{MaxTokens: 128, Messages: []model.Message{
		{Role: "system", Content: "系统"},
		{Role: "user", Content: "看图", Images: []model.ImagePart{{MimeType: "image/png", Data: paddedImage(t, testPNGBytes(t, 1, 1), 3145728)}}},
	}}
	b, _ := json.Marshal(request)
	if strings.Contains(string(b), "iVBOR") || strings.Contains(string(b), "\"images\"") {
		t.Fatal("图片字节泄入估算 JSON")
	}
	if got, want := estimateRequest(request), len(b)+256+64*2+1024*1; got != want {
		t.Fatalf("估算口径错误：got=%d want=%d", got, want)
	}
	if estimateRequest(request) > len(b)+4096 {
		t.Fatal("估算被图片字节放大")
	}
}
