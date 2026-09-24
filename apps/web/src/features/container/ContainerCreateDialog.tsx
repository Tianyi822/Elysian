import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useState } from 'react'
import { RESTART_POLICIES, RESTART_POLICY_LABELS } from '@elysian/contracts'
import { ChevronDown, Loader2, Plus, Trash2, X } from '../../components/icons'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { useContainersStore } from '../../stores/containersStore'
import {
  emptyDraft,
  hasCreateErrors,
  toCreateInput,
  validateCreateDraft,
} from './containerCreateForm'
import type { ContainerCreateDraft, PortDraftRow } from './containerCreateForm'

/**
 * 创建容器弹窗（仿 Docker Desktop 的 Run a new container）：必填区只有镜像与名称，
 * 其余配置收进「可选设置」折叠区。提交不绑定 form 的回车提交（避开输入法组合回车），
 * 只走按钮点击。
 */

const INPUT_CLASS =
  'w-full rounded-lg border border-line bg-surface-raised px-2.5 py-1.5 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle'
const FIELD_ERROR_CLASS = 'mt-1 text-xs text-danger'
const ROW_DELETE_BUTTON =
  'inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-fg-muted transition-colors hover:text-danger'
const ROW_ADD_BUTTON =
  'inline-flex items-center gap-1 rounded-lg border border-dashed border-line px-2 py-1 text-xs text-fg-muted transition-colors hover:text-fg'

