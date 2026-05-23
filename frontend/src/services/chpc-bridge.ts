// Thin RPC wrapper around natsService for the CHPC bridge.

import { natsService } from '@/services/nats'
import type { BridgeStatus, OpenRequest } from '@/types/chpc-bridge'

export const chpcBridgeService = {
  async status(): Promise<BridgeStatus> {
    const res = await natsService.invoke('chpc_bridge_status') as {
      success: boolean
      status: BridgeStatus
    }
    return res.status
  },

  /** Fire-and-forget. Phase updates arrive on the `chpc_bridge_events` stream. */
  async open(req: OpenRequest): Promise<void> {
    await natsService.invoke('chpc_bridge_open', req as unknown as Record<string, unknown>)
  },

  async close(): Promise<{ wasRunning: boolean }> {
    const res = await natsService.invoke('chpc_bridge_close') as {
      success: boolean
      wasRunning: boolean
    }
    return { wasRunning: res.wasRunning }
  },
}
