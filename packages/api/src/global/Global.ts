import { Loadable, SourceRepository } from '@proteinjs/reflection';

export type GlobalData = {
  [key: string]: any;
};

export const getGlobalDataStorage = (): GlobalDataStorage => {
  const globalDataStorages = SourceRepository.get()
    .objects<GlobalDataStorage>('@proteinjs/server-api/GlobalDataStorage')
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  for (const globalDataStorage of globalDataStorages) {
    if (globalDataStorage.environment == 'browser' && typeof window === 'undefined') {
      continue;
    }

    return globalDataStorage;
  }

  throw new Error(`Unable to find @proteinjs/server-api/GlobalDataStorage implementation`);
};

export interface GlobalDataStorage extends Loadable {
  environment: 'node' | 'browser';
  /**
   * Higher-priority storages win the lookup. Defaults to 0. Lets a test
   * harness register a deterministic storage that beats the async_hooks-based
   * NodeGlobalDataStorage — which storage wins must not depend on reflection
   * graph load order.
   */
  priority?: number;
  setData(data: GlobalData): void;
  getData(): GlobalData;
}

export class Global {
  static getData(): GlobalData {
    return getGlobalDataStorage().getData();
  }

  static setData(data: GlobalData): void {
    getGlobalDataStorage().setData(data);
  }

  static getDataByKey<T>(globalDataCacheKey: string): T | undefined {
    const globalData = Global.getData();
    if (!globalData) {
      return undefined;
    }

    return globalData[globalDataCacheKey];
  }

  static setDataByKey<T>(globalDataCacheKey: string, data: T) {
    Global.getData()[globalDataCacheKey] = data;
  }
}
