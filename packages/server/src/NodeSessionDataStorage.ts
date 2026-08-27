import asyncHooks from 'async_hooks';
import { SessionData, SessionDataStorage } from '@proteinjs/server-api';

export class NodeSessionDataStorage implements SessionDataStorage {
  private static HOOK_INITIALIZED = false;
  private static readonly SESSION_DATA: { [id: string]: SessionData } = {};
  environment = 'node' as 'node';

  setData(data: SessionData) {
    if (!NodeSessionDataStorage.HOOK_INITIALIZED) {
      this.initHook();
    }

    if (NodeSessionDataStorage.SESSION_DATA[asyncHooks.executionAsyncId()]) {
      return;
    }

    NodeSessionDataStorage.SESSION_DATA[asyncHooks.executionAsyncId()] = data;
  }

  getData(): SessionData {
    if (!NodeSessionDataStorage.HOOK_INITIALIZED) {
      this.initHook();
    }

    return NodeSessionDataStorage.SESSION_DATA[asyncHooks.executionAsyncId()];
  }

  /**
   * Drop the CURRENT async id's entry so the next `setData` seeds fresh. The init hook copies
   * a populated bag onto every descendant async resource and `setData` is first-write-wins, so
   * a request dispatched inside a PREVIOUS request's lineage (keep-alive socket reuse — the
   * normal case under a 620s keepAliveTimeout) would otherwise run as the prior request's user
   * (observed 2026-08-26: /dev/login account switch, home greeting server-rendered with the
   * previous account's name). Scoped to the current id on purpose: in-flight hops of the
   * previous request keep their own already-copied entries, and descendants created after the
   * re-seed inherit the fresh bag.
   */
  clearData(): void {
    if (!NodeSessionDataStorage.HOOK_INITIALIZED) {
      this.initHook();
    }

    delete NodeSessionDataStorage.SESSION_DATA[asyncHooks.executionAsyncId()];
  }

  private initHook() {
    asyncHooks
      .createHook({
        init: (asyncId: number, type: string, triggerAsyncId: number, resource: Object) => {
          if (!NodeSessionDataStorage.SESSION_DATA[triggerAsyncId]) {
            return;
          }

          NodeSessionDataStorage.SESSION_DATA[asyncId] = NodeSessionDataStorage.SESSION_DATA[triggerAsyncId];
        },
        destroy: (asyncId: number) => {
          delete NodeSessionDataStorage.SESSION_DATA[asyncId];
        },
      })
      .enable();
    NodeSessionDataStorage.HOOK_INITIALIZED = true;
  }
}
