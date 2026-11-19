import { useId, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { evaluateSshPasswordStrength, type SshRootLoginPolicy } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { Button } from '../../components/Button'
import { formatDateTime } from '../../components/format'
import { IconButton } from '../../components/IconButton'
import { RefreshCw } from '../../components/icons'
import { PasswordVisibilityButton } from '../../components/PasswordVisibilityButton'
import { useSshStore } from '../../stores/sshStore'
import { isDockerRuntime } from '../../utils/isDockerRuntime'
import { PasswordStrengthBar, passwordInputClass } from './passwordFieldParts'
import { ACTION_CLASS, Region, SECONDARY_ACTION_CLASS, Section, SwitchRow } from './sshCardParts'
import { randomStrongPassword } from './sshRandom'
import { SshRefreshButton, SshRefreshError } from './SshRefresh'

/**
 * Root 登录的收起提示：按策略与全局登录方式组合出原因。
 * 面板只写 yes/no 两档；prohibit-password 与 forced-commands-only 是外部配置（含演示种子）才有的值，
 * 读到时如实解释，重新开关一次「允许 Root 登录」即回到面板可写的两档。
 */
function rootHiddenHints(
  policy: SshRootLoginPolicy,
  settings: { passwordAuthEnabled: boolean; keyAuthEnabled: boolean },
): string[] {
  if (policy === 'no') return ['Root 登录已禁止：Root 密码与 Root 密钥设置已隐藏。']
  const hints: string[] = []
  if (policy === 'forced-commands-only') {
    hints.push(
      '仅允许指定命令：Root 只能用授权文件中带 command= 限制的密钥执行固定命令（常用于备份脚本等自动化场景）；面板生成的普通密钥无法用于此配置，密码与密钥设置已隐藏。',
    )
  }
  if (policy === 'prohibit-password') {
    hints.push(
      settings.passwordAuthEnabled
        ? '当前配置仅允许 Root 以密钥登录：Root 密码设置已隐藏。'
        : '当前配置仅允许 Root 以密钥登录：Root 密码设置已隐藏。重新开关一次「允许 Root 登录」可按全局登录方式重设。',
    )
  }
  if (!settings.keyAuthEnabled) hints.push('全局密钥登录已关闭：Root 密钥设置已隐藏。')
  if (policy === 'yes' && !settings.passwordAuthEnabled) {
    hints.push('全局密码登录已关闭：Root 密码设置已隐藏。')
  }
  return hints
}

/** Root 设置卡：Root 登录开关、Root 密码、Root 密钥三个区域；登录方式由全局开关唯一决定。 */
export function SshRootCard() {
  const gateway = useGateway()
  const rootAuth = useSshStore((s) => s.rootAuth)
  const settings = useSshStore((s) => s.settings)
  const passwordDraft = useSshStore((s) => s.passwordDraft)
  const resetting = useSshStore((s) => s.resettingPassword)
  const savingPolicy = useSshStore((s) => s.savingPolicy)
  const generatingRootKey = useSshStore((s) => s.generatingRootKey)
  const setLoginPolicy = useSshStore((s) => s.setLoginPolicy)
  const setPasswordDraft = useSshStore((s) => s.setPasswordDraft)
  const resetPassword = useSshStore((s) => s.resetPassword)
  const createRootKey = useSshStore((s) => s.createRootKey)
  const openKeyView = useSshStore((s) => s.openKeyView)
  const passwordInputId = useId()
  const [passwordVisible, setPasswordVisible] = useState(false)

  if (!rootAuth || !settings) return null
  // 空输入不设密码强度，保留默认的焦点样式。
  const strength = passwordDraft ? evaluateSshPasswordStrength(passwordDraft) : undefined
  const rootKey = rootAuth.key
  // 密码区要策略为 yes 且全局密码登录开；密钥区要非禁止档且全局密钥登录开——
  // 登录方式唯一由 SSH 服务卡的全局开关决定，这里只决定 root 这个账号可不可登。
  const rootAllowed = rootAuth.policy !== 'no'
  const passwordUsable = rootAuth.policy === 'yes' && settings.passwordAuthEnabled
  const panelKeyUsable =
    rootAuth.policy !== 'no' && rootAuth.policy !== 'forced-commands-only' && settings.keyAuthEnabled
  const hiddenHints = rootHiddenHints(rootAuth.policy, settings)

  return (
    <Section title="Root 设置" aside={<SshRefreshButton section="root" />}>
      <SshRefreshError section="root" />
      <Region title="Root 登录">
        <SwitchRow
          label="允许 Root 登录"
          checked={rootAllowed}
          disabled={savingPolicy}
          onCheckedChange={(checked) => void setLoginPolicy(gateway, checked ? 'yes' : 'no')}
        />
        <p className="mt-3 text-xs text-fg-subtle">推荐使用密钥登录并关闭密码登录，安全性更高。</p>
        {hiddenHints.map((hint) => (
          <p key={hint} className="mt-1.5 text-xs text-fg-subtle">
            {hint}
          </p>
        ))}
        {/* 外部档 prohibit-password 且全局密码已开：重设只差一步，按钮直接到位，
            不再要求用户「先关再开」开关仪式。 */}
        {rootAuth.policy === 'prohibit-password' && settings.passwordAuthEnabled ? (
          <Button variant="outline"
            type="button"
            onClick={() => void setLoginPolicy(gateway, 'yes')}
            disabled={savingPolicy}
            className={`${SECONDARY_ACTION_CLASS} mt-3`}
          >
            按全局登录方式重设
          </Button>
        ) : null}
      </Region>
      {passwordUsable ? (
        <Region
          title="Root 密码"
          labelFor={passwordInputId}
          aside={
            <p className="shrink-0 text-xs tabular-nums text-fg-subtle">
              上次重置：{rootAuth.passwordResetAt ? formatDateTime(rootAuth.passwordResetAt) : '—'}
            </p>
          }
        >
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <input
                id={passwordInputId}
                type={passwordVisible ? 'text' : 'password'}
                autoComplete="new-password"
                value={passwordDraft}
                onChange={(event) => setPasswordDraft(event.target.value)}
                placeholder="请输入新密码"
                className={passwordInputClass(strength)}
              />
              <PasswordVisibilityButton
                visible={passwordVisible}
                onToggle={setPasswordVisible}
              />
            </div>
            <IconButton
              label="随机生成强密码"
              formControl
              onPress={() => setPasswordDraft(randomStrongPassword())}
            >
              <RefreshCw aria-hidden size={14} />
            </IconButton>
            <Button variant="primary"
              type="button"
              onClick={() => void resetPassword(gateway)}
              disabled={resetting}
              className={ACTION_CLASS}
            >
              重置密码
            </Button>
          </div>
          {strength ? (
            /* 强度内联在输入框正下：三段彩条（红黄绿逐段点亮）+ 条旁等级字，不单独占一行说明。 */
            <div className="mt-2">
              <PasswordStrengthBar strength={strength} />
            </div>
          ) : null}
          <p className="mt-2 text-xs text-fg-subtle">
            建议使用复杂度高的密码；修改后请及时保存，刷新页面会清空密码框。
          </p>
        </Region>
      ) : null}

      {panelKeyUsable ? (
        <Region title="Root 密钥">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex items-center gap-2">
            {/* 生成/重新生成同一动作：已存在时按一次，新公钥替换旧公钥，私钥只在随后的弹窗里出现一次。 */}
            <Button variant="primary"
              type="button"
              onClick={() => void createRootKey(gateway)}
              disabled={generatingRootKey}
              className={ACTION_CLASS}
            >
              {rootKey ? '重新生成' : '生成密钥'}
            </Button>
            {rootKey ? (
              <Button variant="outline"
                type="button"
                onClick={() => openKeyView('查看 Root 密钥', rootKey)}
                className={SECONDARY_ACTION_CLASS}
              >
                查看密钥
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-fg-subtle">
            {isDockerRuntime()
              ? '重新生成会替换 root 授权文件首行的公钥，旧私钥随之作废。'
              : '演示密钥 · 不对应任何真实主机'}
          </p>
        </div>
        {/* 密钥的元数据与公钥按标签取值两列排：公钥单行很长，卡内截断、全文在弹窗里给。 */}
        {rootKey ? (
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
            <dt className="text-fg-muted">算法</dt>
            <dd className="truncate text-fg">{rootKey.algorithm}</dd>
            <dt className="text-fg-muted">指纹</dt>
            <dd className="truncate font-mono text-fg" title={rootKey.fingerprint}>
              {rootKey.fingerprint}
            </dd>
            <dt className="text-fg-muted">生成于</dt>
            <dd className="tabular-nums text-fg">{formatDateTime(rootKey.createdAt)}</dd>
            <dt className="text-fg-muted">公钥</dt>
            <dd className="truncate font-mono text-fg" title={rootKey.publicKey}>
              {rootKey.publicKey}
            </dd>
          </dl>
        ) : (
          /* root 的 authorized_keys 为空：如实呈现尚未生成，不编造密钥材料。 */
          <p className="mt-3 text-xs text-fg-subtle">尚未生成：root 账号的授权文件里还没有任何公钥。</p>
        )}
        <p className="mt-2 text-xs text-fg-subtle">
          生成后私钥只在弹窗里展示这一次，请当场下载保存。
        </p>
      </Region>
      ) : null}
    </Section>
  )
}

/**
 * Root 密码重置成功的提醒弹窗：改密影响的是下一次 SSH 登录，值得比一条通知更强的停顿，
 * 用户确认「知道了」后关闭。
 */
export function PasswordResetNoticeDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[55] w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 panel-surface p-4 shadow-2xl"
        >
          <Dialog.Title className="text-sm font-medium text-fg">Root 密码已重置</Dialog.Title>
          <p className="mt-2 text-xs text-fg-muted">下一次 SSH 登录需要使用新密码。</p>
          <div className="mt-4 flex justify-end">
            <Button variant="primary" type="button" onClick={onClose} className={ACTION_CLASS}>
              知道了
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
