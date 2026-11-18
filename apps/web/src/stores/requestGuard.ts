import { captureAuthGeneration } from '../utils/authGeneration'

/** A guard owns one request lifetime. Captures can coexist until it is invalidated. */
export function createRequestGuard() {
  let generation = 0

  function capture() {
    const request = generation
    const auth = captureAuthGeneration()
    return () => request === generation && auth === captureAuthGeneration()
  }

  function invalidate() { generation += 1 }

  return {
    capture,
    invalidate,
    replace() {
      invalidate()
      return capture()
    },
  }
}
