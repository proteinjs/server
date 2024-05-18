import { Loadable, SourceRepository } from '@proteinjs/reflection';

export type Env = {
  env: 'dev' | 'prod';
};

export interface IEnvRepo extends Loadable {
  getEnv(): Env;
}

export const getEnvRepo = () => SourceRepository.get().object<IEnvRepo | undefined>('@proteinjs/server-api/EnvRepo');

export class EnvInfo {
  private static envRepo?: IEnvRepo;

  private static getEnvRepo() {
    if (!EnvInfo.envRepo) {
      EnvInfo.envRepo = getEnvRepo();
    }

    return EnvInfo.envRepo;
  }

  static isDev(): boolean {
    const envRepo = EnvInfo.getEnvRepo();
    if (!envRepo) {
      return true;
    }

    return false;
  }
}
