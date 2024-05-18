import { GlobalData, GlobalDataStorage } from './Global';
declare let proteinjs: any;

export class BrowserGlobalDataStorage implements GlobalDataStorage {
  environment = 'browser' as 'browser';

  // set in global via GlobalDataScriptTag
  setData(data: GlobalData) {
    proteinjs['globalData'] = data;
  }

  getData(): GlobalData {
    return proteinjs['globalData'];
  }
}
