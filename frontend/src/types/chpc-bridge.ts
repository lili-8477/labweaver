// Shape of the CHPC bridge state surfaced over chpc_bridge_* RPCs.
// Mirrors adapter/src/chpc-bridge-rpc.ts — keep these in sync.

export type BridgeStatus =
  | { kind: 'up'; pid: number; openedAt: string; user: string }
  | { kind: 'down' }
  | { kind: 'unprovisioned'; reason: 'no-ssh' | 'no-config' }

export type DuoChoice = { kind: 'push' } | { kind: 'passcode'; code: string }

export interface OpenRequest {
  password: string
  duo: DuoChoice
  requestId: string
}

export type OpenPhase =
  | 'idle'
  | 'spawned'
  | 'password-accepted'
  | 'duo-waiting'
  | 'up'
  | 'error'

export type OpenEvent =
  | { requestId: string; phase: 'spawned' }
  | { requestId: string; phase: 'password-accepted' }
  | { requestId: string; phase: 'duo-waiting' }
  | { requestId: string; phase: 'up'; pid: number }
  | {
      requestId: string
      phase: 'error'
      code: 'bad-password' | 'duo-denied' | 'duo-timeout' | 'network' | 'config' | 'unknown'
      message: string
    }

/** Stream envelope on `pantheon.stream.chpc_bridge_events` */
export interface ChpcBridgeStreamMessage {
  type: 'chpc_bridge'
  session_id: string
  timestamp: number
  data: OpenEvent
}
