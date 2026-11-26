import { RESTART_POLICIES, RESTART_POLICY_LABELS } from '@elysian/contracts'
import { Button } from '../../components/Button'
import { FORM_CONTROL_HEIGHT_CLASS } from '../../components/formControl'
import { ChevronDown, Plus, Trash2 } from '../../components/icons'
import { SelectDropdown } from '../../components/SelectDropdown'
import { ToggleSwitch } from '../../components/ToggleSwitch'
import type { useContainerCreateForm } from './useContainerCreateForm'

const INPUT_CLASS =
  `${FORM_CONTROL_HEIGHT_CLASS} w-full rounded-lg border border-control-line bg-surface-raised px-2.5 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle`
const FIELD_ERROR_CLASS = 'mt-1 text-xs text-danger'
const ROW_DELETE_BUTTON =
  `inline-flex ${FORM_CONTROL_HEIGHT_CLASS} items-center gap-1 rounded-lg border border-line px-2 text-xs text-fg-muted transition-colors hover:text-danger`
const ROW_ADD_BUTTON =
  'action-button gap-1 border border-dashed border-line px-2 py-1 text-xs text-fg-muted transition-colors hover:text-fg'
const PROTOCOL_ITEMS = [
  { value: 'tcp', label: 'tcp' },
  { value: 'udp', label: 'udp' },
] as const

export function ContainerCreateFields({
  images, draft, optionalOpen, toggleOptional, showErrors, errors, volumeHostPlaceholder, patch, updatePorts,
}: NonNullable<ReturnType<typeof useContainerCreateForm>>['fields']) {
  return (
    <div className="flex-1 overflow-y-auto px-4 py-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          {/* 星号在 label 外：label 文本保持「镜像」，供按标签查询与读屏精确匹配。 */}
          <div className="mb-1 flex items-center gap-1 text-xs font-medium text-fg-muted">
            <label htmlFor="create-image">镜像</label>
            <span className="text-danger">*</span>
          </div>
          <SelectDropdown
            id="create-image"
            ariaLabel="镜像"
            fullWidth
            items={images.map((image) => ({
              value: image.id,
              label: `${image.name}:${image.tag}`,
            }))}
            value={draft.imageId || undefined}
            onSelect={(imageId) => patch({ imageId })}
            fallbackLabel="选择镜像"
            emptyLabel="没有可选镜像"
          />
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

      <Button variant="outline"
        type="button"
        aria-expanded={optionalOpen}
        aria-controls="create-optional"
        onClick={toggleOptional}
        className="mt-4 flex w-full items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-xs font-medium text-fg-muted transition-colors hover:text-fg"
      >
        <ChevronDown
          aria-hidden
          size={14}
          className={`transition-transform ${optionalOpen ? 'rotate-180' : ''}`}
        />
        可选设置（端口、环境变量、卷、命令、重启策略）
      </Button>

      {optionalOpen ? (
        <div id="create-optional" className="mt-3 space-y-4">
          <section aria-label="端口映射" className="rounded-lg bg-surface p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-medium text-fg">端口映射</h3>
              <Button variant="outline"
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
              </Button>
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
                      <SelectDropdown
                        id={`create-port-protocol-${index}`}
                        ariaLabel="协议"
                        fullWidth
                        items={PROTOCOL_ITEMS}
                        value={row.protocol}
                        onSelect={(protocol) => updatePorts(index, { protocol })}
                      />
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
                          onChange={(event) => updatePorts(index, { public: event.target.checked, allowFirewall: event.target.checked })}
                          className="size-3.5 rounded border border-line"
                        />
                        对外绑定
                      </label>
                      {row.public ? (
                        <label className="flex items-center gap-1.5 text-xs text-fg-muted">
                          <ToggleSwitch compact label={`创建后放行，端口映射 ${index + 1}`}
                            checked={row.allowFirewall === true}
                            onCheckedChange={allowFirewall => updatePorts(index, { allowFirewall })} />
                          创建后放行
                        </label>
                      ) : null}
                    </div>
                    <Button variant="destructive"
                      type="button"
                      onClick={() => patch({ ports: draft.ports.filter((_, i) => i !== index) })}
                      className={ROW_DELETE_BUTTON}
                    >
                      <Trash2 aria-hidden size={13} />
                      删除
                    </Button>
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
              <Button variant="outline"
                type="button"
                onClick={() => patch({ env: [...draft.env, { key: '', value: '' }] })}
                className={ROW_ADD_BUTTON}
              >
                <Plus aria-hidden size={13} />
                添加环境变量
              </Button>
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
                    <Button variant="destructive"
                      type="button"
                      onClick={() => patch({ env: draft.env.filter((_, i) => i !== index) })}
                      className={ROW_DELETE_BUTTON}
                    >
                      <Trash2 aria-hidden size={13} />
                      删除
                    </Button>
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
              <Button variant="outline"
                type="button"
                onClick={() => patch({ volumes: [...draft.volumes, { hostPath: '', containerPath: '' }] })}
                className={ROW_ADD_BUTTON}
              >
                <Plus aria-hidden size={13} />
                添加卷挂载
              </Button>
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
                    <Button variant="destructive"
                      type="button"
                      onClick={() => patch({ volumes: draft.volumes.filter((_, i) => i !== index) })}
                      className={ROW_DELETE_BUTTON}
                    >
                      <Trash2 aria-hidden size={13} />
                      删除
                    </Button>
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
              <SelectDropdown
                id="create-restart"
                ariaLabel="重启策略"
                fullWidth
                items={RESTART_POLICIES.map((policy) => ({
                  value: policy,
                  label: RESTART_POLICY_LABELS[policy],
                }))}
                value={draft.restartPolicy}
                onSelect={(restartPolicy) => patch({ restartPolicy })}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
