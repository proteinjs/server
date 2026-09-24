import type { IncomingMessage } from 'http';
import { Logger } from '@proteinjs/logger';
import { RequestDigests } from '@proteinjs/util-node';
import { ClientAddress } from './ClientAddress';

/** What the server's socket layer hands over about a refused handshake: the request, and why. */
export type SocketHandshakeRefusal = {
  request: IncomingMessage;
  /** Why, in the refuser's own words: `Unauthorized` (no signed-in session), or the transport's (`Bad request`, `Session ID unknown`, …). */
  reason: string;
  /** The transport's error code and context name, when the transport refused (engine.io's `connection_error`). */
  code?: number;
  context?: string;
};

/**
 * The one line a refused socket handshake leaves — whoever refused it: the session gate (a
 * handshake with no signed-in session behind its cookie) or the transport (a malformed or unknown
 * handshake). At WARN: a client's bad handshake is the client's, never an error of the server's,
 * so it must not be reported or grouped as one. It names why in the refuser's words and which
 * device by its coarse IP hash (`RequestDigests.coarseIp` of the client address the load balancer
 * appended, `ClientAddress`) — so an operator can count refusals per device — and never the
 * address, a cookie or a session id.
 */
export class SocketHandshakeRefusals {
  private readonly logger = new Logger({ name: 'SocketHandshake' });

  constructor(
    /** The express app — whose `trust proxy` setting decides which client address a request carries. */
    private readonly app: { get(setting: string): unknown },
    /** The digests, keyed like the session: the device hash matches the other lines' for one device. */
    private readonly digests: RequestDigests
  ) {}

  refused({ request, reason, code, context }: SocketHandshakeRefusal): void {
    this.logger.warn({
      message: 'Socket handshake refused',
      obj: {
        reason,
        ...(code !== undefined ? { code } : {}),
        ...(context ? { context } : {}),
        device: this.device(request),
      },
    });
  }

  /** The coarse IP hash of the client the request came from; `unknown` when it carries no address at all. */
  private device(request: IncomingMessage): string {
    const address = new ClientAddress().of({ app: this.app, headers: request.headers, socket: request.socket });
    return address ? this.digests.coarseIp(address) : 'unknown';
  }
}
