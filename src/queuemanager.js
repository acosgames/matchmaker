const rabbitmq = require('fsg-shared/services/rabbitmq');
const redis = require('fsg-shared/services/redis');
const profiler = require('fsg-shared/util/profiler');
const credutil = require('fsg-shared/util/credentials');
const events = require('./events');
const storage = require('./storage');
const axios = require('axios');

const { genShortId } = require('fsg-shared/util/idgen');


const yallist = require('./yallist');
const room = require('../../fsg-api/node_modules/fsg-shared/services/room');


class QueueManager {

    constructor() {

        this.timeouts = {};
        this.queues = {};
        this.players = {};
        this.attempts = {};

        this.processed = {};
        this.count = 0;

        events.addAddToQueueListener(this.onAddToQueue.bind(this));
        events.addRemoveFromQueueListener(this.onRemoveFromQueue.bind(this));
    }

    createPlayerQueueMap() {
        return { rank: {}, beta: {}, public: {}, private: {} };
    }

    async onRemoveFromQueue(msg) {

    }

    removeFromQueue(shortid, mode) {

        let player = this.players[shortid];
        if (!player) {
            return;
        }

        //remove player from specific mode 
        if (mode) {
            if (player[mode])
                for (var game_slug in player[mode]) {
                    let node = player[mode][game_slug];
                    node.remove();
                }
        }
        //remove player from all modes
        else {
            for (var m in player) {
                for (var game_slug in player[m]) {
                    let node = player[m][game_slug];
                    node.remove();
                }
            }
        }
    }

    async onAddToQueue(msg) {
        await this.addToQueue(msg.game_slug, msg.shortid, msg.mode);
    }
    async addToQueue(game_slug, shortid, mode) {

        let playerQueues = this.players[shortid];
        //check if player needs to be created
        if (!playerQueues) {
            playerQueues = this.createPlayerQueueMap();
            this.players[shortid] = playerQueues;
        }
        else {
            let playerQueue = playerQueues[mode][game_slug];
            if (playerQueue) {
                return; //already in queue
            }
        }

        //check if mode exist
        let list = this.queues[mode];
        if (!list) {
            this.queues[mode] = {};
        }

        //check if game exist in mode
        //add user to list
        list = this.queues[mode][game_slug];
        if (!list) {
            list = yallist.create();
            this.queues[mode][game_slug] = list;
        }



        //mark that player is in queue already
        if (mode == 'rank') {
            let rating = await room.findPlayerRating(shortid, game_slug);
            let node = list.push(shortid);
            playerQueues[mode][game_slug] = { rating: rating.rating, node };
        }
        else {
            let node = list.push(shortid);
            playerQueues[mode][game_slug] = { node };
        }

        //let result = this.matchPlayers(mode, game_slug);



        await this.retryMatchPlayers(mode, game_slug, true);


    }

    async retryMatchPlayers(mode, game_slug, skipTimer) {
        let modeId = await room.getGameModeID(mode);
        let modeInfos = await storage.getModes();
        let modeInfo = modeInfos[modeId];
        let modeData = modeInfo.data || {};
        let retryDelay = modeData.retryDelay || 2000;
        let timeoutKey = mode + ' ' + game_slug;
        let timeoutHandle = this.timeouts[timeoutKey] || 0;
        if (timeoutHandle > 0) {
            clearTimeout(this.timeouts[timeoutKey])
            this.timeouts[timeoutKey] = 0;
        }
        if (skipTimer) {
            this.timeouts[timeoutKey] = setTimeout(() => { this.matchPlayers(mode, game_slug); }, retryDelay / 10)
        }
        else {
            this.timeouts[timeoutKey] = setTimeout(() => { this.matchPlayers(mode, game_slug); }, retryDelay)
        }
    }

    async matchPlayers(mode, game_slug) {
        try {
            let list = this.queues[mode][game_slug];
            if (!list || list.size() == 0)
                return false;

            let gameinfo = await storage.getGameInfo(game_slug);
            if (!gameinfo) {
                delete this.queues[mode][game_slug];
                return;
            }

            let result = false;
            if (mode == 'rank') {
                result = await this.attemptRankedMatch(gameinfo, list);
            }
            else
                result = await this.attemptAnyMatch(gameinfo, mode, list);

            if (list.size() >= gameinfo.minplayers) {
                this.retryMatchPlayers(mode, game_slug);
            }

        }
        catch (e) {
            console.error(e);
        }
        return false;
    }

    getPlayerQueue(shortid, mode, game_slug) {
        try {
            let playerQueue = this.players[shortid][mode][game_slug];
            return playerQueue;
        }
        catch (e) {
            console.error(e);
            return null;
        }
    }

