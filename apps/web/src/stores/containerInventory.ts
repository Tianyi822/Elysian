import type { Container, ContainerImage } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { captureAuthGeneration } from '../utils/authGeneration'

type Inventory = { containers: readonly Container[]; images: readonly ContainerImage[] }
type InventoryRead = { gateway: ElysianGateway; auth: number; snapshot?: readonly Container[]; promise: Promise<void> }

export function createContainerInventory(
  get: () => Inventory,
  set: (update: (state: Inventory) => Partial<Inventory>) => void,
  captureImageCommit: () => () => boolean,
) {
  let inventoryRead: InventoryRead | undefined

  return {
    read(gateway: ElysianGateway, options?: { fresh?: boolean }): Promise<void> {
      const auth = captureAuthGeneration()
      const snapshot = get().containers
      if (!options?.fresh && inventoryRead?.gateway === gateway && inventoryRead.auth === auth && inventoryRead.snapshot === snapshot) {
        return inventoryRead.promise
      }
      const claimImageCommit = captureImageCommit()
      const operation: InventoryRead = { gateway, auth, snapshot, promise: Promise.resolve() }
      inventoryRead = operation
      const current = () => inventoryRead === operation && auth === captureAuthGeneration()
      operation.promise = (async () => {
        try {
          const [containers, images] = await Promise.all([
            gateway.containers.list(),
            gateway.containers.listImages(),
          ])
          if (current()) {
            const canCommitImages = claimImageCommit()
            set((state) => ({
              ...(snapshot === state.containers ? { containers } : {}),
              ...(canCommitImages ? { images } : {}),
            }))
            return
          }
        } catch (error) {
          if (current()) throw error
        }
        // 同一会话的新读接管时，原调用方也等待该次读的结果。
        if (auth !== captureAuthGeneration()) return
        if (inventoryRead?.gateway === gateway && inventoryRead.auth === auth) return inventoryRead.promise
      })().finally(() => { operation.snapshot = undefined })
      return operation.promise
    },
    reset() { inventoryRead = undefined },
  }
}
