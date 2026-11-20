package harness

import (
	"context"
	"sort"

	"elysian/server/internal/agent/harness/model"
)

// imageReplayBudgetBytes 是单次模型请求允许重挂的全部图片（本轮与历史）原始字节总预算：
// base64 后在模型客户端 16 MiB 请求上限内留出文本余量；超出预算的历史轮降级为文字注记。
const imageReplayBudgetBytes = maxImageAttachmentSetBytes

// runImagePlan 记录一轮历史输入在重放预算内的图片与被预算挤掉的张数。
type runImagePlan struct {
	images  []model.ImagePart
	dropped int
}

// attachmentImageMeta 是预算分配所需的附件元数据：刻意不含字节内容，
// 预算判死的轮次不必把 BLOB 搬进内存。
type attachmentImageMeta struct {
	ID       string
	MimeType string
	Bytes    int
}

func attachmentRefIDs(run Run) []string {
	if run.Selection == nil || len(run.Selection.Attachments) == 0 {
		return nil
	}
	ids := make([]string, 0, len(run.Selection.Attachments))
	for _, ref := range run.Selection.Attachments {
		ids = append(ids, ref.ID)
	}
	return ids
}

// attachmentImageMetasLocked 按引用顺序读取附件元数据（不含 content BLOB）；
// 读取失败必须传播，避免丢失用户输入后继续执行。
// 调用方必须持有 Manager.mu。
func (a *agentExecution) attachmentImageMetasLocked(ctx context.Context, run Run) ([]attachmentImageMeta, error) {
	ids := attachmentRefIDs(run)
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := readView(ctx, a.manager.store).AttachmentMetadata(ctx, ids)
	if err != nil {
		return nil, err
	}

	byID := make(map[string]attachmentImageMeta, len(ids))
	for _, record := range rows {
		var meta attachmentImageMeta
		meta.ID, meta.MimeType, meta.Bytes = record.ID, record.MimeType, record.Bytes
		byID[meta.ID] = meta
	}
	metas := make([]attachmentImageMeta, 0, len(ids))
	for _, id := range ids {
		if meta, ok := byID[id]; ok {
			metas = append(metas, meta)
		}
	}
	if len(metas) != len(ids) {
		return nil, bad("attachment-missing", "任务图片附件缺失，请核实原输入后继续")
	}
	return metas, nil
}

// attachmentImagePartsLocked 只载入选中附件（预算分配后的元数据）的字节并组装为
// 图片输入；调用方必须持有 Manager.mu。
func (a *agentExecution) attachmentImagePartsLocked(ctx context.Context, metas []attachmentImageMeta) ([]model.ImagePart, error) {
	if len(metas) == 0 {
		return nil, nil
	}
	ids := make([]string, 0, len(metas))
	for _, meta := range metas {
		ids = append(ids, meta.ID)
	}
	rows, err := readView(ctx, a.manager.store).AttachmentBytes(ctx, ids)
	if err != nil {
		return nil, err
	}

	content := make(map[string][]byte, len(ids))
	for _, record := range rows {
		var id string
		var data []byte
		id, data = record.ID, record.Content
		content[id] = data
	}
	parts := make([]model.ImagePart, 0, len(metas))
	for _, meta := range metas {
		if data, ok := content[meta.ID]; ok {
			parts = append(parts, model.ImagePart{MimeType: meta.MimeType, Data: data})
		}
	}
	if len(parts) != len(metas) {
		return nil, bad("attachment-missing", "任务图片附件缺失，请核实原输入后继续")
	}
	return parts, nil
}

// planRunImages 按模型能力分配图片重放：本轮优先挂 header，历史按最近优先在剩余
// 预算内重挂，超预算的历史图片降级为文字注记；模型无图能力时一律不挂 Images。
// 分配只读元数据，字节在轮次入选后才按需载入，预算判死的轮次不搬 BLOB。
func (a *agentExecution) planRunImages(ctx context.Context, runs []Run) (map[string]runImagePlan, error) {
	a.currentImages = nil
	support := a.run.Model != nil && a.run.Model.Capabilities.Image
	if !support {
		return nil, nil
	}
	budget := imageReplayBudgetBytes
	metas, err := a.attachmentImageMetasLocked(ctx, a.run)
	if err != nil {
		return nil, err
	}
	if len(metas) > 0 {
		// 本轮附件必挂 header：提交校验保证其合计不超过 8 MiB 重放预算。
		a.currentImages, err = a.attachmentImagePartsLocked(ctx, metas)
		if err != nil {
			return nil, err
		}
		for _, part := range a.currentImages {
			budget -= len(part.Data)
		}
	}
	var history []Run
	for _, run := range runs {
		if run.ID != a.run.ID && run.SupersededByRunID == "" && run.Selection != nil && len(run.Selection.Attachments) > 0 {
			history = append(history, run)
		}
	}
	sort.SliceStable(history, func(i, j int) bool { return history[i].RunNumber > history[j].RunNumber })
	plans := map[string]runImagePlan{}
	for _, run := range history {
		var plan runImagePlan
		var kept []attachmentImageMeta
		metas, err := a.attachmentImageMetasLocked(ctx, run)
		if err != nil {
			return nil, err
		}
		for _, meta := range metas {
			if meta.Bytes <= budget {
				budget -= meta.Bytes
				kept = append(kept, meta)
			} else {
				plan.dropped++
			}
		}
		if len(kept) > 0 || plan.dropped > 0 {
			plan.images, err = a.attachmentImagePartsLocked(ctx, kept)
			if err != nil {
				return nil, err
			}
			plans[run.ID] = plan
		}
	}
	return plans, nil
}
