package harness

// 旧轮仍保留审计记录，公开对话和后续模型上下文只读取有效轮次。
const visibleRunSQL = "COALESCE(json_extract(r.document,'$.supersededByRunId'),'')=''"
