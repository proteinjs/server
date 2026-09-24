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
   * it in each routed request's own async scope, before it sets that request's own. The scope
   * inherits the metadata of whatever lineage the dispatch arrives in (the init hook copies it onto
   * every descendant async resource) and `setMetadata` is first-write-wins: a request dispatched
   * from inside another request's lineage — a middleware that holds a request and releases it from
   * another request's work — would otherwise keep that request's number, id and url. Scoped to the
   * current id, as `Session.clearData()` is: the other request's hops keep their own entries.
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
