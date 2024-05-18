import { ServerRenderedScript } from '../ServerRenderedScript';
import { Global, getGlobalDataStorage } from './Global';

export class GlobalDataScriptTag implements ServerRenderedScript {
  async script(): Promise<string> {
    return `proteinjs['globalData'] = ${JSON.stringify(getGlobalDataStorage().getData())};`;
  }
}
