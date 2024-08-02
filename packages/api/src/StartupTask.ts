import { Loadable, SourceRepository } from '@proteinjs/reflection';

export const getStartupTasks = () => SourceRepository.get().objects<StartupTask>('@proteinjs/server-api/StartupTask');

export interface StartupTask extends Loadable {
  name: string;
  when: 'before server config' | 'after server config' | 'after server start';
  run(): Promise<void>;
}
