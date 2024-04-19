import { SessionData, SessionDataStorage } from './Session';
declare let proteinjs: any;

export class BrowserSessionDataStorage implements SessionDataStorage {
    environment = 'browser' as 'browser';

    // set in global via SessionDataScriptTag
    setData(data: SessionData) {
        proteinjs['sessionData'] = data;
    }

    getData(): SessionData {
        return proteinjs['sessionData'];
    }
}