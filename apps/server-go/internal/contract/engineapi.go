package contract

// 集成阶段上收的跨域共享常量（go-plan §4.4：域实现期登记的 contract 缺件里，只有
// 被≥2 个域消费、存在漂移风险的两件值得收口；其余单一消费方的判据仍留在域内私用，
// 由各域测试锚定，不构成跨域共享类型）。

// PanelPort 面板对外访问端口（TS 契约 PANEL_PORT）：防火墙禁区判据（firewall）与
// 容器宿主保留端口表（docker）的同一事实源。迁移期 firewall.PanelPort 与 docker 的
// panelPort 各自定义 48100，收敛到契约防漂移（两域常量改为引用此处）。
const PanelPort = 48100

// Engine API 版本判据的逐字文案（docker 探测与 platform 依赖探测共用）：
// 数字比较阈值 ≥1.41 的解析实现保留在各域（两侧测试分别锚定各自的 JS 数字语义
// 等价物），只收口用户可见文案防漂移。
const EngineAPITooLowMessage = "Docker Engine API 版本过低，需要 1.41 及以上"
