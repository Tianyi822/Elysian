import { useEffect, useState } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { useContainersStore } from '../../stores/containersStore'
import { emptyDraft, hasCreateErrors, toCreateInput, validateCreateDraft, type ContainerCreateDraft, type PortDraftRow } from './containerCreateForm'

export function useContainerCreateForm() {
  const gateway = useGateway()
  const open = useContainersStore((s) => s.createOpen)
  const creating = useContainersStore((s) => s.creating)
  const createError = useContainersStore((s) => s.createError)
  const containers = useContainersStore((s) => s.containers)
  const images = useContainersStore((s) => s.images)
  const closeCreate = useContainersStore((s) => s.closeCreate)
  const createContainer = useContainersStore((s) => s.createContainer)

  const [draft, setDraft] = useState<ContainerCreateDraft>(emptyDraft)
  const [optionalOpen, setOptionalOpen] = useState(false)
  const [showErrors, setShowErrors] = useState(false)
  const [volumeHostPlaceholder, setVolumeHostPlaceholder] = useState('/srv/data')

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

  return {
    creating, createError, closeCreate, disabled, submit,
    fields: {
      images, draft, optionalOpen, showErrors, errors, volumeHostPlaceholder, patch, updatePorts,
      toggleOptional: () => setOptionalOpen((value) => !value),
    },
  }
}
