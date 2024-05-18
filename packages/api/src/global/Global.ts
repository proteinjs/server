import { Loadable, SourceRepository } from '@proteinjs/reflection';

export type GlobalData = {
  [key: string]: any;
};

export const getGlobalDataStorage = (): GlobalDataStorage => {
  const globalDataStorages = SourceRepository.get().objects<GlobalDataStorage>(
    '@proteinjs/server-api/GlobalDataStorage'
  );

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
