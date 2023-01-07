const rabbitmq = require('shared/services/rabbitmq');
const redis = require('shared/services/redis');
const rooms = require('shared/services/room');
const PersonService = require('shared/services/person');
const person = new PersonService();

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

        this.queuedParties = {};

        this.teams = {};

        this.processed = {};
        this.count = 0;

        events.addLeaveFromTeamListener(this.onLeaveFromTeam.bind(this));
        events.addAddToTeamListener(this.onAddToTeam.bind(this));
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

    isObject(x) {
        return x != null && (typeof x === 'object' || typeof x === 'function') && !Array.isArray(x);
    }

    async onAddToTeam(payload) {

        let teamid = payload.teamid;
        let players = payload.players;
        let captain = payload.captain;

        if (!players || !this.isObject(players) || players.length == 0) {
            return false;
        }

        if (!teamid) {
            teamid = genShortId(8)
        }

        //check if we have existing team
        let teaminfo = await storage.getTeam(teamid) || { teamid, players, captain };



        //check which players need to be added
        let newPlayers = [];
        if (teaminfo?.players) {
            for (let shortid in teaminfo.players) {
                if (!(shortid in players)) {
                    newPlayers.push({ shortid, displayname: teaminfo.players[shortid] })
                }
            }
        }

        //add the players to the team
        for (let player of newPlayers) {
            teaminfo.players[player.shortid] = player.displayname;
        }

        //update our team roster
        storage.setTeam(teamid, teaminfo);

        //let users know their team was updated
        rabbitmq.publish('ws', 'joinedTeam', teaminfo);

        return teamid;
    }

    async onLeaveFromTeam(payload) {
        let teamid = payload.teamid;
        let shortid = payload.shortid;

        let teaminfo = await storage.getTeam(teamid);
        if (!teaminfo)
            return;

        if (teaminfo?.players[shortid]) {
            delete teaminfo.players[shortid];
        }

        if (teaminfo?.captain == shortid) {
            let playerList = Object.keys(teaminfo.players);
            teaminfo.captain = playerList[Math.floor(Math.random() * playerList.length)]
        }

        if (teaminfo?.players?.length <= 1) {
            storage.deleteTeam(teamid);
        }
        else {
            storage.setTeam(teamid, teaminfo);
        }

        rabbitmq.publish('ws', 'leaveTeam', teaminfo);
    }

    createPlayerQueueMap() {
        return { rank: {}, experimental: {}, public: {}, private: {} };
    }

    async onLeaveFromQueue(msg) {

        let shortid = msg.user.shortid;

        console.log("onLeaveFromQueue", JSON.stringify(msg, null, 2))

        this.leaveFromQueue(shortid);
    }

    async leaveFromQueue(shortid) {

        let parties = this.queuedParties[shortid];

        if (!parties) {
            console.warn("[leaveFromQueue] Captain not in our list: ", shortid);
            return;
        }

        let response = { queues: [] };
        for (const key in parties) {
            let parts = key.split('/');
            let mode = parts[0];
            let game_slug = parts[1];

            let party = parties[key];

            //save user into the queue list on redis
            try {
                for (let i = 0; i < party.players.length; i++) {
                    let player = party.players[i];
                    redis.srem('queues/' + mode + '/' + game_slug, player.shortid + '|' + player.displayname);
                }
            }
            catch (e) {
                console.error(e);
            }

            if (!response.players) {
                response.players = party.players;
            }

            if (!response.teamid) {
                response.teamid = party.teamid;
            }

            if (!response.captain) {
                response.captain = party.captain;
            }

            response.queues.push({ mode, game_slug });

            await rabbitmq.publishQueue('notifyDiscord', {
                'type': 'queue',
                captain: party.captain,
                players: party.players,
                rating: party.rating,
                game_title: (party.game_slug),
                game_slug: party.game_slug,
                mode: party.mode,
                thumbnail: ''
            })

            party.node.remove();
        }

        rabbitmq.publish('ws', 'onQueueUpdate', { type: 'removed', payload: response });



        delete this.queuedParties[shortid];



        // let player = this.players[shortid];
        // if (!player) {
        //     return;
        // }

        // //remove player from specific mode 
        // if (mode) {
        //     if (player[mode])
        //         for (var game_slug in player[mode]) {
        //             let queue = player[mode][game_slug];
        //             try {
        //                 redis.srem('queues/' + mode + '/' + game_slug, shortid);
        //                 if (queue.node.list.size() == 1) {
        //                     redis.hdel('queueExists', mode + '/' + game_slug);
        //                     redis.hset('queueCount', game_slug, 0);
        //                 }
        //             }
        //             catch (e) {

        //             }

        //             queue.node.remove();


        //         }
        // }
        // //remove player from all modes
        // else {
        //     for (var m in player) {
        //         for (var game_slug in player[m]) {
        //             let queue = player[m][game_slug];

        //             try {
        //                 redis.srem('queues/' + m + '/' + game_slug, shortid);
        //                 if (queue.node.list.size() == 1) {
        //                     redis.hdel('queueExists', m + '/' + game_slug);
        //                     redis.hset('queueCount', game_slug, 0);
        //                 }

        //                 let gameinfo = await storage.getGameInfo(game_slug);
        //                 let username = this.playerNames[shortid];
        //                 if (gameinfo && gameinfo.maxplayers > 1) {
        //                     await rabbitmq.publishQueue('notifyDiscord', { 'type': 'queue', shortid, username, game_title: (gameinfo?.name || game_slug), game_slug, mode: m, thumbnail: (gameinfo?.preview_images || '') })
        //                 }
        //             }
        //             catch (e) {
        //                 console.error(e);
        //             }


        //             queue.node.remove();
        //         }
        //     }
        // }

        // delete this.players[shortid];
        // delete this.playerNames[shortid];


        // try {
        //     redis.hdel('queuePlayers', shortid);
        // }
        // catch (e) {
        //     console.error(e);
        // }


        // console.log("Removed player " + shortid + " from all queues")
    }

    /**
     * Add a team into a queue (team can be 1 person or more)
     * msg.teamid
     * msg.players
     * msg.queues
     * msg.captain
     * @param {*} msg 
     * @returns 
     */

    async onAddToQueue(msg) {

        console.log("onAddToQueue", JSON.stringify(msg, null, 2));

        if (!msg)
            return false;



        let teamid = msg.teamid;
        let queues = msg.queues;
        let players = msg.players;
        let captain = msg.captain;

        //captain must be specified
        if (!msg.captain)
            return false;

        //teamid is optional, if it exists find the team information
        if (msg.teamid) {

            let teaminfo = await storage.getTeam(msg.teamid);
            if (teaminfo) {
                //requestor must be the captain of the team
                if (msg.captain != teaminfo.captain) {
                    return false;
                }

                //overwrite the players list sent in request (shouldn't have one but just incase), 
                // because we have the team players list already

                let partyPlayers = [];
                for (const shortid in teaminfo.players) {
                    partyPlayers.push({ shortid, displayname: teaminfo.players[shortid] })
                }
                msg.players = partyPlayers;
            }
        }

        //there must be players defined to continue
        if (!msg.players || msg.players.length == 0) {
            return false;
        }

        //builds shortid and game_slug lists to query player ratings of group
        let shortids = [];
        let game_slugs = [];
        for (const queue of msg.queues)
            game_slugs.push(queue.game_slug);
        for (const player of msg.players)
            shortids.push(player.shortid);


        //builds a group for every mode/game_slug pair
        let parties = {};
        for (const queue of msg.queues) {
            let key = queue.mode + '/' + queue.game_slug;
            parties[key] = {
                game_slug: queue.game_slug,
                mode: queue.mode,
                players: msg.players,
                teamid: msg.teamid || null,
                captain: msg.captain,
                threshold: 0,
                createDate: Date.now()
            }
        }

        //find all player ratings for each game being queued
        let groupRatings = await rooms.findGroupRatings(shortids, game_slugs);

        //set ratings for each team group and individual player
        for (const key in parties) {
            let party = parties[key];
            let game_slug = party.game_slug;

            let groupRating = 0;
            let minRating = Number.MAX_SAFE_INTEGER;
            let maxRating = 0;
            for (const player of party.players) {

                let playerRating = groupRatings[player.shortid][game_slug];
                player.rating = playerRating.rating;

                if (player.rating < minRating)
                    minRating = player.rating;

                if (player.rating > maxRating)
                    maxRating = player.rating;

                groupRating += player.rating;
            }

            //group rating is average + 50% of the way to highest ranked player
            let groupRatingAverage = (groupRating / party.players.length)
            groupRating = groupRatingAverage + ((maxRating - groupRatingAverage) * 0.5);

            party.rating = groupRating;

            this.addToQueue(party);
        }

        rabbitmq.publish('ws', 'onQueueUpdate', { type: 'added', payload: msg });
    }

    async addToQueue(party, skipRedis) {

        let key = party.mode + '/' + party.game_slug;

        if (!(key in this.queues))
            this.queues[key] = yallist.create();

        let list = this.queues[key];

        // let captainKey = key + '/' + party.captain;
        if (!(party.captain in this.queuedParties)) {
            this.queuedParties[party.captain] = {};
        }

        if (key in this.queuedParties[party.captain]) {
            console.warn('User already in queue: ', party.captain);
            return;
        }

        this.queuedParties[party.captain][key] = party;
        party.node = list.push(party.captain);

        //notify chats that someone has joined a queue
        let gameinfo = await storage.getGameInfo(party.game_slug);
        if (gameinfo && gameinfo.maxplayers > 1) {

            //save user into the queue list on redis
            try {
                for (let i = 0; i < party.players.length; i++) {
                    let player = party.players[i];
                    redis.sadd('queues/' + party.mode + '/' + party.game_slug, player.shortid + '|' + player.displayname);
                }
            }
            catch (e) {
                console.error(e);
            }


            await rabbitmq.publishQueue('notifyDiscord', {
                'type': 'queue',
                captain: party.captain,
                players: party.players,
                rating: party.rating,
                game_title: (gameinfo?.name || party.game_slug),
                game_slug: party.game_slug,
                mode: party.mode,
                thumbnail: (gameinfo?.preview_images || '')
            })
        }

        await this.retryMatchPlayers(party.mode, party.game_slug, true);
    }


    async retryMatchPlayers(mode, game_slug, skipTimer) {
        let modeId = await rooms.getGameModeID(mode);
        let modeInfos = await storage.getModes();
        let modeInfo = modeInfos[modeId];
        let modeData = modeInfo.data || {};
        let retryDelay = modeData.retryDelay || 2000;
        let timeoutKey = mode + '/' + game_slug;
        let timeoutHandle = this.timeouts[timeoutKey] || 0;

        //only allow a single settimeout to keep attempting rank convergence
        if (timeoutHandle > 0) {
            clearTimeout(this.timeouts[timeoutKey])
            this.timeouts[timeoutKey] = 0;
        }

        //match players together for specific mode/game_slug
        if (skipTimer) {
            this.timeouts[timeoutKey] = setTimeout(() => { this.matchPlayers(mode, game_slug); }, retryDelay / 10)
        }
        else {
            this.timeouts[timeoutKey] = setTimeout(() => { this.matchPlayers(mode, game_slug); }, retryDelay)
        }
    }

    async matchPlayers(mode, game_slug) {
        try {
            let key = mode + '/' + game_slug;

            let list = this.queues[key];
            if (!list || list.size() == 0) {
                console.warn("[matchPlayers] queue list does not exist: ", key);
                return false;
            }

            //grab the gameinfo so we know min/max sizes of game and game defined teams
            let gameinfo = await storage.getGameInfo(game_slug);
            if (!gameinfo) {
                console.warn("[matchPlayers] Gameinfo does not exist for: ", game_slug);
                delete this.queues[key];
                return;
            }

            let result = false;
            //ranked matches try to match based on user ratings
            if (mode == 'rank') {
                result = await this.attemptRankedMatch(gameinfo, list);
            }
            //all other matches don't matter
            else
                result = await this.attemptAnyMatch(gameinfo, list);

            let allPlayerCount = 0;
            //players are still in list, attempt more matches
            list.forEach((captain, i, list, node) => {

                if (!this.queuedParties[captain] || !this.queuedParties[captain][key]) {
                    return;
                }
                let party = this.queuedParties[captain][key];
                allPlayerCount += party?.players?.length || 0;
            });

            //simple use case, but in future, make it more advanced based on team sizes too 
            if (allPlayerCount >= gameinfo.minplayers) {
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

    // async attemptAnyMatch(gameinfo, mode, list) {

    //     let cur = list.first();
    //     if (cur == null)
    //         return false;

    //     let game_slug = gameinfo.game_slug;
    //     let min = gameinfo.minplayers;
    //     let max = gameinfo.maxplayers;

    //     if (max == 1) {
    //         await this.createGameAndJoinPlayers(gameinfo, mode, [cur]);
    //         return true;
    //     }

    //     let attemptKey = mode + " " + game_slug;
    //     if (typeof this.attempts[attemptKey] === 'undefined') {
    //         this.attempts[attemptKey] = 0;
    //     }

    //     //move each player into one of the lobbies by their ranking
    //     let players = list.toArray();
    //     let lobbies = [];
    //     let lobby = [];
    //     list.forEach((v, i, list, node) => {
    //         lobby.push(node);
    //         if (lobby.length == max ||
    //             (lobby.length < max &&
    //                 lobby.length >= min &&
    //                 (this.attempts[attemptKey] % 5 == 0))) {
    //             lobbies.push(lobby);
    //             lobby = [];
    //         }
    //     })

    //     for (let i = 0; i < lobbies.length; i++) {
    //         let lobby = lobbies[i];
    //         await this.createGameAndJoinPlayers(gameinfo, mode, lobby);
    //     }

    //     this.attempts[attemptKey]++;

    //     if (list.size() == 0) {
    //         let attemptKey = mode + " " + game_slug;
    //         delete this.attempts[attemptKey];
    //         delete this.queues[mode][game_slug];
    //     }

    //     return list.size() == 0;
    // }

    //only use for small arrays of < 100
    selectRandomPlayers(arr, n) {
        // Shuffle array
        const shuffled = arr.sort(() => 0.5 - Math.random());

        // Get sub-array of first n elements after shuffled
        let selected = shuffled.slice(0, n);

        let spectators = shuffled.slice(n);

        return { selected, spectators };
    }

    createTeamsBySize(gameinfo) {
        //create the game defined team vacancy sizes and player list
        //parties that have leftover players will be pushed to spectator list
        let teamsBySize = [];
        let maxTeamSize = 0;
        //free for all scenario
        if (!gameinfo.maxteams) {
            for (let i = 0; i < gameinfo.maxplayers; i++) {
                let teamid = i + 1;
                teamsBySize.push({ team_slug: 'team_' + teamid, maxplayers: 1, minplayers: 1, vacancy: 1, players: [], captains: [] })
            }
            maxTeamSize = 1;
        }
        //battlegrounds scenario
        else if (gameinfo.maxteams == 1) {
            let team = gameinfo.teamlist[0];
            let maxteamcount = Math.floor(gameinfo.maxplayers / team.maxplayers)
            for (let i = 0; i < maxteamcount; i++) {
                let teamid = i + 1;
                teamsBySize.push({ team_slug: 'team_' + teamid, maxplayers: team.maxplayers, minplayers: team.minplayers, vacancy: team.maxplayers, players: [], captains: [] })
            }
            maxTeamSize = team.maxplayers;
        }
        //traditional team scenario
        else {
            for (const team of gameinfo.teamlist) {
                if (team.maxplayers > maxTeamSize)
                    maxTeamSize = team.maxplayers;
                teamsBySize.push({ team_slug: team.team_slug, maxplayers: team.maxplayers, minplayers: team.minplayers, vacancy: team.maxplayers, players: [], captains: [] });
            }
        }
        //sort in descending order, so we can fill largest vacancies first
        teamsBySize.sort((a, b) => {
            b.vacancy - a.vacancy;
        })

        return teamsBySize;
    }


    //Algorithm for team-based Matchmaking
    //sort player parties by size desc
    //sort game defined teams by size desc
    //loop parties, then loop teams
    //store top vacancy sizes per teams that can support most party players
    //if team vacancy sizes + threshold are less than max team size
    //   - break out of loop and skip team
    //      - increase threshold by 1 each time party is checked and didn't join team
    //add party to random team that supports their size
    //update new gameteam sizes to match vacancies
    //break and move to next party
    async attemptRankedMatch(gameinfo, list) {

        let game_slug = gameinfo.game_slug;
        let mode = 'rank';

        //make sure our first node exists
        let cur = list.first();
        if (cur == null)
            return false; //this should happen, but its here just in case

        //get mode data for rating radius spread
        let modeInfos = await storage.getModes();
        let modeId = await rooms.getGameModeID(mode);
        let modeInfo = modeInfos[modeId];
        let modeData = modeInfo.data || {};
        let attemptKey = mode + "/" + game_slug;

        //default the attempts counter
        if (typeof this.attempts[attemptKey] === 'undefined') {
            this.attempts[attemptKey] = 0;
        }


        let depth = this.attempts[attemptKey];
        let delta = modeData.delta || 50;
        let threshold = modeData.threshold || 200;
        let offset = threshold + (delta * depth);
        let maxLobbies = Math.ceil((5000 / offset) + 1);
        let lobbies = new Array(maxLobbies);

        //Build lobbies by grouping parties based on party rating
        list.forEach((captain, i, lst, node) => {

            if (!this.queuedParties[captain] || !this.queuedParties[captain][attemptKey])
                return;

            let party = this.queuedParties[captain][attemptKey];
            if (!party)
                return;

            if (!party.players || party.players.length == 0) {
                //leave queue here
            }


            let lobbyId = parseInt(Math.ceil(party.rating / offset));
            console.log("[" + captain + "] = ", lobbyId, party.rating)

            if (!Array.isArray(lobbies[lobbyId]))
                lobbies[lobbyId] = [];
            lobbies[lobbyId].push(party);
        })


        //create the partySizes of all players in the queue for this mode/game_slug
        for (const lobby of lobbies) {
            if (!lobby)
                continue;
            let chosenParties = await this.buildRoomsFromLobby(lobby, gameinfo, mode, []);

            for (const captain of chosenParties) {

                this.leaveFromQueue(captain);

            }




        }

        //increase the attempt count so we can widen the range of player compatibiity
        this.attempts[attemptKey]++;

        //no more players, cleanup this queue
        if (list.size() == 0) {
            console.log("List size == 0, cleanup queue", game_slug, mode);
            let attemptKey = mode + " " + game_slug;
            delete this.attempts[attemptKey];
            delete this.queues[attemptKey];
        }

        return list.size() == 0;
    }



    async attemptAnyMatch(gameinfo, list) {

        let game_slug = gameinfo.game_slug;
        let mode = 'experimental';

        //make sure our first node exists
        let cur = list.first();
        if (cur == null)
            return false; //this should happen, but its here just in case

        //get mode data for rating radius spread
        let modeInfos = await storage.getModes();
        let modeId = await rooms.getGameModeID(mode);
        let modeInfo = modeInfos[modeId];
        let modeData = modeInfo.data || {};
        let attemptKey = mode + "/" + game_slug;

        //default the attempts counter
        if (typeof this.attempts[attemptKey] === 'undefined') {
            this.attempts[attemptKey] = 0;
        }


        let depth = this.attempts[attemptKey];
        let delta = modeData.delta || 50;
        let threshold = modeData.threshold || 200;
        let offset = threshold + (delta * depth);
        let lobbies = new Array(1);

        //Build lobbies by grouping parties based on party rating
        list.forEach((captain, i, lst, node) => {

            if (!this.queuedParties[captain] || !this.queuedParties[captain][attemptKey])
                return;

            let party = this.queuedParties[captain][attemptKey];
            if (!party)
                return;

            if (!party.players || party.players.length == 0) {
                //leave queue here
            }


            let lobbyId = 0;//parseInt(Math.ceil(party.rating / offset));
            console.log("[" + captain + "] = ", lobbyId, party.rating)

            if (!Array.isArray(lobbies[lobbyId]))
                lobbies[lobbyId] = [];
            lobbies[lobbyId].push(party);
        })


        //create the partySizes of all players in the queue for this mode/game_slug
        for (const lobby of lobbies) {
            if (!lobby)
                continue;
            let chosenParties = await this.buildRoomsFromLobby(lobby, gameinfo, mode, []);

            for (const captain of chosenParties) {

                this.leaveFromQueue(captain);

            }
        }

        //increase the attempt count so we can widen the range of player compatibiity
        this.attempts[attemptKey]++;

        //no more players, cleanup this queue
        if (list.size() == 0) {
            console.log("List size == 0, cleanup queue", game_slug, mode);
            let attemptKey = mode + " " + game_slug;
            delete this.attempts[attemptKey];
            delete this.queues[attemptKey];
        }

        return list.size() == 0;
    }

    async buildRoomsFromLobby(lobby, gameinfo, mode, chosenParties) {

        chosenParties = chosenParties || [];

        let key = mode + '/' + gameinfo.game_slug;

        let teamsBySize = this.createTeamsBySize(gameinfo);

        let partiesBySize = [];

        let originalLobbySize = 0;

        //build party list to sort the lobby by party size
        for (const party of lobby) {
            if (!this.queuedParties[party.captain] || !this.queuedParties[party.captain][key])
                continue;

            // let qparty = this.queuedParties[party.captain][key];
            originalLobbySize += party.players.length;
            partiesBySize.push(party);
        }

        //sort parties by size in descending order, so we can join largest parties first
        partiesBySize.sort((a, b) => {
            return b.players.length - a.players.length;
        })

        // let parties = [];
        let newLobby = [];
        let tempChosenParties = [];
        let remainingPlayers = 0;
        //loop through all parties in the queue
        for (const party of partiesBySize) {
            let validTeams = [];

            //grab the valid teams this party can join
            //the vacancy + threshold must be bigger than maxTeamSize for this game
            for (const team of teamsBySize) {
                // let playerlimit = team.vacancy + party.threshold;
                if (party.players.length <= team.vacancy) {
                    validTeams.push(team);
                }
            }

            //no valid teams for this party, skip and go to next party
            if (validTeams.length == 0) {
                newLobby.push(party);
                remainingPlayers += party.players.length;
                continue;
            }

            //ascending order by vacancy, so we fill up teams with people first
            validTeams.sort((a, b) => a.vacancy - b.vacancy)

            let selectedTeam = validTeams[0];// validTeams[Math.floor(Math.random() * validTeams.length)];
            // let partyPlayers = [...party.players];
            // let { selected, spectators } = this.selectRandomPlayers(partyPlayers, selectedTeam.vacancy);

            //move players into the team
            for (const player of party.players) {
                // let player = party.players[shortid];
                selectedTeam.players.push({ shortid: player.shortid, displayname: player.displayname, rating: player.rating });
            }

            selectedTeam.captains.push(party.captain);
            // selectedTeam.parties.push(party);

            if (!selectedTeam.parties) {
                selectedTeam.parties = [];
            }
            // 


            //move unselected players to spectators
            // for (const player of spectators)
            //     selectedTeam.spectators.push(player);

            //update team vacancy count
            selectedTeam.vacancy = selectedTeam.maxplayers - selectedTeam.players.length;
        }

        //make sure all teams have minimum player requirements
        let failedTeams = [];
        let passedTeams = [];
        let totalPlayers = 0;
        for (const team of teamsBySize) {
            if (team.players.length < team.minplayers) {
                failedTeams.push(team);

                for (const captain of team.captains) {
                    let party = this.queuedParties[captain][key];
                    if (party) {
                        newLobby = newLobby.push(party);
                    }
                }
                remainingPlayers += team.players.length;
            } else {
                passedTeams.push(team);
                totalPlayers += team.players.length;

                tempChosenParties = tempChosenParties.concat(team.captains);
            }
        }

        if (passedTeams.length >= gameinfo.minteams && totalPlayers >= gameinfo.minplayers) {
            await this.createGameAndJoinPlayers(gameinfo, mode, teamsBySize);
            console.warn("Created Game Room: ", teamsBySize);

            chosenParties = chosenParties.concat(tempChosenParties);
            if (remainingPlayers >= gameinfo.minplayers && remainingPlayers != originalLobbySize) {
                chosenParties = await this.buildRoomsFromLobby(newLobby, gameinfo, mode, chosenParties);
            }
        }



        return chosenParties;
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


    async createGameAndJoinPlayers(gameinfo, mode, gameroom) {

        let owner = null;
        let actions = [];
        let highestRating = 0;

        let shortids = [];
        for (const team of gameroom) {

            if (owner == null && team.players.length > 0) {
                owner = team.players[0].shortid;
            }

            for (const player of team.players) {


                let action = { type: 'join', user: {} };
                action.user.id = player.shortid;
                action.user.displayname = player.displayname;
                action.user.rating = player.rating;

                shortids.push(player.shortid);

                if (player.rating > highestRating)
                    highestRating = player.rating;

                actions.push(action);

                if (!gameinfo.maxteams)
                    continue;

                action.user.team_slug = team.team_slug;

            }


        }

        //create room using the first player in lobby
        let room = await this.createRoom(gameinfo.game_slug, mode, owner, highestRating);
        let room_slug = room.room_slug;

        for (let action of actions) {
            action.room_slug = room_slug;
        }

        await this.sendJoinRequest(gameinfo, room_slug, actions);
        await this.assignAndNotify(gameinfo, shortids, room_slug);
    }

    async assignAndNotify(gameinfo, shortids, room_slug) {
        console.log("Assign and Notify: ", shortids, room_slug);

        try {
            await rooms.assignPlayersToRoom(shortids, room_slug, gameinfo.game_slug);
        }
        catch (e) {
            console.error(e);
        }

        try {

            await rooms.notifyPlayerRoom(room_slug, gameinfo);
        }
        catch (e) {
            console.error(e);
        }


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

    async sendJoinRequest(gameinfo, room_slug, actions) {
        try {
            let game_slug = gameinfo.game_slug;
            let teams = gameinfo.teamlist || [];
            await rabbitmq.publishQueue('loadGame', { game_slug, room_slug, actions, teams })

            await rabbitmq.publishQueue('notifyDiscord', {
                'type': 'join',
                actions,
                game_title: (gameinfo?.name || game_slug),
                game_slug,
                room_slug,
                teams,
                thumbnail: (gameinfo?.preview_images || '')
            })
        }
        catch (e) {
            console.error(e);
        }
    }


    async addToQueueOLD(shortid, username, game_slug, mode, skipRedis) {

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


        //notify chats that someone has joined a queue
        let gameinfo = await storage.getGameInfo(game_slug);
        if (gameinfo && gameinfo.maxplayers > 1) {
            await rabbitmq.publishQueue('notifyDiscord', { 'type': 'queue', shortid, username, game_title: (gameinfo?.name || game_slug), game_slug, mode, thumbnail: (gameinfo?.preview_images || '') })
        }




        //check if mode exist
        let queuesMode = this.queues[mode];
        if (!queuesMode) {
            console.log("Queue for mode does not exist: ", mode);
            this.queues[mode] = {};
        }

        //check if queue doubly-linked list exists, if not create one
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

        //save user into the queue list on redis
        try {
            if (!skipRedis) {
                redis.sadd('queues/' + mode + '/' + game_slug, shortid);
            }
        }
        catch (e) {
            console.error(e);
        }



        //update player queue with their linked list node and rating 
        if (mode == 'rank') {
            let rating = await rooms.findPlayerRating(shortid, game_slug);
            console.log("[RANK] Found player rating: ", rating);
            let node = list.push(shortid);
            playerQueues[mode][game_slug] = { rating: rating.rating, node };
        }
        //update player queue with the linked list node
        else {
            console.log("[" + mode + "] adding user to queue: ", shortid, mode, game_slug);
            let node = list.push(shortid);
            playerQueues[mode][game_slug] = { node };
        }


        //update the player queue count
        try {
            if (!skipRedis) {
                redis.hset('queueCount', game_slug, list.size());
            }
        }
        catch (e) {
            console.error(e);
        }

        //make sure its saved back to the player object
        this.players[shortid] = playerQueues;

        //attempt to match players every time someone is added to queue
        await this.retryMatchPlayers(mode, game_slug);
    }
}




function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

let fakeusers = require('./fakeusers_final')

async function start() {

    while (!(rabbitmq.isActive() && redis.isActive)) {

        console.warn("[GameReceiver] waiting on rabbitmq and redis...");
        await sleep(1000);
        //return;
    }
    // let teamid = payload.teamid;
    // let players = payload.players;
    // let captain = payload.captain;

    let q = new QueueManager();

    let teams = [];

    for (let i = 0; i < 100; i++) {
        let team = {
            players: {},
            maxplayers: Math.max(1, 1 + Math.floor((Math.random() * 10)))
        }
        teams.push(team);
    }

    for (let i = 0; i < fakeusers.length; i++) {
        let fakeuser = fakeusers[i];
        let randomTeam = teams[Math.floor(Math.random() * teams.length)]
        if (randomTeam) {

            let shortids = Object.keys(randomTeam.players);
            if (shortids.length >= randomTeam.maxplayers) {
                i--; //repeat until another team found
                continue;
            }

            if (!randomTeam.captain)
                randomTeam.captain = fakeuser.shortid;

            randomTeam.players[fakeuser.shortid] = fakeuser.displayname;
        }

    }

    for (const team of teams) {
        let teamid = await q.onAddToTeam(team);
        if (teamid) {
            team.teamid = teamid;
        }
    }
    // console.log("Created teams:", teams);

    // let teamid = msg.teamid;
    // let queues = msg.queues;
    // let players = msg.players;
    // let captain = msg.captain;

    for (const team of teams) {

        let players = [];
        for (const shortid in team.players) {
            players.push({ shortid, displayname: team.players[shortid] })
        }

        let queues = [{ mode: 'rank', game_slug: 'test-4' }]
        let captain = team.captain;
        let teamid = team.teamid;
        await q.onAddToQueue({ captain, queues, teamid })

    }
    // for (const user of fakeusers) {
    //     let displayname = user.username;
    //     await person.createUser({ displayname })
    // }


    // test();
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