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

        let timeoutKey = mode + ' ' + game_slug;
        let timeoutHandle = this.timeouts[timeoutKey];
        if (typeof timeoutHandle !== 'undefined') {
            clearTimeout(this.timeouts[timeoutKey])
        }

        let gameinfo = await storage.getGameInfo(game_slug);
        if (!gameinfo) {
            return;
        }


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
            playerQueues[mode][game_slug] = node;
        }

        let result = this.matchPlayers(mode, game_slug);

        if (list.size() > gameinfo.minplayers) {
            let modeId = await room.getGameModeID(mode);
            let modeInfos = await storage.getModes();
            let modeInfo = modeInfos[modeId];
            let modeData = modeInfo.data || {};
            let retryDelay = modeData.retry || 100;
            this.timeouts[timeoutKey] = setTimeout(() => { this.matchPlayers(mode, game_slug); }, retryDelay)
        }

        if (list.size() == 0) {
            delete this.queues[mode][game_slug];
        }
    }

    async matchPlayers(mode, game_slug) {
        try {
            let list = this.queues[mode][game_slug];
            if (!list || list.size() == 0)
                return false;

            let gameinfo = await storage.getGameInfo(game_slug);
            if (!gameinfo)
                return false;

            if (mode == 'rank') {
                return await this.attemptRankedMatch(gameinfo, list);
            }
            return await this.attemptAnyMatch(gameinfo, mode, list);
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

        let game_slug = gameinfo.game_slug;
        let cur = list.first();
        if (cur == null)
            return false;

        let attemptKey = mode + " " + game_slug;
        let min = gameinfo.minplayers;
        let max = gameinfo.maxplayers;
        let lobby = [cur];

        if (max == 1) {
            this.createGameAndJoinPlayers(gameinfo, mode, lobby);
            this.attempts[attemptKey] = 1;
            return true;
        }

        //build a list in order of queue and create game when max player count reached
        let next = cur.right();
        while (next != null) {
            lobby.push(next);
            if (lobby.length == max) {
                this.createGameAndJoinPlayers(gameinfo, mode, lobby);
                this.attempts[attemptKey] = 1;

                lobby = [];
                if (list.size() > 0) {
                    cur = list.first();
                }

            }

            next = cur.right();
        }


        if (!(attemptKey in this.attempts)) {
            this.attempts[attemptKey] = 1;
        }

        //there are a minimum amount of players, let them play as we haven't been able to find a match
        if (this.attempts[attemptKey] % 10 == 0)
            if (lobby.length >= min) {
                this.createGameAndJoinPlayers(gameinfo, mode, lobby);
                this.attempts[attemptKey] = 1;
                return true;
            }

        this.attempts[attemptKey]++;

        return false;
    }

    async attemptRankedMatch(gameinfo, list, depth) {
        depth = depth || 1;

        let game_slug = gameinfo.game_slug;
        let mode = 'rank';

        let cur = list.first();
        if (cur == null)
            return false;


        let min = gameinfo.minplayers;
        let max = gameinfo.maxplayers;
        let lobby = [cur];

        if (max == 1) {
            this.createGameAndJoinPlayers(gameinfo, mode, lobby);
            //this.attempts[attemptKey] = 1;
            return true;
        }

        //build a list in order of queue and create game when max player count reached
        let waiting = [];
        let start = cur;
        let next = cur.right();

        let modeInfos = await storage.getModes();
        let modeId = await room.getGameModeID(mode);
        let modeInfo = modeInfos[modeId];
        let threshold = modeInfo.data || 300;

        let attemptKey = mode + " " + game_slug;

        if (typeof this.attempts[attemptKey] === 'undefined') {
            this.attempts[attemptKey] = 1;
        }

        console.log("Attempt #" + this.attempts[attemptKey]);
        while (next != null && list.size() > 1) {
            let playerA = this.getPlayerQueue(cur.val(), mode, game_slug);
            let playerB = this.getPlayerQueue(next.val(), mode, game_slug);
            let depth = this.attempts[attemptKey];
            let compat = this.comparePlayers(playerA, playerB, depth, threshold)
            if (compat) {
                lobby.push(next);
            } else {
                waiting.push(next);
            }



            if (lobby.length == max) {


                this.createGameAndJoinPlayers(gameinfo, mode, lobby);
                this.attempts[attemptKey] = 1;

                cur = list.first();
                if (cur == null)
                    break;
                next = cur.right();
                lobby = [cur];
                waiting = [];
            }
            else {
                next = next.right();
                waiting = [];
            }

            list.print();



        }

        //there are a minimum amount of players, let them play as we haven't been able to find a match
        if (this.attempts[attemptKey] % 10 == 0)
            if (lobby.length >= min) {
                this.createGameAndJoinPlayers(gameinfo, mode, lobby);
                this.attempts[attemptKey] = 1;
                return true;
            }

        this.attempts[attemptKey]++;

        return true;
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

        let id = genShortId(3);
        for (let i = 0; i < lobby.length; i++) {
            let node = lobby[i];
            let shortid = node.val();
            let playerQueue = this.players[shortid][mode][gameinfo.game_slug];
            console.log("[" + id + "] Player '" + shortid + "' joining " + gameinfo.game_slug, playerQueue.rating, this.processed[shortid] ? 'duplicate' : '');
            this.processed[shortid] = true;
            node.remove();
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



function test() {
    let q = new QueueManager();

    for (var i = 0; i < 100; i++) {
        let msg = {
            game_slug: 'tictactoe',
            mode: 'rank',
            shortid: genShortId(5)
        }
        q.onAddToQueue(msg);
    }

}

start();

module.exports = new QueueManager();