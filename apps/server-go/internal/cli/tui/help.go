package tui

// 帮助覆盖所有页面和子面板；长内容交给现成 viewport 滚动。
func (m *Model) sizeHelp() {
	m.helpViewport.Width = max(20, m.width-2)
	m.helpViewport.Height = max(4, m.height-5)
	m.helpViewport.SetContent(wrapPlain(`F1 帮助 · Esc 逐层返回 · Ctrl+C 退出整个 CLI
退出客户端不会取消服务端已受理的任务。

登录：Tab 切换字段，Enter 登录；密码遮蔽。连接失败按 r 重试。
会话列表：↑↓/j/k 选择，g/G 首尾，Enter 打开，n 新建，r 刷新，l 加载更多，t 重命名，d 删除，m 模型与思考档，o 登出。
模型向导：↑↓ 选择，Enter 下一步/确认，Esc 返回。运行中不能切换模型，未确认提交不能删除或切换模型。

聊天：Enter 发送；未确认时重试原完整请求。Ctrl+J 换行，Shift+Tab 切换权限模式，PgUp/PgDn/Home/End 滚动消息。
F2 编辑最后一条服务端用户消息：会话必须空闲、装配成功且无未确认提交；Esc 返回普通草稿，编辑内容独立保存。
F3 执行历史：↑↓ 选择，Enter 查看完整思考、参数、结果、计划、用量与终态原因；l 加载更多，r 重读，PgUp/PgDn 滚动详情。
F4 图片：a 文件选择，p 输入路径，↑↓ 选择，d 移除草稿或未确认项，e 导出，o 导出并外部打开，Esc 返回或取消处理。已发送附件不能删除。上传结果未知时不自动重传。
Ctrl+S 停止当前运行；Ctrl+T 展开思考；Ctrl+P 展开计划；Ctrl+O 工具详情和用量，Enter/d 展开，↑↓ 选择，失败时 r 重试。
Ctrl+A 审批与本会话授权：Tab 切换页签，↑↓ 选择，Enter/d 查看详情；普通审批 y 允许、n 拒绝；运行时授权 1 仅本次、2 本会话、3 拒绝；x 停止本轮，本会话授权页 r 撤回。
等待回答：Enter 选择，t 自定义，←→ 换题；Esc 暂收起，Enter 重开，Ctrl+S 停止本轮。

发送禁用条件：会话/任务/消息读取中或失败、正在运行、正在提交、图片上传未确认。读取失败按 r 重读。运行中或提交未确认不能切换权限。提交在途不能切换会话。`, m.helpViewport.Width))
}
