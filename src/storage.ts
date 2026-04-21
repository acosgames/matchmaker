
import cache from "shared/services/cache.js";
import room from "shared/services/room.js";
import ObjectStorageService from "shared/services/objectstorage.js";

const s3 = new ObjectStorageService();
class Storage {

    constructor() {

        this.teams = {};
    }

    async setParty(partyid, partyinfo) {
        this.teams[partyid] = partyinfo;
        cache.set('party/' + partyid, partyinfo, 2000);
    }

    async getParty(partyid) {
        if (this.teams[partyid]) {
            return this.teams[partyid];
        }
        let partyinfo = await cache.get('party/' + partyid);
        if (partyinfo) {
            this.teams[partyid] = partyinfo;
        }
        return partyinfo;
    }

    async deleteTeam(partyid) {
        if (this.teams[partyid]) {
            delete this.teams[partyid];
        }
        await cache.del('party/' + partyid);
    }

    async getRoomMeta(room_slug) {

        let meta = await room.findRoom(room_slug);
        if (!meta) {
            return null;
        }
        return meta;
    }

    async getPlayerRank(game_slug) {
        try {

        }
        catch (e) {

        }
    }

    async getModes() {
        try {
            let modes = await room.getModes();
            return modes;
        }
        catch (e) {
            console.error(e);
        }
        return null;
    }

    async getGameSettings(game_slug, version): Promise<GameSettings | null> {
        try {
            let key = 'g/' + game_slug + '/settings.' + version + '.json';
            let settings = await cache.get(key);
            if (settings)
                return JSON.parse(settings);

            settings = await s3.downloadPublicScript(key);
            cache.set(key, settings, 36000);
            return JSON.parse(settings);
        }
        catch (e) {
            console.error(e);
        }
        return null;
    }

    async getGameInfo(game_slug): Promise<GameInfo | null> {
        try {
            let gameinfo = await room.getGameInfo(game_slug);
            return gameinfo;
        }
        catch (e) {
            console.error(e);
        }
        return null;
    }

    async getRoomState(room_slug) {
        let game = await cache.get(room_slug);
        if (!game)
            return null;
        return game;
    }

    async getRoomCounts(room_slug) {
        let roomMeta = await this.getRoomMeta(room_slug);
        if (!roomMeta)
            return null;
        let roomState = await this.getRoomState(room_slug);
        if (!roomState || !roomState.players)
            return null;
        let playerList = Object.keys(roomState.players);
        if (!playerList)
            return null;

        return { count: playerList.length, min: roomMeta.minplayers, max: roomMeta.maxplayers };
    }

    async checkIsRoomFull(room_slug) {
        if (!room_slug)
            return true;

        let result = await storage.getRoomCounts(room_slug);
        if (!result)
            return true;

        if (result.count >= result.max)
            return true;

        return false;
    }

}

export default new Storage();