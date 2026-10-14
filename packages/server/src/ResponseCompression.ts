import express from 'express';
import compression from 'compression';
import { constants as zlib } from 'zlib';

/**
 * The server's one owner of response compression: a response composed in full — one the route
 * handed to the framework whole, so its Content-Length is known when the headers go out — whose
 * type is compressible (JSON and its vendor forms, text, scripts, styles) is encoded as the
 * client's Accept-Encoding asks (brotli, gzip or deflate), from {@link THRESHOLD_BYTES} up. A
 * service answer of a few megabytes of JSON crosses the wire at a fraction of its size.
 *
 * Never a streamed response: a route that writes its body in pieces as they are ready sends no
 * Content-Length, and an encoder would hold its pieces until its buffer filled — they would arrive
 * late and together. Never the realtime transport: it attaches to the HTTP server ahead of the
 * application, which never sees its requests, so nothing here touches them.
 *
 * The encoders run on the platform's thread pool (zlib streams), not on the event loop.
 */
export class ResponseCompression {
  /** Bodies under this many bytes go as they are: the encoding's own framing would not pay for itself. */
  static readonly THRESHOLD_BYTES = 1024;

  /**
   * Brotli's quality for a body composed per request: 4 trades a little of the ratio for several
   * times the speed of the library's default (11), which is tuned for an asset compressed once and
   * served many times — a multi-megabyte answer at 11 takes seconds of a thread to encode.
   */
  static readonly BROTLI_QUALITY = 4;

  /** Mounts the encoder on `app` ahead of every route and every other middleware that writes a response. */
  static install(app: express.Express): void {
    app.use(
      compression({
        threshold: ResponseCompression.THRESHOLD_BYTES,
        filter: ResponseCompression.composedInFullAndCompressible,
        brotli: { params: { [zlib.BROTLI_PARAM_QUALITY]: ResponseCompression.BROTLI_QUALITY } },
      })
    );
  }

  /**
   * Whether the encoder may take the response: composed in full (its Content-Length is set when its
   * headers go out) and of a compressible type (the library's own reading of the Content-Type).
   */
  private static composedInFullAndCompressible(request: express.Request, response: express.Response): boolean {
    return response.getHeader('Content-Length') !== undefined && compression.filter(request, response);
  }
}
