import asyncHooks from 'async_hooks';

/**
 * THE REQUEST'S OWN FACTS — seeded once by the route wrapper when a request is dispatched and
 * inherited by every async resource the request spawns, so any log line written inside the
 * request names it without a second read of the express request: its number and id (the
 * correlation keys), its url and HTTP method, the requesting client's user agent, and the
 * client's SELF-DECLARED CONTEXT — every `x-client-*` request header, keyed by its full lowercase
 * name (the build a browser bundle runs, whatever else a consumer's client attaches through its
 * request-headers provider). The framework carries the bag; the consumer owns the names — the
 * same consumer supplies them on the client and reads them from this bag on the server.
 */
export type RequestMetadata = {
  number: number;
  id: string;
  url: string;
  method: string;
  userAgent?: string;
  clientContext?: { [header: string]: string };
};

export class Request {
  /** Headers a client uses to declare its own context; the bag keeps their full lowercase names. */
  static readonly CLIENT_CONTEXT_HEADER_PREFIX = 'x-client-';
  private static readonly CLIENT_CONTEXT_VALUE_MAX_CHARS = 200;
  private static HOOK_INITIALIZED = false;
  private static readonly REQUEST_METADATA: { [id: string]: RequestMetadata } = {};

  setMetadata(data: RequestMetadata) {
    if (!Request.HOOK_INITIALIZED) {
      this.initHook();
    }

    if (Request.REQUEST_METADATA[asyncHooks.executionAsyncId()]) {
      return;
    }

    Request.REQUEST_METADATA[asyncHooks.executionAsyncId()] = data;
  }

  getMetadata(): RequestMetadata {
    if (!Request.HOOK_INITIALIZED) {
      this.initHook();
    }

    return Request.REQUEST_METADATA[asyncHooks.executionAsyncId()];
  }

  /**
   * Drop the metadata the current async context INHERITED, so the next `setMetadata` is
   * authoritative — the request-boundary cure Session applies to its bag: a request dispatched
   * on a reused keep-alive socket is born inside the previous request's lineage (the init hook
   * copies bags onto descendants) and first-write-wins `setMetadata` would silently keep the
   * PRIOR request's number, id, url and client context on every line this request writes.
   */
  clearMetadata(): void {
    if (!Request.HOOK_INITIALIZED) {
      this.initHook();
    }

    delete Request.REQUEST_METADATA[asyncHooks.executionAsyncId()];
  }

  /**
   * The request's `x-client-*` headers, keyed by their full lowercase name — undefined when it
   * carried none (absent, never an empty bag). Values are bounded: a header is a fact, not a payload.
   */
  static clientContextOf(headers: { [name: string]: string | string[] | undefined }): RequestMetadata['clientContext'] {
    let context: { [header: string]: string } | undefined;
    for (const [name, value] of Object.entries(headers)) {
      const header = name.toLowerCase();
      if (!header.startsWith(Request.CLIENT_CONTEXT_HEADER_PREFIX)) {
        continue;
      }
      const text = Array.isArray(value) ? value[0] : value;
      if (typeof text !== 'string' || !text) {
        continue;
      }
      context = context ?? {};
      context[header] = text.slice(0, Request.CLIENT_CONTEXT_VALUE_MAX_CHARS);
    }
    return context;
  }

  private initHook() {
    asyncHooks
      .createHook({
        init: (asyncId: number, type: string, triggerAsyncId: number, resource: Object) => {
          if (!Request.REQUEST_METADATA[triggerAsyncId]) {
            return;
          }

          Request.REQUEST_METADATA[asyncId] = Request.REQUEST_METADATA[triggerAsyncId];
        },
        destroy: (asyncId: number) => {
          delete Request.REQUEST_METADATA[asyncId];
        },
      })
      .enable();
    Request.HOOK_INITIALIZED = true;
  }
}
