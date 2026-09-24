import type { IncomingMessage } from 'http';
import { Logger } from '@proteinjs/logger';
import { SocketRefusalCode } from '@proteinjs/server-api';
import { RequestDigests } from '@proteinjs/util-node';
import { ClientAddress } from './ClientAddress';

/** What the server's socket layer hands over about a refused handshake: the request, and why. */
export type SocketHandshakeRefusal = {
  request: IncomingMessage;
  /** Why, in the refuser's own words: `Unauthorized` (no signed-in session), or the transport's (`Bad request`, `Session ID unknown`, …). */
  reason: string;
  /**
   * Why, as the refuser's code: the session gate's `SocketRefusalCode` (the code its client reads), or
   * the transport's numeric error code (engine.io's `connection_error`).
   */
  code?: SocketRefusalCode | number;
  /** The transport's error context name, when the transport refused. */
  context?: string;
};

/** The error a socket middleware hands `next` to refuse a handshake: socket.io sends its `message` and `data` to the client. */
export type SocketHandshakeRefusalError = Error & { data: { code: SocketRefusalCode } };

/**
 * The one line a refused socket handshake leaves — whoever refused it: the session gate (a
 * handshake with no signed-in session behind its cookie) or the transport (a malformed or unknown
 * handshake). At WARN: a client's bad handshake is the client's, never an error of the server's,
 * so it must not be reported or grouped as one. It names why in the refuser's words and which
 * device by its coarse IP hash (`RequestDigests.coarseIp` of the client address the load balancer
 * appended, `ClientAddress`) — so an operator can count refusals per device — and never the
 * address, a cookie or a session id.
 *
 * The session gate's refusal is minted here too (`noSession`): the error the client receives carries
 * the same code as the line, so the refusals an operator counts are the ones a client stops on.
 */
export class SocketHandshakeRefusals {
  private readonly logger = new Logger({ name: 'SocketHandshake' });

  constructor(
    /** The express app — whose `trust proxy` setting decides which client address a request carries. */
    private readonly app: { get(setting: string): unknown },
    /** The digests, keyed like the session: the device hash matches the other lines' for one device. */
    private readonly digests: RequestDigests
  ) {}

  /**
   * The session gate's refusal of a handshake with no signed-in session behind its cookie: the line,
   * and the error to hand the middleware's `next` — `Unauthorized` for people, `{ code: NO_SESSION }`
   * for the client, which treats the refusal as final for that socket.
   */
  noSession(request: IncomingMessage): SocketHandshakeRefusalError {
    const refusal = Object.assign(new Error('Unauthorized'), { data: { code: SocketRefusalCode.NO_SESSION } });
    this.refused({ request, reason: refusal.message, code: refusal.data.code });
    return refusal;
  }

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
