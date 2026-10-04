/** 输入框、下拉触发器与同行按钮共用 36px 高度。 */
export const FORM_CONTROL_HEIGHT_CLASS = 'h-9'

/*
 * 控件类名出口。形状（高度、圆角、描边、底色、色阶）全部定义在
 * src/styles/index.css 的控件层里，这里只给 TSX 一个引用点——
 * 页面要一个按钮就写 `ctl ctl-default`，不再各自抄一串 utility。
 * 需要局部微调时再叠工具类（如 `w-full`、`ml-auto`、`px-4`）。
 */

/** 推进动作：有描边有底，工具栏与表单主按钮。 */
export const CTL_PRIMARY = 'ctl ctl-default'
/** 次要动作：只描边不铺底，悬停才抬起。 */
export const CTL_SECONDARY = 'ctl ctl-quiet'
/** 破坏性动作：危险色底与描边。 */
export const CTL_DANGER = 'ctl ctl-danger'
/** 卡内行动作：同一形状矮一档。 */
export const CTL_CARD_ACTION = 'ctl ctl-sm ctl-quiet'
/** 文本输入框与下拉触发器。 */
export const CTL_FIELD = 'ctl-field'
/** 下拉触发器：与输入框同档形状，内部两端排布。 */
export const CTL_SELECT = 'ctl-select'
/** 筛选芯片；选中态由 aria-pressed 表达，不另造类名。 */
export const CTL_CHIP = 'ctl ctl-chip'
/** 把一组相关控件包成一个胶囊对象的容器。 */
export const CTL_GROUP = 'ctl-group'
/**
 * 工具栏语境：挂在工具栏容器上，行内所有控件成员自动统一成胶囊与同一高度。
 * 只声明形状，不声明布局——布局仍由调用方的 flex 类负责。
 */
export const CTL_TOOLBAR = 'toolbar'
/** 卡片内的信息格。 */
export const CTL_TILE = 'tile'
/** 分段读数芯片（端口映射一类）。 */
export const CTL_STAT = 'stat-chip'
