import { ServerRenderedScript } from '../ServerRenderedScript';
import { getSessionDataStorage } from './Session';

export class SessionDataScriptTag implements ServerRenderedScript {
    async script(): Promise<string> {
        return `proteinjs['sessionData'] = ${JSON.stringify(getSessionDataStorage().getData())};`;
    }
}