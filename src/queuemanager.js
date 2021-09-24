const rabbitmq = require('fsg-shared/services/rabbitmq');
const redis = require('fsg-shared/services/redis');
const profiler = require('fsg-shared/util/profiler');
const events = require('./events');
const storage = require('./storage');


const yallist = require('./yallist');


class QueueManager {

    constructor() {

        this.queues = {};
        this.players = {};
        this.attempts = {};

        events.addAddToQueueListener(this.onAddToQueue.bind(this));
        events.addRemoveFromQueueListener(this.onAddToQueue.bind(this));
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

        let game_slug = msg.game_slug;
        let shortid = msg.shortid;
        let mode = msg.mode;

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

        let node = list.push(shortid);

        //mark that player is in queue already
        if (mode == 'rank') {
            let rating = await room.findPlayerRating(id, meta.game_slug);
            playerQueues[mode][game_slug] = { rating, node };
        }
        else
            playerQueues[mode][game_slug] = node;
    }

    async matchPlayers(mode, game_slug) {
        try {
            let list = this.queues[mode][game_slug];
            if (!list || list.size() == 0)
                return false;

            let gameinfo = await storage.getGameInfo(game_slug);
            if (!gameinfo)
                return false;

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
            this.createGameAndJoin(gameinfo, mode, bucket);
            this.attempts[attemptKey] = 1;
            return true;
        }

        //build a list in order of queue and create game when max player count reached
        let next = cur.right();
        while (next != null) {
            lobby.push(next);
            if (lobby.length == max) {
                this.createGameAndJoin(gameinfo, mode, bucket);
                this.attempts[attemptKey] = 1;
                return true;
            }
        }


        if (!(attemptKey in this.attemps)) {
            this.attempts[attemptKey] = 1;
        }

        //there are a minimum amount of players, let them play as we haven't been able to find a match
        if (this.attempts[attemptKey] % 10 == 0)
            if (lobby.length >= min) {
                this.createGameAndJoin(gameinfo, mode, bucket);
                this.attempts[attemptKey] = 1;
                return true;
            }

        this.attempts[attemptKey]++;

        return false;
    }

    async attemptRankedMatch() {

    }

    async createGameAndJoin(gameinfo, mode, bucket) {

    }
}

module.exports = new QueueManager();