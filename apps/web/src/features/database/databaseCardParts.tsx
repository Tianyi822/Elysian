import type { ReactNode } from 'react'
import type { DatabaseEngine } from '@elysian/contracts'
import { Database, MariaDBLogo, MySQLLogo } from '../../components/icons'

/** 引擎标：MariaDB 与 MySQL 有官方 Logo，其余引擎（Redis、SQLite 等）回退通用数据库图标加中性配色。 */
export function DatabaseMark({ engine }: { engine: DatabaseEngine }) {
  const mark =
    engine === 'MariaDB'
      ? {
          logo: <MariaDBLogo aria-hidden size={23} />,
          frame: 'border-warning/40 bg-warning/10 text-warning',
        }
      : engine === 'MySQL'
        ? {
            logo: <MySQLLogo aria-hidden size={23} />,
            frame: 'border-info/40 bg-info/10 text-info',
          }
        : {
            logo: <Database aria-hidden size={18} />,
            frame: 'border-control-line bg-surface-raised text-fg-muted',
          }

  return (
    <span
      aria-label={`${engine} 图标`}
      className={`inline-flex size-10 shrink-0 items-center justify-center rounded-lg border text-xs font-bold ${mark.frame}`}
    >
      {mark.logo}
    </span>
  )
}

/** 静态指标格：数据库事实只有当前值、没有配额，因此不画占比条。 */
export function FileStat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface-raised px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs text-fg-subtle">
        {icon}
        <span>{label}</span>
      </div>
      <p className="mt-1 text-sm font-medium tabular-nums text-fg">{value}</p>
    </div>
  )
}