export function ContainerCreateDialog() {
  const gateway = useGateway()
  const open = useContainersStore((s) => s.createOpen)
  const creating = useContainersStore((s) => s.creating)
  const containers = useContainersStore((s) => s.containers)
  const images = useContainersStore((s) => s.images)
  const closeCreate = useContainersStore((s) => s.closeCreate)
  const createContainer = useContainersStore((s) => s.createContainer)

  const [draft, setDraft] = useState<ContainerCreateDraft>(emptyDraft)
  const [optionalOpen, setOptionalOpen] = useState(false)
  const [showErrors, setShowErrors] = useState(false)
  const [volumeHostPlaceholder, setVolumeHostPlaceholder] = useState('/srv/data')

  const docker = isDockerRuntime()

  useEffect(() => {
    if (open) {
      setDraft(emptyDraft())
      setOptionalOpen(false)
      setShowErrors(false)
      void gateway.containers
        .createPolicy()
        .then((policy) => setVolumeHostPlaceholder(`${policy.mountRoot}/data`))
        .catch(() => setVolumeHostPlaceholder('/srv/data'))
    }
  }, [open, gateway])

  if (!open) return null

  const errors = validateCreateDraft(draft, containers)
  // 首次提交前不禁用：点提交要能揭示行内错误；提交后仍有错或提交中才禁用。
  const disabled = creating || (showErrors && hasCreateErrors(errors))

  const patch = (part: Partial<ContainerCreateDraft>) => setDraft((d) => ({ ...d, ...part }))
  const updatePorts = (index: number, part: Partial<PortDraftRow>) =>
    patch({ ports: draft.ports.map((row, i) => (i === index ? { ...row, ...part } : row)) })

  const submit = () => {
    setShowErrors(true)
    if (hasCreateErrors(errors)) return
    void createContainer(gateway, toCreateInput(draft))
  }

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) closeCreate() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          // 点外部一律不关：填好的配置不该因为一次误点丢掉。Esc 与「关闭」「取消」仍可退出。
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[55] flex max-h-[min(40rem,calc(100vh-3rem))] w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-bg shadow-2xl"
        >
          <Dialog.Title className="sr-only">创建容器</Dialog.Title>
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
            <div className="flex items-center gap-2 text-xs">
              {docker ? null : (
                <span className="rounded bg-warning/15 px-1.5 py-0.5 font-medium text-warning">
                  演示 · 待接入真实执行
                </span>
              )}
              <span className="text-sm font-medium text-fg">创建容器</span>
            </div>
            <button
              type="button"
              onClick={closeCreate}
              aria-label="关闭弹窗"
              className="inline-flex size-7 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
            >
              <X aria-hidden size={15} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                {/* 星号在 label 外：label 文本保持「镜像」，供按标签查询与读屏精确匹配。 */}
                <div className="mb-1 flex items-center gap-1 text-xs font-medium text-fg-muted">
                  <label htmlFor="create-image">镜像</label>
                  <span className="text-danger">*</span>
                </div>
                <select
                  id="create-image"
                  value={draft.imageId}
                  onChange={(event) => patch({ imageId: event.target.value })}
                  className={INPUT_CLASS}
                >
                  <option value="">选择镜像</option>
                  {images.map((image) => (
                    <option key={image.id} value={image.id}>
                      {image.name}:{image.tag}
                    </option>
                  ))}
                </select>
                {showErrors && errors.imageId ? (
                  <p className={FIELD_ERROR_CLASS} id="create-image-error">{errors.imageId}</p>
                ) : null}
              </div>
              <div>
                <label htmlFor="create-name" className="mb-1 block text-xs font-medium text-fg-muted">
                  容器名称
                </label>
                <input
                  id="create-name"
                  value={draft.name}
                  onChange={(event) => patch({ name: event.target.value })}
                  placeholder="留空按镜像名自动生成"
                  autoComplete="off"
                  aria-describedby={showErrors && errors.name ? 'create-name-error' : undefined}
                  className={INPUT_CLASS}
                />
                {showErrors && errors.name ? (
                  <p className={FIELD_ERROR_CLASS} id="create-name-error">{errors.name}</p>
                ) : null}
              </div>
            </div>

            <button
              type="button"
              aria-expanded={optionalOpen}
              aria-controls="create-optional"
              onClick={() => setOptionalOpen((v) => !v)}
              className="mt-4 flex w-full items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-xs font-medium text-fg-muted transition-colors hover:text-fg"
            >
              <ChevronDown
                aria-hidden
                size={14}
                className={`transition-transform ${optionalOpen ? 'rotate-180' : ''}`}
              />
              可选设置（端口、环境变量、卷、命令、重启策略）
            </button>

            {optionalOpen ? (
              <div id="create-optional" className="mt-3 space-y-4">
                <section aria-label="端口映射" className="rounded-lg bg-surface p-3">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-medium text-fg">端口映射</h3>
                    <button
                      type="button"
                      onClick={() =>
                        patch({
                          ports: [
                            ...draft.ports,
                            { containerPort: '', hostPort: '', protocol: 'tcp', public: false },
                          ],
                        })
                      }
                      className={ROW_ADD_BUTTON}
                    >
                      <Plus aria-hidden size={13} />
                      添加端口映射
                    </button>
                  </div>
                  {draft.ports.length ? (
                    <div className="mt-2 space-y-2">
                      {draft.ports.map((row, index) => (
                        <div key={index} className="flex flex-wrap items-end gap-2">
                          <div className="w-28">
                            <label htmlFor={`create-port-container-${index}`} className="mb-1 block text-xs text-fg-muted">
                              容器端口
                            </label>
                            <input
                              id={`create-port-container-${index}`}
                              inputMode="numeric"
                              value={row.containerPort}
                              onChange={(event) => updatePorts(index, { containerPort: event.target.value })}
                              className={`${INPUT_CLASS} tabular-nums`}
                            />
                          </div>
                          <div className="w-28">
                            <label htmlFor={`create-port-host-${index}`} className="mb-1 block text-xs text-fg-muted">
                              宿主端口
                            </label>
                            <input
                              id={`create-port-host-${index}`}
                              inputMode="numeric"
                              value={row.hostPort}
                              onChange={(event) => updatePorts(index, { hostPort: event.target.value })}
                              className={`${INPUT_CLASS} tabular-nums`}
                            />
                          </div>
                          <div className="w-24">
                            <label htmlFor={`create-port-protocol-${index}`} className="mb-1 block text-xs text-fg-muted">
                              协议
                            </label>
                            <select
                              id={`create-port-protocol-${index}`}
                              value={row.protocol}
                              onChange={(event) =>
                                updatePorts(index, { protocol: event.target.value as 'tcp' | 'udp' })
                              }
                              className={INPUT_CLASS}
                            >
                              <option value="tcp">tcp</option>
                              <option value="udp">udp</option>
                            </select>
                          </div>
                          <div className="flex min-w-36 flex-col justify-end pb-1.5">
                            <label
                              htmlFor={`create-port-public-${index}`}
                              className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-fg-muted"
                            >
                              <input
                                id={`create-port-public-${index}`}
                                type="checkbox"
                                checked={row.public}
                                onChange={(event) => updatePorts(index, { public: event.target.checked })}
                                className="size-3.5 rounded border border-line"
                              />
                              对外开放
                            </label>
                            {row.public ? (
                              <p className="mt-1 text-xs text-warning">该端口不受防火墙规则约束</p>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            onClick={() => patch({ ports: draft.ports.filter((_, i) => i !== index) })}
                            className={ROW_DELETE_BUTTON}
                          >
                            <Trash2 aria-hidden size={13} />
                            删除
                          </button>
                          {showErrors && errors.ports[index] ? (
                            <p className={`${FIELD_ERROR_CLASS} w-full`}>
                              {[errors.ports[index]!.containerPort, errors.ports[index]!.hostPort]
                                .filter(Boolean)
                                .join('；')}
                            </p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-1.5 text-xs text-fg-subtle">
                      不添加映射时，容器端口只在容器网络内可达。
                    </p>
                  )}
                </section>

                <section aria-label="环境变量" className="rounded-lg bg-surface p-3">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-medium text-fg">环境变量</h3>
                    <button
                      type="button"
                      onClick={() => patch({ env: [...draft.env, { key: '', value: '' }] })}
                      className={ROW_ADD_BUTTON}
                    >
                      <Plus aria-hidden size={13} />
                      添加环境变量
                    </button>
                  </div>
                  {draft.env.length ? (
                    <div className="mt-2 space-y-2">
                      {draft.env.map((row, index) => (
                        <div key={index} className="flex flex-wrap items-end gap-2">
                          <div className="w-40">
                            <label htmlFor={`create-env-key-${index}`} className="mb-1 block text-xs text-fg-muted">
                              变量名
                            </label>
                            <input
                              id={`create-env-key-${index}`}
                              value={row.key}
                              onChange={(event) =>
                                patch({ env: draft.env.map((r, i) => (i === index ? { ...r, key: event.target.value } : r)) })
                              }
                              autoComplete="off"
                              className={INPUT_CLASS}
                            />
                          </div>
                          <div className="flex-1 min-w-40">
                            <label htmlFor={`create-env-value-${index}`} className="mb-1 block text-xs text-fg-muted">
                              值
                            </label>
                            <input
                              id={`create-env-value-${index}`}
                              value={row.value}
                              onChange={(event) =>
                                patch({ env: draft.env.map((r, i) => (i === index ? { ...r, value: event.target.value } : r)) })
                              }
                              autoComplete="off"
                              className={INPUT_CLASS}
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() => patch({ env: draft.env.filter((_, i) => i !== index) })}
                            className={ROW_DELETE_BUTTON}
                          >
                            <Trash2 aria-hidden size={13} />
                            删除
                          </button>
                          {showErrors && errors.env[index]?.key ? (
                            <p className={`${FIELD_ERROR_CLASS} w-full`}>{errors.env[index]!.key}</p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-1.5 text-xs text-fg-subtle">不注入额外环境变量，沿用镜像自带取值。</p>
                  )}
                </section>

                <section aria-label="卷挂载" className="rounded-lg bg-surface p-3">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-medium text-fg">卷挂载</h3>
                    <button
                      type="button"
                      onClick={() => patch({ volumes: [...draft.volumes, { hostPath: '', containerPath: '' }] })}
                      className={ROW_ADD_BUTTON}
                    >
                      <Plus aria-hidden size={13} />
                      添加卷挂载
                    </button>
                  </div>
                  {draft.volumes.length ? (
                    <div className="mt-2 space-y-2">
                      {draft.volumes.map((row, index) => (
                        <div key={index} className="flex flex-wrap items-end gap-2">
                          <div className="flex-1 min-w-48">
                            <label htmlFor={`create-volume-host-${index}`} className="mb-1 block text-xs text-fg-muted">
                              宿主机路径
                            </label>
                            <input
                              id={`create-volume-host-${index}`}
                              value={row.hostPath}
                              onChange={(event) =>
                                patch({
                                  volumes: draft.volumes.map((r, i) =>
                                    i === index ? { ...r, hostPath: event.target.value } : r,
                                  ),
                                })
                              }
                              placeholder={volumeHostPlaceholder}
                              autoComplete="off"
                              className={INPUT_CLASS}
                            />
                          </div>
                          <div className="flex-1 min-w-48">
                            <label htmlFor={`create-volume-container-${index}`} className="mb-1 block text-xs text-fg-muted">
                              容器路径
                            </label>
                            <input
                              id={`create-volume-container-${index}`}
                              value={row.containerPath}
                              onChange={(event) =>
                                patch({
                                  volumes: draft.volumes.map((r, i) =>
                                    i === index ? { ...r, containerPath: event.target.value } : r,
                                  ),
                                })
                              }
                              placeholder="/data"
                              autoComplete="off"
                              className={INPUT_CLASS}
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() => patch({ volumes: draft.volumes.filter((_, i) => i !== index) })}
                            className={ROW_DELETE_BUTTON}
                          >
                            <Trash2 aria-hidden size={13} />
                            删除
                          </button>
                          {showErrors && errors.volumes[index] ? (
                            <p className={`${FIELD_ERROR_CLASS} w-full`}>
                              {[errors.volumes[index]!.hostPath, errors.volumes[index]!.containerPath]
                                .filter(Boolean)
                                .join('；')}
                            </p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-1.5 text-xs text-fg-subtle">不挂载宿主机目录，数据随容器一起消失。</p>
                  )}
                </section>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="create-command" className="mb-1 block text-xs font-medium text-fg-muted">
                      启动命令
                    </label>
                    <input
                      id="create-command"
                      value={draft.command}
                      onChange={(event) => patch({ command: event.target.value })}
                      placeholder="例如 redis-server --appendonly yes"
                      autoComplete="off"
                      spellCheck={false}
                      aria-describedby={showErrors && errors.command ? 'create-command-error' : undefined}
                      className={`${INPUT_CLASS} font-mono`}
                    />
                    {showErrors && errors.command ? (
                      <p className={FIELD_ERROR_CLASS} id="create-command-error">{errors.command}</p>
                    ) : null}
                  </div>
                  <div>
                    <label htmlFor="create-restart" className="mb-1 block text-xs font-medium text-fg-muted">
                      重启策略
                    </label>
                    <select
                      id="create-restart"
                      value={draft.restartPolicy}
                      onChange={(event) =>
                        patch({ restartPolicy: event.target.value as ContainerCreateDraft['restartPolicy'] })
                      }
                      className={INPUT_CLASS}
                    >
                      {RESTART_POLICIES.map((policy) => (
                        <option key={policy} value={policy}>
                          {RESTART_POLICY_LABELS[policy]}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3">
            <p className="text-xs text-fg-subtle">
              {docker ? '创建后立即启动。' : '创建后立即运行；所有数据仅存在于演示内存。'}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={closeCreate}
                className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
              >
                取消
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={disabled}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50"
              >
                {creating ? <Loader2 aria-hidden size={13} className="animate-spin" /> : null}
                {creating ? '创建中…' : '创建并运行'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
