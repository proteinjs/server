import { ENV_CACHE_KEY, Env, GlobalDataCache } from '@proteinjs/server-api';

export const environmentCache: GlobalDataCache<Env> = {
  key: ENV_CACHE_KEY,
  create: async (): Promise<Env> => {
    if (process.env.DEVELOPMENT) {
      return { env: 'dev' };
    }
    return { env: 'prod' };
  },
};
