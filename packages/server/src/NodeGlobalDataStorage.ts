import asyncHooks from 'async_hooks';
import { GlobalData, GlobalDataStorage } from '@proteinjs/server-api';

export class NodeGlobalDataStorage implements GlobalDataStorage {
  private static HOOK_INITIALIZED = false;
  private static readonly GLOBAL_DATA: { [id: string]: GlobalData } = {};
  environment = 'node' as 'node';

  setData(data: GlobalData) {
    if (!NodeGlobalDataStorage.HOOK_INITIALIZED) {
      this.initHook();
    }

    if (NodeGlobalDataStorage.GLOBAL_DATA[asyncHooks.executionAsyncId()]) {
      return;
    }

    NodeGlobalDataStorage.GLOBAL_DATA[asyncHooks.executionAsyncId()] = data;
  }

  getData(): GlobalData {
    if (!NodeGlobalDataStorage.HOOK_INITIALIZED) {
      this.initHook();
    }

    return NodeGlobalDataStorage.GLOBAL_DATA[asyncHooks.executionAsyncId()];
  }

  private initHook() {
    asyncHooks
      .createHook({
        init: (asyncId: number, type: string, triggerAsyncId: number, resource: Object) => {
          if (!NodeGlobalDataStorage.GLOBAL_DATA[triggerAsyncId]) {
            return;
          }

          NodeGlobalDataStorage.GLOBAL_DATA[asyncId] = NodeGlobalDataStorage.GLOBAL_DATA[triggerAsyncId];
        },
        destroy: (asyncId: number) => {
          delete NodeGlobalDataStorage.GLOBAL_DATA[asyncId];
        },
      })
      .enable();
    NodeGlobalDataStorage.HOOK_INITIALIZED = true;
  }
}
