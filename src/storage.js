
const cache = require('shared/services/cache.js');
const room = require('shared/services/room.js');

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
    async getGameInfo(game_slug) {
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

module.exports = new Storage();