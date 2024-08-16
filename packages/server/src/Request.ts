import asyncHooks from 'async_hooks';

export type RequestMetadata = {
  number: number;
  id: string;
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
