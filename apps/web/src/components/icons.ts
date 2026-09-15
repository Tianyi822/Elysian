import type { LucideIcon } from 'lucide-react'

/**
 * 图标唯一出口。界面不直接依赖图标库，只认这个模块——
 * 引入自定义图标集时改本文件即可：按 IconComponent 的形状提供组件，消费方一行都不用动。
 * 未列出的图标要用时在这里加一行转出，让「界面上出现过哪些图标」在一处可查。
 */
export type IconComponent = LucideIcon

export {
  Bot,
  CircleCheck,
  Container,
  Gauge,
  Inbox,
  Info,
  LayoutDashboard,
  Loader2,
  Lock,
  MemoryStick,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  RefreshCw,
  RotateCw,
  ScrollText,
  Search,
  Server,
  ShieldCheck,
  Siren,
  Square,
  Sun,
  Terminal,
  Timer,
  Trash2,
  TriangleAlert,
  Workflow,
  X,
  Zap,
} from 'lucide-react'