    async attemptAnyMatch(gameinfo, mode, list) {

        let cur = list.first();
        if (cur == null)
            return false;

        let game_slug = gameinfo.game_slug;
        let min = gameinfo.minplayers;
        let max = gameinfo.maxplayers;

        if (max == 1) {
            this.createGameAndJoinPlayers(gameinfo, mode, [cur]);
            return true;
        }

        let attemptKey = mode + " " + game_slug;
        if (typeof this.attempts[attemptKey] === 'undefined') {
            this.attempts[attemptKey] = 0;
        }

        //move each player into one of the lobbies by their ranking
        let players = list.toArray();
        let lobbies = [];
        let lobby = [];
        list.forEach((v, i, list, node) => {
            lobby.push(node);
            if (lobby.length == max ||
                (lobby.length < max && lobby.length >= min && this.attempts[attemptKey] % 5 == 0)) {
                lobbies.push(lobby);
                lobby = [];
            }
        })

        for (let i = 0; i < lobbies.length; i++) {
            let lobby = lobbies[i];
            this.createGameAndJoinPlayers(gameinfo, mode, lobby);
        }

        this.attempts[attemptKey]++;

        if (list.size() == 0) {
            let attemptKey = mode + " " + game_slug;
            delete this.attempts[attemptKey];
            delete this.queues[mode][game_slug];
        }

        return list.size() == 0;
    }

    async attemptRankedMatch(gameinfo, list) {


        let game_slug = gameinfo.game_slug;
        let mode = 'rank';

        let cur = list.first();
        if (cur == null)
            return false;

        let min = gameinfo.minplayers;
        let max = gameinfo.maxplayers;

        if (max == 1) {
            this.createGameAndJoinPlayers(gameinfo, mode, [cur]);
            //this.attempts[attemptKey] = 1;
            return true;
        }

        let modeInfos = await storage.getModes();
        let modeId = await room.getGameModeID(mode);
        let modeInfo = modeInfos[modeId];
        let modeData = modeInfo.data || {};

        let attemptKey = mode + " " + game_slug;
        if (typeof this.attempts[attemptKey] === 'undefined') {
            this.attempts[attemptKey] = 0;
        }

        let lobbies = [];
        let depth = this.attempts[attemptKey];
        let delta = modeData.delta || 50;
        let threshold = modeData.threshold || 200;
        let offset = threshold + (delta * depth);
        let maxLobbies = (4000 / offset) + 1;
        for (let i = 0; i < maxLobbies; i++) {
            lobbies.push([]);
        }

        //move each player into one of the lobbies by their ranking
        list.forEach((v, i, list, node) => {
            let playerA = this.getPlayerQueue(v, mode, game_slug);
            let lobbyId = parseInt(Math.ceil(playerA.rating / offset));
            // console.log("[" + v + "] = ", lobbyId, playerA.rating)
            lobbies[lobbyId].push(node);
        })

        //for each lobby, check if we can create a game
        for (let i = 0; i < lobbies.length; i++) {
            let lobby = lobbies[i];
            let group = [];
            for (let j = 0; j < lobby.length; j++) {
                group.push(lobby[j]);
                if (group.length == max) {
                    this.createGameAndJoinPlayers(gameinfo, mode, group);
                    group = [];
                }
                else if (lobby.length < max && group.length >= min && this.attempts[attemptKey] % 10 == 0) {
                    this.createGameAndJoinPlayers(gameinfo, mode, group);
                    group = [];
                }
            }
        }

        this.attempts[attemptKey]++;

        if (list.size() == 0) {
            let attemptKey = mode + " " + game_slug;
            delete this.attempts[attemptKey];
            delete this.queues[mode][game_slug];
        }

        return list.size() == 0;
    }

    comparePlayers(a, b, depth, threshold) {
        let ratio = (1.0 - (depth / 10.0));
        if (!a || !b) {
            console.error("a=", a);
            console.error("b=", b);
        }
        let distance = a.rating - b.rating;
        distance = Math.abs(distance);
        distance = distance * ratio;
        if (distance <= threshold) {
            return true;
        }
        return false;
    }


    createGameAndJoinPlayers(gameinfo, mode, lobby) {

        let attemptKey = mode + " " + gameinfo.game_slug;
        let id = genShortId(3);
        for (let i = 0; i < lobby.length; i++) {
            let node = lobby[i];
            let shortid = node.val();
            let playerQueue = this.players[shortid][mode][gameinfo.game_slug];

            console.log("#" + this.count + "[" + id + "] Player '" + shortid + "' joining " + gameinfo.game_slug, playerQueue.rating || 0, this.processed[shortid] ? 'duplicate' : '', this.attempts[attemptKey]);
            this.processed[shortid] = true;
            node.remove();
            this.count++;
            this.players[shortid][mode] = {};
        }
    }
}




function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function start() {

    while (!(rabbitmq.isActive() && redis.isActive)) {

        console.warn("[GameReceiver] waiting on rabbitmq and redis...");
        await sleep(1000);
        //return;
    }

    test();
}



async function test() {
    let q = new QueueManager();

    for (var i = 0; i < 101; i++) {
        let msg = {
            game_slug: 'tictactoe',
            mode: 'rank',
            shortid: genShortId(5)
        }
        q.onAddToQueue(msg);
    }

    await sleep(5000);
    let msg = {
        game_slug: 'tictactoe',
        mode: 'rank',
        shortid: genShortId(5)
    }
    q.onAddToQueue(msg);

}

start();

module.exports = new QueueManager();