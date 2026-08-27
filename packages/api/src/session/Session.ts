import { Loadable, SourceRepository } from '@proteinjs/reflection';

export type SessionData = {
  sessionId: string | undefined;
  user: string | undefined;
  data: { [key: string]: any };
};

export const getSessionDataStorage = () => {
  const sessionDataStorages = SourceRepository.get()
    .objects<SessionDataStorage>('@proteinjs/server-api/SessionDataStorage')
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
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
  /**
   * Higher-priority storages win the lookup. Defaults to 0. Lets a test
   * harness register a deterministic storage that beats the async_hooks-based
   * NodeSessionDataStorage, whose context propagation doesn't survive jest's
   * hook/test boundaries — which storage wins must not depend on reflection
   * graph load order.
   */
  priority?: number;
  setData(data: SessionData): void;
  getData(): SessionData;
  /**
   * Drop the CURRENT execution context's session data so the next `setData` seeds fresh.
   * A REQUEST BOUNDARY concern: on a reused keep-alive socket a request's dispatch can be
   * born inside the previous request's async lineage, and first-write-wins `setData` then
   * silently drops the new request's seed — the request runs (and server-renders) as the
   * PRIOR request's user. Optional: only storages with cross-context inheritance need it;
   * single-slot test fakes get identical semantics from `setData` alone.
   */
  clearData?(): void;
}

export class Session {
  static getData() {
    return getSessionDataStorage().getData();
  }

  static setData(data: SessionData) {
    getSessionDataStorage().setData(data);
  }

  /** Drop the current execution context's session data (see SessionDataStorage.clearData). */
  static clearData() {
    getSessionDataStorage().clearData?.();
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
