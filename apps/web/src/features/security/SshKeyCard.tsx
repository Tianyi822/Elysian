import { useId, useMemo } from 'react'
import type { SshLoginKey } from '@elysian/contracts'
import { IconButton } from '../../components/IconButton'
import { formatDateTime } from '../../components/format'
import { KeyRound, Search, Trash2 } from '../../components/icons'
import { useSshStore } from '../../stores/sshStore'
import { ACTION_CLASS, CONTROL_HEIGHT_CLASS, Section } from './sshCardParts'
import { filterSshKeys } from './sshKeySearch'

/**
 * SSH 密钥卡：搜索、创建入口与密钥表格。
 * 搜索按名称、指纹与私钥内容匹配（判据见 sshKeySearch.ts），粘一整份私钥能准确定位到那一行。
 * 表格只列名称、创建时间与操作，密钥材料在行内的「查看密钥」弹窗里给。
 */
export function SshKeyCard() {
  const keys = useSshStore((s) => s.keys)
  const search = useSshStore((s) => s.keySearch)
  const setKeySearch = useSshStore((s) => s.setKeySearch)
  const openCreateKey = useSshStore((s) => s.openCreateKey)
  const searchInputId = useId()
  const filtered = useMemo(() => filterSshKeys(search, keys), [search, keys])

  return (
    <Section title="SSH 密钥">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
          />
          <label htmlFor={searchInputId} className="sr-only">
            搜索密钥
          </label>
          <input
            id={searchInputId}
            value={search}
            onChange={(event) => setKeySearch(event.target.value)}
            placeholder="搜索名称、指纹或私钥"
            className={`w-full ${CONTROL_HEIGHT_CLASS} rounded-lg border border-line bg-surface-raised pl-8 pr-3 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle`}
          />
        </div>
        <button type="button" onClick={() => openCreateKey()} className={ACTION_CLASS}>
          创建 SSH 密钥
        </button>
      </div>

      {/* 表格直接坐在卡面上：行悬停按交互词汇表向上步进一级表面，因此不再套一层浮起底。 */}
      <div className="grow overflow-x-auto">
        <table className="w-full table-fixed border-separate border-spacing-0 text-left text-sm">
          {/* 操作列只占两枚按钮的宽度（2×24px 加间距），名称与创建时间平分剩下的空间——
              固定布局下不写宽度的列平均分摊余量，因此两列天然等宽。
              操作列不写宽度会跟着一起膨胀，两枚按钮被推到远端，表头也没法跟它们对齐。 */}
          <colgroup>
            <col />
            <col />
            <col className="w-14" />
          </colgroup>
          <thead>
            <tr>
              {['名称', '创建时间', '操作'].map((label) => (
                <th
                  key={label}
                  scope="col"
                  className="border-b border-line pb-2 text-xs font-medium text-fg-muted"
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={3} className="border-b border-line py-8 text-center text-sm text-fg-muted">
                  {keys.length === 0
                    ? '还没有密钥，点右上角「创建 SSH 密钥」新建一把'
                    : '没有匹配的密钥，换个关键词或粘一整份私钥试试'}
                </td>
              </tr>
            ) : (
              filtered.map((key) => <KeyRow key={key.id} sshKey={key} />)
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs tabular-nums text-fg-muted">
        {search.trim()
          ? `匹配 ${filtered.length} 把 · 共 ${keys.length} 把`
          : `共 ${keys.length} 把密钥`}
      </p>
    </Section>
  )
}

function KeyRow({ sshKey }: { sshKey: SshLoginKey }) {
  const openKeyView = useSshStore((s) => s.openKeyView)
  const openRemoveKey = useSshStore((s) => s.openRemoveKey)

  return (
    <tr className="transition-colors hover:bg-surface-raised">
      {/* 名称超长截断显示：完整名称在悬停提示里，密钥全文在「查看密钥」弹窗里。 */}
      <td className="border-b border-line py-2.5 pr-3">
        <span className="block truncate text-fg" title={sshKey.name}>
          {sshKey.name}
        </span>
      </td>
      <td className="border-b border-line py-2.5 tabular-nums text-fg-muted">
        {formatDateTime(sshKey.createdAt)}
      </td>
      <td className="border-b border-line py-2.5">
        {/* 按钮左对齐：与「操作」表头共用同一条左边界，列宽就是两枚按钮的宽度。 */}
        <div className="flex items-center justify-start gap-1">
          {/* 按钮名带上密钥名：一列多行时读屏与查询都能分辨是哪一把。 */}
          <IconButton
            label={`查看密钥 ${sshKey.name}`}
            variant="ghost"
            onPress={() => openKeyView(`查看密钥 · ${sshKey.name}`, sshKey)}
          >
            <KeyRound aria-hidden size={14} />
          </IconButton>
          <IconButton
            label={`删除 ${sshKey.name}`}
            variant="ghost"
            tone="danger-hover"
            onPress={() => openRemoveKey(sshKey)}
          >
            <Trash2 aria-hidden size={14} />
          </IconButton>
        </div>
      </td>
    </tr>
  )
}
