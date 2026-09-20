import { useId, useMemo } from 'react'
import type { SshLoginKey } from '@elysian/contracts'
import { IconButton } from '../../components/IconButton'
import { formatDateTime } from '../../components/format'
import { KeyRound, Search, Trash2 } from '../../components/icons'
import { SSH_PAGE_SIZE, useSshStore } from '../../stores/sshStore'
import { ACTION_CLASS, CONTROL_HEIGHT_CLASS, Section, TablePager } from './sshCardParts'
import { filterSshKeys } from './sshKeySearch'

/**
 * SSH 密钥卡：搜索、创建入口与密钥表格。
 * 搜索按名称、指纹与归属账号匹配（判据见 sshKeySearch.ts）；私钥不在列表数据里，
 * 因此也不参与匹配——它只在创建后的一次性弹窗里出现过。
 * 表格只列名称、归属账号、创建时间与操作，公钥全文在行内的「查看密钥」弹窗里给。
 */
export function SshKeyCard() {
  const keys = useSshStore((s) => s.keys)
  const keyAccounts = useSshStore((s) => s.keyAccounts)
  const search = useSshStore((s) => s.keySearch)
  const page = useSshStore((s) => s.keyPage)
  const setKeySearch = useSshStore((s) => s.setKeySearch)
  const setKeyPage = useSshStore((s) => s.setKeyPage)
  const openCreateKey = useSshStore((s) => s.openCreateKey)
  const searchInputId = useId()

  // 归属账号名按 userId 现取：keyAccounts 是账号清单的家（mock 为账号数据集、Docker 为 getent），
  // 与创建弹窗的下拉同源，这里不存冗余字段。
  const ownerNameOf = useMemo(() => {
    const names = new Map(keyAccounts.map((account) => [account.id, account.name]))
    return (userId: string) => names.get(userId) ?? '账号已删除'
  }, [keyAccounts])

  const filtered = useMemo(
    () => filterSshKeys(search, keys, ownerNameOf),
    [search, keys, ownerNameOf],
  )

  // 删到最后一页空了就把页码收回有效范围，不额外写一份状态。
  const pageCount = Math.max(1, Math.ceil(filtered.length / SSH_PAGE_SIZE))
  const safePage = Math.min(page, pageCount)
  const pageRows = filtered.slice((safePage - 1) * SSH_PAGE_SIZE, safePage * SSH_PAGE_SIZE)

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
            placeholder="搜索名称、账号或指纹"
            className={`w-full ${CONTROL_HEIGHT_CLASS} rounded-lg border border-line bg-surface-raised pl-8 pr-3 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle`}
          />
        </div>
        <button type="button" onClick={() => openCreateKey()} className={ACTION_CLASS}>
          创建 SSH 密钥
        </button>
      </div>

      {/* 表格直接坐在卡面上：行悬停按交互词汇表向上步进一级表面，因此不再套一层浮起底。 */}
      <div className="grow min-w-0 overflow-x-auto">
        <table className="w-full table-fixed border-separate border-spacing-0 text-left text-sm">
          {/* 归属账号是这张表的分组线索（谁手里有哪把钥匙），因此紧跟在名称之后。
              操作列定宽，只占两枚按钮的宽度；名称列钉住，窄屏下它始终在视线里。 */}
          <colgroup>
            <col className="w-[30%]" />
            <col className="w-[24%]" />
            <col className="w-[32%]" />
            <col className="w-14" />
          </colgroup>
          <thead>
            <tr>
              {['名称', '归属账号', '创建时间', '操作'].map((label, index) => (
                <th
                  key={label}
                  scope="col"
                  className={`border-b border-line pb-2 text-xs font-medium text-fg-muted ${
                    index === 0 ? 'sticky left-0 z-20 border-r bg-surface' : 'pl-3'
                  }`}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={4} className="border-b border-line py-8 text-center text-sm text-fg-muted">
                  {keys.length === 0
                    ? '还没有密钥，点右上角「创建 SSH 密钥」新建一把'
                    : '没有匹配的密钥，换个关键词试试'}
                </td>
              </tr>
            ) : (
              pageRows.map((key) => (
                <KeyRow key={key.id} sshKey={key} ownerName={ownerNameOf(key.userId)} />
              ))
            )}
          </tbody>
        </table>
      </div>

      <TablePager
        label="密钥分页"
        summary={
          search.trim() ? `匹配 ${filtered.length} 把 · 共 ${keys.length} 把` : `共 ${keys.length} 把密钥`
        }
        page={safePage}
        pageCount={pageCount}
        pageSize={SSH_PAGE_SIZE}
        onPageChange={setKeyPage}
      />
    </Section>
  )
}

function KeyRow({ sshKey, ownerName }: { sshKey: SshLoginKey; ownerName: string }) {
  const openKeyView = useSshStore((s) => s.openKeyView)
  const openRemoveKey = useSshStore((s) => s.openRemoveKey)

  return (
    <tr className="group transition-colors hover:bg-surface-raised">
      {/* 名称超长截断显示：完整名称在悬停提示里，密钥全文在「查看密钥」弹窗里。
          名称列钉在左边并带不透明底，窄屏横向滚动时后面的列不会从它下面透出来。 */}
      <td className="sticky left-0 z-10 whitespace-nowrap border-b border-r border-line bg-surface py-2.5 pr-3 group-hover:bg-surface-raised">
        <span className="block truncate text-fg" title={sshKey.name}>
          {sshKey.name}
        </span>
      </td>
      <td className="border-b border-line py-2.5 pl-3 text-fg-muted">
        <span className="block truncate" title={ownerName}>
          {ownerName}
        </span>
      </td>
      <td className="border-b border-line py-2.5 pl-3 tabular-nums text-fg-muted">
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
