import { IncomingMessage } from 'http';

type RequestWithRawBody = IncomingMessage & { rawBody?: Buffer };

/**
 * A request body's exact bytes, as they arrived — kept by the server beside the parsed body only for
 * a route that declares `rawBody` (`Route.rawBody`): a route that verifies a signature computed over those
 * bytes (a webhook's). The parsed body re-serialized is not those bytes (whitespace, key order and
 * escapes differ), so a signature can only be checked against these.
 *
 * Kept on the request itself, so every copy of this package reads what the server kept.
 */
export class RawBody {
  /**
   * The exact bytes of the request's body; undefined when its route did not declare `rawBody`, or
   * when the body is not one the server parses (JSON or a form).
   */
  static of(request: IncomingMessage): Buffer | undefined {
    return (request as RequestWithRawBody).rawBody;
  }

  /** Kept by the server's body parser, for a declaring route's request only. */
  static keep(request: IncomingMessage, bytes: Buffer): void {
    (request as RequestWithRawBody).rawBody = bytes;
  }
}
