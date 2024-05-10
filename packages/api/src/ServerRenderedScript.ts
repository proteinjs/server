import { Loadable, SourceRepository } from '@proteinjs/reflection';

export const getServerRenderedScripts = () =>
  SourceRepository.get().objects<ServerRenderedScript>('@proteinjs/server-api/ServerRenderedScript');

export interface ServerRenderedScript extends Loadable {
  /**
   * Will be run server-side on every request that ships down the client bundle.
   * The returned string will be placed inside script tags in the returned markup.
   */
  script(): Promise<string>;
}
