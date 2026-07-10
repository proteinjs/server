import { Loadable, SourceRepository } from '@proteinjs/reflection';

export interface Env {
  env: 'dev' | 'prod';
}

export interface IEnvRepo extends Loadable {
  getEnv(): Env;
}

export const getEnvRepo = () => SourceRepository.get().object<IEnvRepo | undefined>('@proteinjs/server-api/IEnvRepo');

export class EnvInfo {
  private static envRepo?: IEnvRepo;

  private static getEnvRepo() {
    if (!EnvInfo.envRepo) {
      EnvInfo.envRepo = getEnvRepo();
    }

    return EnvInfo.envRepo;
  }

  /**
   * Prod-gating note: the no-repo fail-open below is NOT reachable in a
   * running server or browser app. `EnvRepo` (this package) implements `IEnvRepo` and is registered
   * by this package's own generated reflection index; both the server entrypoint
   * (`dist/generated/index.js`) and the client bundle load the app's full generated source graph,
   * so a repo is always found. The `return true` default only fires in bare contexts with no
   * reflection graph loaded — unit tests and tooling — where dev is the right answer.
   *
   * The boot-race case also fails CLOSED: before `startServer` populates the global data cache,
   * `EnvRepo.getEnv()` returns `{}`, `{}.env !== 'dev'`, so this reads PROD — and no request can
   * execute before that cache is populated (`server.listen` comes after).
   */
  static isDev(): boolean {
    const envRepo = EnvInfo.getEnvRepo();

    if (!envRepo) {
      return true;
    }

    if (envRepo.getEnv().env === 'dev') {
      return true;
    }

    return false;
  }
}
