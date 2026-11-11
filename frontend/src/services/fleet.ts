// Thin RPC wrapper for the Manager panel. Shapes mirror
// adapter/src/fleet-status.ts.

import { natsService } from '@/services/nats'

export interface ContainerStatus {
  username: string
  startedAt: number
  reportedAt: number
  memoryBytes: number
  memoryLimitBytes: number | null
  /** Percent of one core since the previous report; null on the first. */
  cpuPercent: number | null
  cpus: number
  activeTurns: number
  kernels: number
}

export interface FleetEntry {
  username: string
  online: boolean
  status: ContainerStatus | null
}

export const fleetService = {
  /** True when this adapter is the manager container. Older adapters lack the RPC. */
  async isManager(): Promise<boolean> {
    try {
      const res = await natsService.invoke('get_role') as { manager: boolean }
      return res.manager
    } catch {
      return false
    }
  },

  async list(): Promise<FleetEntry[]> {
    const res = await natsService.invoke('fleet_status') as { containers: FleetEntry[] }
    return res.containers
  },
}
