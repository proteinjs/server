import { Loadable, SourceRepository } from '@proteinjs/reflection';

export type SessionData = {
  sessionId: string | undefined;
  user: string | undefined;
  data: { [key: string]: any };
};

export const getSessionDataStorage = () => {
  const sessionDataStorages = SourceRepository.get().objects<SessionDataStorage>(
    '@proteinjs/server-api/SessionDataStorage'
  );
  for (const sessionDataStorage of sessionDataStorages) {
    if (sessionDataStorage.environment == 'browser' && typeof window === 'undefined') {
      continue;
    }

    return sessionDataStorage;
  }

  throw new Error(`Unable to find @proteinjs/server-api/SessionDataStorage implementation`);
};

export interface SessionDataStorage extends Loadable {
  environment: 'node' | 'browser';
  setData(data: SessionData): void;
  getData(): SessionData;
}

export class Session {
  static getData() {
    return getSessionDataStorage().getData();
  }

  static setData(data: SessionData) {
    getSessionDataStorage().setData(data);
  }

  static getDataByKey<T>(sessionDataCacheKey: string): T | undefined {
    const sessionData = Session.getData();
    if (!sessionData) {
      return undefined;
    }

    return sessionData.data[sessionDataCacheKey];
  }

  static setDataByKey<T>(sessionDataCacheKey: string, data: T) {
    Session.getData().data[sessionDataCacheKey] = data;
  }
}
