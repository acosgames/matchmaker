const rabbitmq = require('shared/services/rabbitmq');
const redis = require('shared/services/redis');
const rooms = require('shared/services/room');
const person = require('shared/services/person');

const profiler = require('shared/util/profiler');
const credutil = require('shared/util/credentials');
const credentials = credutil();

const events = require('./events');
const storage = require('./storage');
const axios = require('axios');

const webpush = require('web-push');

webpush.setVapidDetails(credentials.webpush.contact, credentials.webpush.publickey, credentials.webpush.privatekey)



const { genShortId } = require('shared/util/idgen');


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
        events.addLeaveFromQueueListener(this.onLeaveFromQueue.bind(this));
    }

    async loadQueues() {

        try {
            let queuePlayers = await redis.hgetall('queuePlayers');
            let queueExists = await redis.hgetall('queueExists');

            for (var q in queueExists) {
                let parts = q.split('/');
                let mode = parts[0];
                let game_slug = parts[1];

                let queueList = await redis.smembers('queues/' + q);
                let shortid;
                let username;
                for (var i = 0; i < queueList.length; i++) {
                    shortid = queueList[i];
                    username = queuePlayers[shortid];
                    this.addToQueue(shortid, username, game_slug, mode, true);
                }
                console.log(queueList);
                // this.addToQueue()
            }
            console.log(queuePlayers);
        }
        catch (e) {
            console.error(e);
        }

    }

    createPlayerQueueMap() {
        return { rank: {}, experimental: {}, public: {}, private: {} };
    }

    async onLeaveFromQueue(msg) {

        let shortid = msg.user.id;
        this.leaveFromQueue(shortid);
    }

    async leaveFromQueue(shortid, mode) {

        let player = this.players[shortid];
        if (!player) {
            return;
        }

        //remove player from specific mode 
        if (mode) {
            if (player[mode])
                for (var game_slug in player[mode]) {
                    let queue = player[mode][game_slug];
                    try {
                        redis.srem('queues/' + mode + '/' + game_slug, shortid);
                        if (queue.node.list.size() == 1) {
                            redis.hdel('queueExists', mode + '/' + game_slug);
                            redis.hset('queueCount', game_slug, 0);
                        }
                    }
                    catch (e) {

                    }

                    queue.node.remove();


                }
        }
        //remove player from all modes
        else {
            for (var m in player) {
                for (var game_slug in player[m]) {
                    let queue = player[m][game_slug];

                    try {
                        redis.srem('queues/' + m + '/' + game_slug, shortid);
                        if (queue.node.list.size() == 1) {
                            redis.hdel('queueExists', m + '/' + game_slug);
                            redis.hset('queueCount', game_slug, 0);
                        }

                        let gameinfo = await storage.getGameInfo(game_slug);
                        let username = this.playerNames[shortid];
                        if (gameinfo) {
                            await rabbitmq.publishQueue('notifyDiscord', { 'type': 'queue', shortid, username, game_title: (gameinfo?.name || game_slug), game_slug, mode: m, thumbnail: (gameinfo?.preview_images || '') })
                        }
                    }
                    catch (e) {
                        console.error(e);
                    }


                    queue.node.remove();
                }
            }
        }

        delete this.players[shortid];
        delete this.playerNames[shortid];


        try {
            redis.hdel('queuePlayers', shortid);
        }
        catch (e) {
            console.error(e);
        }


        console.log("Removed player " + shortid + " from all queues")
    }

    async onAddToQueue(msg) {

        console.log("onAddToQueue", JSON.stringify(msg, null, 2));
        let queues = msg.queues || [];


        if (!msg.user || !msg.user.id)
            return false;

        if (!msg.user.name) {
            try {
                let userinfo = await person.findUser({ shortid: msg.user.id }, true);
                if (!userinfo)
                    throw "E_USERNOTFOUND";

                msg.user.name = userinfo.diplayname;
            }
            catch (e) {
                console.error("ERROR: Cannot find user");
                console.error(e);
            }
        }

        for (var i = 0; i < queues.length; i++) {
            let queue = queues[i];
            let game_slug = queue.game_slug;
            let mode = queue.mode;

            this.addToQueue(msg.user.id, msg.user.name, game_slug, mode);
        }

    }
    async addToQueue(shortid, username, game_slug, mode, skipRedis) {

        // let shortid = msg.user.id;


        this.playerNames[shortid] = username;// msg.user.name;

        //check if player needs to be created
        var playerQueues = this.players[shortid];
        if (!playerQueues) {
            playerQueues = this.createPlayerQueueMap();
        }

        if (!playerQueues[mode]) {
            playerQueues[mode] = {};
        }

        // console.log("creating new playerQueues", shortid);
        // if(!playerQueues[mode][game_slug]) {
        //     this.players[shortid] = playerQueues;
        // }

        if (playerQueues[mode][game_slug]) {
            console.log("ALREADY IN QUEUE: ", shortid, game_slug, mode);
            return;
        }

        // console.log("player queue exists: ", shortid, mode, game_slug);
        // let playerQueue = playerQueues[mode][game_slug];
        // if (playerQueue) {
        //     console.log("ALREADY IN QUEUE: ", shortid, game_slug, mode);
        //     return; //already in queue
        // }

        try {
            if (!skipRedis)
                redis.hset('queuePlayers', shortid, username);
        }
        catch (e) {
            console.error(e);
        }


        let gameinfo = await storage.getGameInfo(game_slug);
        if (gameinfo) {
            await rabbitmq.publishQueue('notifyDiscord', { 'type': 'queue', shortid, username, game_title: (gameinfo?.name || game_slug), game_slug, mode, thumbnail: (gameinfo?.preview_images || '') })
        }




        //check if mode exist
        let queuesMode = this.queues[mode];
        if (!queuesMode) {
            console.log("Queue for mode does not exist: ", mode);
            this.queues[mode] = {};
        }

        //check if game exist in mode
        //add user to list
        let list = this.queues[mode][game_slug];
        if (!list) {
            console.log("Creating queue list: ", mode, game_slug);
            list = yallist.create();
            this.queues[mode][game_slug] = list;
            try {
                if (!skipRedis) {
                    redis.hset('queueExists', mode + '/' + game_slug, true);

                }
            }
            catch (e) {
                console.error(e);
            }

        }

        try {
            if (!skipRedis) {
                redis.sadd('queues/' + mode + '/' + game_slug, shortid);
            }
        }
        catch (e) {
            console.error(e);
        }



        //mark that player is in queue already
        if (mode == 'rank') {
            let rating = await rooms.findPlayerRating(shortid, game_slug);
            console.log("[RANK] Found player rating: ", rating);
            let node = list.push(shortid);
            playerQueues[mode][game_slug] = { rating: rating.rating, node };
        }
        else {
            console.log("[" + mode + "] adding user to queue: ", shortid, mode, game_slug);
            let node = list.push(shortid);
            playerQueues[mode][game_slug] = { node };
        }

        //let result = this.matchPlayers(mode, game_slug);

        try {
            if (!skipRedis) {
                redis.hset('queueCount', game_slug, list.size());
            }
        }
        catch (e) {
            console.error(e);
        }


        this.players[shortid] = playerQueues;

        await this.retryMatchPlayers(mode, game_slug, true);


    }

    async retryMatchPlayers(mode, game_slug, skipTimer) {
        let modeId = await rooms.getGameModeID(mode);
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
            console.log("getPlayerQueue", shortid, mode, game_slug);
            if (!this.players)
                return null;
            if (!this.players[shortid])
                return null;

            if (!this.players[shortid][mode])
                return null;
            if (!this.players[shortid][mode][game_slug])
                return null;

            return this.players[shortid][mode][game_slug];
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
                (lobby.length < max &&
                    lobby.length >= min &&
                    (this.attempts[attemptKey] % 5 == 0))) {
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
            console.log("Single player game: creat game and join players", game_slug, mode);
            await this.createGameAndJoinPlayers(gameinfo, mode, [cur]);
            return true;
        }

        let modeInfos = await storage.getModes();
        let modeId = await rooms.getGameModeID(mode);
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
        let maxLobbies = (5000 / offset) + 1;
        for (let i = 0; i < maxLobbies; i++) {
            lobbies.push([]);
        }

        //move each player into one of the lobbies by their ranking
        let invalidPlayers = [];
        list.forEach((v, i, lst, node) => {
            let playerA = this.getPlayerQueue(v, mode, game_slug);
            if (!playerA) {
                console.error("Invalid player found: ", v, mode, game_slug);
                node.remove();
                invalidPlayers.push(v);
                return;
            }
            let lobbyId = parseInt(Math.ceil(playerA.rating / offset));
            console.log("[" + v + "] = ", lobbyId, playerA.rating)
            lobbies[lobbyId].push(node);
        })

        for (var i = 0; i < invalidPlayers.length; i++) {
            let shortid = invalidPlayers[i];
            let username = this.playerNames[shortid];
            this.addToQueue(shortid, username, game_slug, mode);
        }

        //for each lobby, check if we can create a game
        for (let i = 0; i < lobbies.length; i++) {
            let lobby = lobbies[i];
            let group = [];
            for (let j = 0; j < lobby.length; j++) {
                group.push(lobby[j]);
                if (group.length == max) {
                    console.log("group.length == max: creat game and join players", game_slug, mode);
                    await this.createGameAndJoinPlayers(gameinfo, mode, group);
                    group = [];
                }
                else if (lobby.length < max && group.length >= min && this.attempts[attemptKey] % 10 == 0) {
                    console.log("lobby.length < max: creat game and join players", game_slug, mode);
                    await this.createGameAndJoinPlayers(gameinfo, mode, group);
                    group = [];
                }
            }
        }

        //increase the attempt count so we can widen the range of player compatibiity
        this.attempts[attemptKey]++;

        //no more players, cleanup this queue
        if (list.size() == 0) {
            console.log("List size == 0, cleanup queue", game_slug, mode);
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
        let room_slug = room.room_slug;

        let attemptKey = mode + " " + gameinfo.game_slug;
        let actions = [];


        let shortids = [];
        //loop through lobby to cleanup the player from queues data 
        // and join them to the newly created room
        for (let i = 0; i < lobby.length; i++) {
            let node = lobby[i];
            let shortid = node.val();
            if (!this.players[shortid])
                return;
            let playerQueue = this.players[shortid][mode][gameinfo.game_slug];

            console.log("#" + this.count + "[" + genShortId(5) + "] Player '" + shortid + "' joining " + gameinfo.game_slug, playerQueue.rating || 0, this.processed[shortid] ? 'duplicate' : '', this.attempts[attemptKey]);
            this.processed[shortid] = true;
            this.count++;


            // this.cleanupPlayer(shortid, node, mode);



            //prepare the join messages to gameserver
            let id = shortid;
            let name = this.playerNames[shortid];

            shortids.push(shortid);
            // delete this.playerNames[shortid];

            let msg = {
                type: 'join',
                user: { id, name },
                room_slug
            }
            actions.push(msg);

            this.leaveFromQueue(shortid);




        }

        await this.sendJoinRequest(gameinfo.game_slug, room_slug, actions, gameinfo)

        await this.assignAndNotify(shortids, room_slug, gameinfo);
    }

    async assignAndNotify(shortids, room_slug, gameinfo) {
        console.log("Assign and Notify: ", shortids, room_slug);
        for (var i = 0; i < shortids.length; i++) {
            let shortid = shortids[i];
            await rooms.assignPlayerRoom(shortid, room_slug, gameinfo.game_slug);
        }
        await rooms.notifyPlayerRoom(room_slug, gameinfo);
    }

    cleanupPlayer(shortid, node, mode) {
        //cleanup the processed node
        // node.remove();

        // //cleanup the queue we just processed, so user isn't added to other games
        // this.players[shortid][mode] = {};

        //cleanup the player queue info
        // let isEmpty = true;
        // for (var m in this.players[shortid]) {
        //     let playermode = this.players[shortid][m];
        //     let keys = Object.keys(playermode);
        //     if (keys.length > 0) {
        //         isEmpty = false;
        //     }
        // }

        this.leaveFromQueue(shortid);
        // console.log("cleanupPlayer removing queues: ", shortid);
        // let player = this.players[shortid]

        // for (var m in player) {
        //     for (var game_slug in player[m]) {
        //         let queue = player[m][game_slug];
        //         queue.node.remove();
        //     }
        // }

        // //if player has no queues, delete them to save memory
        // // if (isEmpty) {
        // delete this.players[shortid];
        // }
    }

    async createRoom(game_slug, mode, shortid, rating) {
        if (mode != 'rank')
            rating = 0;

        let roomMeta = await rooms.createRoom(shortid, rating, game_slug, mode);
        return roomMeta;
    }

    async sendJoinRequest(game_slug, room_slug, actions, gameinfo) {
        try {

            //tell our game server to load the game, if one doesn't exist already
            let msg = {
                game_slug,
                room_slug
            }
            let key = game_slug + '/' + room_slug;
            // let exists = await rabbitmq.assertQueue(key);
            // if (!exists) {
            await rabbitmq.publishQueue('loadGame', { msg, key, actions })
            // }

            await rabbitmq.publishQueue('notifyDiscord', { 'type': 'join', actions, game_title: (gameinfo?.name || game_slug), game_slug, room_slug, thumbnail: (gameinfo?.preview_images || '') })

            //send the join requests to game server

            // await rabbitmq.publish('game', key, actions);
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