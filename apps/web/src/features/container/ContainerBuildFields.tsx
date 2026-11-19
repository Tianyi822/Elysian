import { ChipGroup } from '../../components/ChipGroup'
import { CTL_FIELD } from '../../components/formControl'
import { SelectDropdown } from '../../components/SelectDropdown'
import { SuggestionInput } from '../../components/SuggestionInput'
import { formatWorkspaceSize } from './formatWorkspaceSize'
import { CONTEXT_LIMIT_WARNING, type useContainerBuildForm } from './useContainerBuildForm'

export function ContainerBuildFields({
  slug, mode, switchMode, target, changeTarget, dockerfile, changeDockerfile, textPaths, context, changeContext,
  compose, changeCompose, composeFiles, selectedServices, toggleService, plan, previewError, submitError,
}: ReturnType<typeof useContainerBuildForm>['fields'] & { slug: string }) {
  return (
    <div className="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto pr-0.5">
      <ChipGroup ariaLabel="构建模式" value={mode} onSelect={switchMode}
        items={[{ value: 'dockerfile', label: 'Dockerfile 构建' }, { value: 'compose', label: 'compose 服务构建' }]} />

      {mode === 'dockerfile' ? (
        <div className="space-y-3">
          <div>
            <label htmlFor={`build-target-${slug}`} className="mb-1 block text-xs font-medium text-fg-muted">
              镜像目标名（产物仓库为 <span className="font-mono">elysian/{slug}/&lt;目标名&gt;</span>）
            </label>
            <input
              id={`build-target-${slug}`}
              value={target}
              onChange={(event) => changeTarget(event.target.value)}
              placeholder="app"
              autoComplete="off"
              spellCheck={false}
              className={`${CTL_FIELD} font-mono`}
            />
          </div>
          <div>
            <label htmlFor={`build-dockerfile-${slug}`} className="mb-1 block text-xs font-medium text-fg-muted">
              Dockerfile 路径（相对工作区根）
            </label>
            <SuggestionInput
              id={`build-dockerfile-${slug}`}
              ariaLabel="Dockerfile 路径（相对工作区根）"
              items={textPaths.map(path => ({ value: path, label: path }))}
              value={dockerfile}
              onValueChange={changeDockerfile}
              placeholder="Dockerfile"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </div>
          <div>
            <label htmlFor={`build-context-${slug}`} className="mb-1 block text-xs font-medium text-fg-muted">
              构建上下文（相对工作区根，默认 <span className="font-mono">.</span>）
            </label>
            <input
              id={`build-context-${slug}`}
              value={context}
              onChange={(event) => changeContext(event.target.value)}
              placeholder="."
              autoComplete="off"
              spellCheck={false}
              className={`${CTL_FIELD} font-mono`}
            />
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label htmlFor={`build-compose-${slug}`} className="mb-1 block text-xs font-medium text-fg-muted">
              compose 文件（相对工作区根）
            </label>
            <SelectDropdown
              id={`build-compose-${slug}`}
              ariaLabel="compose 文件（相对工作区根）"
              value={compose}
              onSelect={changeCompose}
              fullWidth
              mono
              items={composeFiles.map((path) => ({ value: path, label: path }))}
              fallbackLabel="工作区内没有 compose 文件"
              emptyLabel="工作区内没有 compose 文件"
              disabled={composeFiles.length === 0}
            />
          </div>
          {plan?.mode === 'compose' ? (
            <fieldset className="space-y-1.5">
              <legend className="text-xs font-medium text-fg-muted">选择要构建的服务</legend>
              {plan.services.map((service) => (
                <label
                  key={service.service}
                  className={`flex items-start gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs ${service.hasBuild ? 'cursor-pointer' : 'cursor-not-allowed opacity-70'}`}
                >
                  <input
                    type="checkbox"
                    checked={selectedServices.includes(service.service)}
                    disabled={!service.hasBuild}
                    onChange={(event) => toggleService(service.service, event.target.checked)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="font-mono">{service.service}</span>
                    {service.hasBuild ? (
                      <span className="mt-0.5 block break-all font-mono text-fg-subtle">
                        {service.imageRepository} · 上下文 {service.context}（{service.contextFiles} 个文件、{formatWorkspaceSize(service.contextBytes)}）
                      </span>
                    ) : (
                      <span className="mt-0.5 block font-mono text-fg-subtle">
                        无 build 段{service.imageNameInCompose ? `，镜像 ${service.imageNameInCompose}` : ''}
                      </span>
                    )}
                    {service.warnings.map((warning) => (
                      <span key={warning} className="mt-0.5 block text-warning">
                        {warning}
                      </span>
                    ))}
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}
        </div>
      )}

      {previewError ? (
        <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
          {previewError}
        </p>
      ) : null}
      {submitError ? (
        <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
          {submitError}
        </p>
      ) : null}

      {plan?.mode === 'dockerfile' ? (
        <div className="space-y-1.5 rounded-lg border border-line bg-surface px-2.5 py-2 text-xs">
          <p>
            上下文 <span className="font-mono">{plan.context}</span>：{plan.contextFiles} 个文件、{formatWorkspaceSize(plan.contextBytes)}
          </p>
          <p className="break-all">
            目标镜像仓库 <span className="font-mono">{plan.imageRepository}</span>
          </p>
          {plan.repositoryOccupied ? (
            <p className="text-danger">镜像 {plan.imageRepository} 已被非面板构建的镜像占用,构建将被拒绝。</p>
          ) : null}
          {plan.warnings.map((warning) => (
            <p key={warning} className={warning.includes(CONTEXT_LIMIT_WARNING) ? 'text-danger' : 'text-warning'}>
              {warning}
            </p>
          ))}
        </div>
      ) : null}
      {plan?.mode === 'compose' ? (
        <div className="space-y-1.5 rounded-lg border border-line bg-surface px-2.5 py-2 text-xs">
          {plan.warnings.map((warning) => (
            <p key={warning} className="text-warning">
              {warning}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}
