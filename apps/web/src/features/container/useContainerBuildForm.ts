import { useState } from 'react'
import type { ContainerApp, ContainerBuildSubmitInput } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { useFeedbackMessage } from '../../components/useFeedbackMessage'
import { isComposeFile, newBuildRequestId, useContainerAppsStore } from '../../stores/containerAppsStore'

/** 上下文超限的判定句：与契约警告逐字同源，前端据此在确认前禁用开始按钮。 */
export const CONTEXT_LIMIT_WARNING = '构建上下文超过上限'

export function useContainerBuildForm(app: ContainerApp, onClose: () => void) {
  const gateway = useGateway()
  const preview = useContainerAppsStore((s) => s.buildPreview)
  const previewBuild = useContainerAppsStore((s) => s.previewBuild)
  const submitBuild = useContainerAppsStore((s) => s.submitBuild)
  const clearBuildPreview = useContainerAppsStore((s) => s.clearBuildPreview)

  const textPaths = app.files.filter((file) => file.text).map((file) => file.path)
  const defaultDockerfile =
    textPaths.find((path) => path === 'Dockerfile') ??
    textPaths.find((path) => path.split('/').pop() === 'Dockerfile') ?? ''
  const composeFiles = app.files.filter((file) => isComposeFile(file.path)).map((file) => file.path)

  const [mode, setMode] = useState<'dockerfile' | 'compose'>(composeFiles.length > 0 && !defaultDockerfile ? 'compose' : 'dockerfile')
  const [target, setTarget] = useState('app')
  const [dockerfile, setDockerfile] = useState(defaultDockerfile)
  const [context, setContext] = useState('.')
  const [compose, setCompose] = useState(composeFiles[0] ?? '')
  const [selectedServices, setSelectedServices] = useState<readonly string[]>([])
  const [confirmOpen, setConfirmOpen] = useState(false)

  const state = preview?.slug === app.slug ? preview : null
  const plan = state?.plan ?? null
  const previewing = state?.status === 'loading'
  useFeedbackMessage(state?.submitError)

  const switchMode = (next: 'dockerfile' | 'compose') => {
    if (next === mode) return
    setMode(next)
    setSelectedServices([])
    clearBuildPreview()
  }

  const runPreview = () => {
    if (mode === 'dockerfile') {
      const trimmedTarget = target.trim()
      const trimmedContext = context.trim()
      void previewBuild(gateway, app.slug, {
        mode: 'dockerfile',
        ...(trimmedTarget ? { target: trimmedTarget } : {}),
        dockerfile,
        ...(trimmedContext ? { context: trimmedContext } : {}),
      })
      return
    }
    void previewBuild(gateway, app.slug, { mode: 'compose', compose }).then((result) => {
      if (result?.mode === 'compose') {
        // 默认勾选全部含 build 段的服务；用户可再逐个取消。
        setSelectedServices(result.services.filter((service) => service.hasBuild).map((service) => service.service))
      }
    })
  }

  // 超限上下文在确认前即禁用：打包阶段必失败，不让用户白走一遍确认。
  const limitWarnings =
    plan === null
      ? []
      : plan.mode === 'dockerfile'
        ? plan.warnings.filter((warning) => warning.includes(CONTEXT_LIMIT_WARNING))
        : [
            ...plan.warnings,
            ...plan.services.flatMap((service) => service.warnings),
          ].filter((warning) => warning.includes(CONTEXT_LIMIT_WARNING))
  const overLimit = limitWarnings.length > 0
  const previewReady = plan !== null && !overLimit
  const composeSelectionValid = mode === 'compose' && plan?.mode === 'compose'
    ? selectedServices.some((name) => plan.services.some((service) => service.service === name && service.hasBuild))
    : true
  const canStart = previewReady && (mode === 'dockerfile' || composeSelectionValid)

  const submitInput = (): ContainerBuildSubmitInput => {
    const requestId = newBuildRequestId()
    if (mode === 'dockerfile' && plan?.mode === 'dockerfile') {
      return { mode: 'dockerfile', requestId, target: plan.target, dockerfile: plan.dockerfile, context: plan.context }
    }
    if (plan?.mode === 'compose') {
      return { mode: 'compose', requestId, compose: plan.compose, services: selectedServices }
    }
    // 没有预览结果就点不到确认：这里只为类型收窄，不会发生。
    return { mode: 'dockerfile', requestId, dockerfile, context }
  }

  const confirmSubmit = () => {
    void submitBuild(gateway, app.slug, submitInput()).then((ok) => {
      // 确认弹窗只承担「确认」这一步：成功关整个弹窗，失败退回主表单看错误原文。
      setConfirmOpen(false)
      if (ok) onClose()
    })
  }

  const requestClose = () => {
    clearBuildPreview()
    onClose()
  }

  // 输入一变旧预览即失效：提交值只能来自最近一次预览。
  const changeTarget = (value: string) => {
    setTarget(value)
    clearBuildPreview()
  }
  const changeDockerfile = (value: string) => {
    setDockerfile(value)
    clearBuildPreview()
  }
  const changeContext = (value: string) => {
    setContext(value)
    clearBuildPreview()
  }
  const changeCompose = (value: string) => {
    setCompose(value)
    setSelectedServices([])
    clearBuildPreview()
  }
  const toggleService = (service: string, checked: boolean) => {
    setSelectedServices((current) => checked ? [...current, service] : current.filter((name) => name !== service))
  }

  return {
    plan, selectedServices, overLimit, canStart, previewing, confirmOpen,
    submitting: state?.submitting === true,
    previewDisabled: previewing || (mode === 'dockerfile' ? dockerfile.trim() === '' : compose === ''),
    openConfirmation: () => setConfirmOpen(true),
    closeConfirmation: () => setConfirmOpen(false),
    runPreview, submitInput, confirmSubmit, requestClose,
    fields: {
      mode, switchMode, target, changeTarget, dockerfile, changeDockerfile, textPaths, context, changeContext,
      compose, changeCompose, composeFiles, selectedServices, toggleService, plan,
      previewError: state?.errorMessage, submitError: state?.submitError,
    },
  }
}
