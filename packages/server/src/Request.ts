import asyncHooks from 'async_hooks';

export type RequestMetadata = {
  number: number;
  id: string;
  /**
   * The request's url as a log carries it (`RedactedUrl`): the path and the query's keys, never a
   * query value — log writers attach it to every line the request writes.
   */
  url: string;
};

export class Request {
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
   * Drop the CURRENT async id's metadata so the next `setMetadata` seeds fresh — `wrapRoute` calls
   * it at the start of every request, before it sets that request's own. The init hook copies the
   * metadata onto every descendant async resource and `setMetadata` is first-write-wins, and every
   * request on a connection is dispatched inside that connection's lineage: in the connection's own
   * async context (the one the first request's metadata landed on), or in a continuation born from
   * it. Without the clear, every later request on a reused keep-alive connection keeps the first
   * one's number, id and url, and every line it writes names the wrong request. Scoped to the
   * current id, as `Session.clearData()` is: in-flight hops of the previous request keep their own
   * already-copied entries, and descendants created after the re-seed inherit the new metadata.
   */
  clearMetadata(): void {
    if (!Request.HOOK_INITIALIZED) {
      this.initHook();
    }

    delete Request.REQUEST_METADATA[asyncHooks.executionAsyncId()];
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
