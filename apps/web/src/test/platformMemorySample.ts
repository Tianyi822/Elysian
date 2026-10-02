import type { PlatformMemorySample } from '@elysian/contracts'

export function platformMemorySample(overrides: Partial<PlatformMemorySample> = {}): PlatformMemorySample {
  return {
    rssMb: 80,
    rssSource: 'smaps-rollup',
    systemTotalMb: 1024,
    sampledAt: '2026-10-02T06:00:00.000Z',
    heapUsedMb: 40,
    heapTotalMb: 50,
    heapUnusedMb: 1,
    heapRetainedMb: 3,
    heapReleasedMb: 6,
    runtimeOtherMb: 5,
    heapLiveMb: 35,
    gcCount: 8,
    ...overrides,
  }
}
