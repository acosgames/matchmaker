const rabbitmq = require('fsg-shared/services/rabbitmq');
const redis = require('fsg-shared/services/redis');
const room = require('fsg-shared/services/room');

const profiler = require('fsg-shared/util/profiler');
const credutil = require('fsg-shared/util/credentials');
const events = require('./events');
const storage = require('./storage');
const axios = require('axios');

const { genShortId } = require('fsg-shared/util/idgen');


const yallist = require('./yallist');


class QueueManager {

    constructor() {

        this.timeouts = {};
        this.queues = {};
        this.players = {};
        this.playerNames = {};
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

        let shortid = msg.user.id;
        this.removeFromQueue(shortid);
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
                    let queue = player[mode][game_slug];
                    queue.node.remove();
                }
        }
        //remove player from all modes
        else {
            for (var m in player) {
                for (var game_slug in player[m]) {
                    let queue = player[m][game_slug];
                    queue.node.remove();
                }
            }
        }

        delete this.players[shortid];

        console.log("Removed player " + shortid + " from all queues")
    }

    async onAddToQueue(msg) {
        await this.addToQueue(msg);
    }
    async addToQueue(msg) {

        let game_slug = msg.game_slug;
        let shortid = msg.user.id;
        let mode = msg.mode;

        this.playerNames[shortid] = msg.user.name;

        //check if player needs to be created
        let playerQueues = this.players[shortid];
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
            await this.createGameAndJoinPlayers(gameinfo, mode, [cur]);
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
            await this.createGameAndJoinPlayers(gameinfo, mode, lobby);
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
            return false; //this should happen, but its here just in case

        let min = gameinfo.minplayers;
        let max = gameinfo.maxplayers;

        //single player game, join them immediately
        if (max == 1) {
            await this.createGameAndJoinPlayers(gameinfo, mode, [cur]);
            return true;
        }

        let modeInfos = await storage.getModes();
        let modeId = await room.getGameModeID(mode);
        let modeInfo = modeInfos[modeId];
        let modeData = modeInfo.data || {};

        let attemptKey = mode + " " + game_slug;

        //default the attempts counter
        if (typeof this.attempts[attemptKey] === 'undefined') {
            this.attempts[attemptKey] = 0;
        }

        //load the mode data for this queue and init the lobbies array
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
                    await this.createGameAndJoinPlayers(gameinfo, mode, group);
                    group = [];
                }
                else if (lobby.length < max && group.length >= min && this.attempts[attemptKey] % 10 == 0) {
                    await this.createGameAndJoinPlayers(gameinfo, mode, group);
                    group = [];
                }
            }
        }

        //increase the attempt count so we can widen the range of player compatibiity
        this.attempts[attemptKey]++;

        //no more players, cleanup this queue
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


    async createGameAndJoinPlayers(gameinfo, mode, lobby) {


        //create room using the first player in lobby
        let shortid = lobby[0].val();
        let playerQueue = this.players[shortid][mode][gameinfo.game_slug];
        let room = await this.createRoom(gameinfo.game_slug, mode, shortid, playerQueue.rating || 0);

        let attemptKey = mode + " " + gameinfo.game_slug;
        let actions = [];

        //loop through lobby to cleanup the player from queues data 
        // and join them to the newly created room
        for (let i = 0; i < lobby.length; i++) {
            let node = lobby[i];
            let shortid = node.val();
            let playerQueue = this.players[shortid][mode][gameinfo.game_slug];

            console.log("#" + this.count + "[" + genShortId(5) + "] Player '" + shortid + "' joining " + gameinfo.game_slug, playerQueue.rating || 0, this.processed[shortid] ? 'duplicate' : '', this.attempts[attemptKey]);
            this.processed[shortid] = true;
            this.count++;

            this.cleanupPlayer(shortid, node, mode);

            //prepare the join messages to gameserver
            let id = shortid;
            let name = this.playerNames[shortid];
            let room_slug = room.room_slug;
            let msg = {
                type: 'join',
                user: { id, name },
                room_slug
            }
            actions.push(msg);
        }

        await this.sendJoinRequest(gameinfo.game_slug, room.room_slug, actions)
    }



    cleanupPlayer(shortid, node, mode) {
        //cleanup the processed node
        node.remove();

        //cleanup the queue we just processed, so user isn't added to other games
        this.players[shortid][mode] = {};

        //cleanup the player queue info
        let isEmpty = true;
        for (var m in this.players[shortid]) {
            let playermode = this.players[shortid][m];
            let keys = Object.keys(playermode);
            if (keys.length > 0) {
                isEmpty = false;
            }
        }

        //if player has no queues, delete them to save memory
        if (isEmpty) {
            delete this.players[shortid];
        }
    }

    async createRoom(game_slug, mode, shortid, rating) {
        if (mode != 'rank')
            rating = 0;

        let roomMeta = await room.createRoom(shortid, rating, game_slug, mode);
        return roomMeta;
    }

    async sendJoinRequest(game_slug, room_slug, actions) {
        try {

            //tell our game server to load the game, if one doesn't exist already
            let msg = {
                game_slug,
                room_slug
            }
            let exists = await rabbitmq.assertQueue(game_slug);
            if (!exists) {
                await rabbitmq.publishQueue('loadGame', msg)
            }

            //send the join requests to game server
            await rabbitmq.publishQueue(game_slug, actions);
        }
        catch (e) {
            console.error(e);
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

// start();

module.exports = new QueueManager();