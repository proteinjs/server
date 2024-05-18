import { Global } from '../generated';
import { Env, IEnvRepo } from './EnvInfo';
import { ENV_CACHE_KEY } from './cacheKeys';

export class EnvRepo implements IEnvRepo {
  getEnv(): Env {
    return Object.assign({}, Global.getDataByKey<Env>(ENV_CACHE_KEY));
  }

  setEnv(env: Env) {
    Global.setDataByKey(ENV_CACHE_KEY, env);
  }
}
