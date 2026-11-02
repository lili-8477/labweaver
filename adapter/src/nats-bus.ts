// NATS connection + RPC subscription + stream publishing. The adapter speaks
// plain TCP NATS to the in-cluster nats-server; the frontend speaks WebSocket.
// Subject namespace matches pantheon-frontend/src/services/nats.ts:
//   RPC subject:    pantheon.service.<service_id>
//   Stream subject: pantheon.stream.<stream_id>

import { connect, JSONCodec, StringCodec, type NatsConnection } from "nats";
import type { NATSMessage, NATSResponse, StreamEnvelope, StreamEvent } from "./types.js";

const sc = StringCodec();
const jc = JSONCodec();

export interface BusOptions {
  servers: string;
  serviceId: string;
  user?: string;
  pass?: string;
  subjectPrefix?: string;
}

export class NatsBus {
  private nc!: NatsConnection;

  constructor(private opts: BusOptions) {}

  /** Apply NATS_SUBJECT_PREFIX to a `pantheon.*` subject. */
  qualify(base: string): string {
    return this.opts.subjectPrefix ? `${this.opts.subjectPrefix}.${base}` : base;
  }

  private svcSubject(): string {
    return this.qualify(`pantheon.service.${this.opts.serviceId}`);
  }

  private streamSubject(streamId: string): string {
    return this.qualify(`pantheon.stream.${streamId}`);
  }

  async connect(): Promise<void> {
    this.nc = await connect({
      servers: this.opts.servers,
      user: this.opts.user,
      pass: this.opts.pass,
      reconnect: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2000,
    });
  }

  async close(): Promise<void> {
    await this.nc.drain();
  }

  /** Serve RPC requests on `pantheon.service.<service_id>`.
   *
   * Each request is handled concurrently — a long-running `chat` RPC must NOT
   * block `stop_chat` or any other request sitting in the NATS queue.
   */
  async serve(handler: (method: string, params: Record<string, unknown>) => Promise<unknown>): Promise<void> {
    const sub = this.nc.subscribe(this.svcSubject(), { queue: undefined });
    (async () => {
      for await (const m of sub) {
        // Fire-and-forget per request so the subscription loop keeps pulling.
        (async () => {
          let req: NATSMessage;
          try {
            req = JSON.parse(sc.decode(m.data));
          } catch {
            m.respond(sc.encode(JSON.stringify({ error: "invalid JSON" } as NATSResponse)));
            return;
          }
          try {
            const result = await handler(req.method, req.parameters ?? {});
            m.respond(sc.encode(JSON.stringify({ result } as NATSResponse)));
          } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            m.respond(sc.encode(JSON.stringify({ error } as NATSResponse)));
          }
        })().catch((err) => console.error("[nats] handler crashed:", err));
      }
    })().catch((err) => console.error("[nats] serve loop failed:", err));
  }

  /** Publish one StreamEvent wrapped in the StreamEnvelope the frontend expects. */
  publishStream(streamId: string, ev: StreamEvent): void {
    const envelope: StreamEnvelope = {
      type: "chat",
      session_id: this.opts.serviceId,
      timestamp: Date.now() / 1000,
      data: ev,
    };
    this.nc.publish(this.streamSubject(streamId), jc.encode(envelope));
  }

  /** Compute a full stream subject (used by callers who publish their own envelope). */
  subjectFor(streamId: string): string {
    return this.streamSubject(streamId);
  }

  /** Subscribe to JSON messages on an absolute subject (fleet status). */
  subscribeJson(subject: string, onMessage: (body: unknown) => void): void {
    const sub = this.nc.subscribe(subject);
    (async () => {
      for await (const m of sub) {
        try {
          onMessage(jc.decode(m.data));
        } catch (err) {
          console.warn(`[nats] bad message on ${subject}:`, err);
        }
      }
    })().catch((err) => console.error(`[nats] ${subject} loop failed:`, err));
  }

  /** Publish a pre-built envelope as JSON. For non-chat streams (notebook IOPub). */
  publishRaw(subject: string, envelope: Record<string, unknown>): void {
    this.nc.publish(subject, jc.encode(envelope));
  }
}
