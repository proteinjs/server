import { Loadable, SourceRepository } from '@proteinjs/reflection';

export const getGlobalDataCaches = () =>
  SourceRepository.get().objects<GlobalDataCache<any>>('@proteinjs/server-api/GlobalDataCache');

export interface GlobalDataCache<T> extends Loadable {
  key: string;
  create(): Promise<T>;
}
