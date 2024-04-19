import { Loadable, SourceRepository } from '@proteinjs/reflection';

export const getSessionDataCaches = () => SourceRepository.get().objects<SessionDataCache<any>>('@proteinjs/server-api/SessionDataCache');

export interface SessionDataCache<T> extends Loadable {
    key: string;
    create(sessionId: string|undefined, user: string|undefined): Promise<T>;
}