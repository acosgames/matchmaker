const rabbitmq = require("shared/services/rabbitmq");
const redis = require("shared/services/redis");
const rooms = require("shared/services/room");
const PersonService = require("shared/services/person");
const person = new PersonService();

const profiler = require("shared/util/profiler");
const credutil = require("shared/util/credentials");
const credentials = credutil();

const events = require("./events");
const storage = require("./storage");
const axios = require("axios");

const webpush = require("web-push");

webpush.setVapidDetails(
    credentials.webpush.contact,
    credentials.webpush.publickey,
    credentials.webpush.privatekey
);

const { genShortId } = require("shared/util/idgen");

const yallist = require("./yallist");

class QueueManager {
    constructor() {
        this.timeouts = {};
        this.queues = {};
        this.players = {};
        this.playerNames = {};
        this.attempts = {};

        this.queuedParties = {};
        this.partyNodes = {};

        this.queueSizes = {};
        this.queueSizesTimeout = 0;
        this.queueSizesRestartCount = 0;

        this.teams = {};

        this.processed = {};
        this.count = 0;

        events.addOnLeavePartyListener(this.onLeaveParty.bind(this));
        events.addOnJoinPartyListener(this.onJoinParty.bind(this));
        events.addOnJoinQueueListener(this.onJoinQueue.bind(this));
        events.addOnLeaveQueueListener(this.onOnLeaveQueue.bind(this));
    }

    async loadQueues() {
        try {
            let queuedParties = await redis.hgetall("queuedParties");

            for (let captain in queuedParties) {
                let party = queuedParties[captain];
                this.onJoinQueue(party);
            }
        } catch (e) {
            console.error(e);
        }
    }

    isObject(x) {
        return (
            x != null &&
            (typeof x === "object" || typeof x === "function") &&
            !Array.isArray(x)
        );
    }

    async onJoinParty(payload) {
        let partyid = payload.partyid;
        let players = payload.players;
        let captain = payload.captain;

        if (!players || !Array.isArray(players) || players.length == 0) {
            return false;
        }

        if (!partyid) {
            partyid = genShortId(8);
        }

        //check if we have existing party
        let partyinfo = (await storage.getParty(partyid)) || {
            partyid,
            players,
            captain,
        };

        //update the players
        partyinfo.players = players;

        //update our party roster
        storage.setParty(partyid, partyinfo);

        //let users know their party was updated
        rabbitmq.publish("ws", "joinedTeam", partyinfo);

        return partyid;
    }

    async onLeaveParty(payload) {
        let partyid = payload.partyid;
        let shortid = payload.shortid;

        let partyinfo = await storage.getParty(partyid);
        if (!partyinfo) return;

        if (partyinfo?.players[shortid]) {
            delete partyinfo.players[shortid];
        }

        if (partyinfo?.captain == shortid) {
            let playerList = Object.keys(partyinfo.players);
            partyinfo.captain =
                playerList[Math.floor(Math.random() * playerList.length)];
        }

        if (partyinfo?.players?.length <= 1) {
            storage.deleteTeam(partyid);
        } else {
            storage.setParty(partyid, partyinfo);
        }

        rabbitmq.publish("ws", "leaveParty", partyinfo);
    }

    createPlayerQueueMap() {
        return { rank: {}, experimental: {}, public: {}, private: {} };
    }

    async onOnLeaveQueue(msg) {
        let shortid = msg.user.shortid;

        console.log("onOnLeaveQueue", JSON.stringify(msg, null, 2));

        this.OnLeaveQueue(shortid);
    }

    async calculateQueueSizes() {
        if (this.queueSizesTimeout) {
            clearTimeout(this.queueSizesTimeout);
        }
        if (this.queueSizesRestartCount >= 10) {
            this.queueSizesRestartCount = 0;
            this.broadcastQueueStats();
        } else {
            this.queueSizesRestartCount++;
            this.queueSizesTimeout = setTimeout(
                this.broadcastQueueStats,
                1000 * this.queueSizesRestartCount
            );
        }

        return this.queueSizes;
    }

    broadcastQueueStats = async () => {
        console.log(
            "queuedParties:",
            JSON.stringify(this.queuedParties, null, 2)
        );
        this.queueSizes = {};
        for (let key in this.queues) {
            let parts = key.split("/");
            let game_slug = parts[parts.length - 1];
            let mode = parts[0];

            let gameinfo = await storage.getGameInfo(game_slug);
            let list = this.queues[key];

            if (list.length == 0) {
                continue;
            }
            list.forEach((captain) => {
                if (!this.queuedParties[captain]) {
                    return;
                }
                let party = this.queuedParties[captain];
                if (!(key in this.queueSizes))
                    this.queueSizes[key] = {
                        name: gameinfo.name,
                        preview_image: gameinfo.preview_images,
                        count: 0,
                    };

                // if (type == 'add')
                console.log("Adding", key, party.captain, party.players.length);
                this.queueSizes[key].count += party?.players?.length || 0;

                // else
                // this.queueSizes[key] -= party?.players?.length || 0;
            });
            console.log(
                "queueSizes: ",
                JSON.stringify(this.queueSizes, null, 2)
            );
        }

        this.queueSizes.type = "queueStats";
        rabbitmq.publish("ws", "onQueueUpdate", this.queueSizes);
        this.queueSizesRestartCount = 0;
    };

    async OnLeaveQueue(captain) {
        let party = this.queuedParties[captain];

        if (!party) {
            console.warn("[OnLeaveQueue] Captain not in party list: ", captain);
            return;
        }

        try {
            for (let i = 0; i < party.players.length; i++) {
                let player = party.players[i];
                if (player.shortid in this.players)
                    delete this.players[player.shortid];
            }
        } catch (e) {
            console.error(e);
        }

        await redis.hdel("queuedParties", party.captain);

        for (const queue of party.queues) {
            await rabbitmq.publishQueue("notifyDiscord", {
                type: "queue",
                captain: party.captain,
                players: party.players,
                rating: queue.rating,
                game_title: party.game_slug,
                game_slug: queue.game_slug,
                mode: queue.mode,
                thumbnail: "",
            });

            let key = `${party.captain}/${queue.mode}/${queue.game_slug}`;
            let node = this.partyNodes[key];
            node.remove();
            delete this.partyNodes[key];
        }

        rabbitmq.publish("ws", "onQueueUpdate", {
            type: "removed",
            payload: party,
        });
        delete this.queuedParties[captain];
        await this.calculateQueueSizes("remove");
    }

    /**
     * Add a party into a queue (party can be 1 person or more)
     * msg.partyid
     * msg.players
     * msg.queues
     * msg.captain
     * @param {*} msg
     * @returns
     */

    async onJoinQueue(msg) {
        console.log("onJoinQueue", JSON.stringify(msg, null, 2));

        if (!msg) return false;

        let partyid = msg.partyid;
        let queues = msg.queues;
        let players = msg.players;
        let captain = msg.captain;

        //captain must be specified
        if (!msg.captain || typeof msg.captain !== "string") return false;

        //there must be players defined to continue
        if (!msg.players || msg.players.length == 0) {
            return false;
        }

        //if player is in party under a captain, don't allow them to queue
        if (
            msg.captain in this.players &&
            this.players[msg.captain] != msg.captain
        )
            return false;

        //partyid is required for player counts more than 1, if it exists find the party information
        if (msg.partyid || msg.players.length > 1) {
            let partyinfo = await storage.getParty(msg.partyid);
            if (!partyinfo) return false;

            //requestor must be the captain of the party
            if (msg.captain != partyinfo.captain) {
                return false;
            }

            //overwrite the players list sent in request (shouldn't have one but just incase),
            // because we have the party players list already

            let partyPlayers = [];
            for (const shortid in partyinfo.players) {
                partyPlayers.push({
                    shortid,
                    displayname: partyinfo.players[shortid],
                });
            }
            msg.players = partyPlayers;
        }

        let existingParty = this.queuedParties[msg.captain];
        // if (existingParty) {
        //     for (let queue of existingParty.queues) {
        //         if (!msg.queues.find(q => q.game_slug == queue.game_slug && q.mode == queue.mode))
        //             msg.queues.push(queue);
        //     }
        // }

        //builds a group for every mode/game_slug pair
        let party = {
            captain,
            players,
            partyid,
            threshold: existingParty?.threshold || 0,
            createDate: existingParty?.createDate || Date.now(),
            queues: existingParty?.queues || [],
        };

        //builds shortid and game_slug lists to query player ratings of group
        let shortids = [];
        let game_slugs = [];
        //existing party queues
        for (const queue of party.queues) game_slugs.push(queue.game_slug);
        for (const queue of msg.queues)
            if (!game_slugs.find((gs) => gs == queue.game_slug))
                game_slugs.push(queue.game_slug);
        for (const player of msg.players) shortids.push(player.shortid);

        //find all player ratings for each game being queued
        let groupRatings = await rooms.findGroupRatings(shortids, game_slugs);

        for (const queue of msg.queues) {
            if (party.queues.find((q) => q.game_slug == queue.game_slug))
                continue;
            let gameinfo = await storage.getGameInfo(queue.game_slug);
            queue.preview_image = gameinfo.preview_images;
            queue.name = gameinfo.name;

            party.queues.push(queue);
        }

        //set party ratings for each game
        for (let queue of party.queues) {
            let game_slug = queue.game_slug;

            let groupRating = 0;
            let minRating = Number.MAX_SAFE_INTEGER;
            let maxRating = 0;
            for (let player of party.players) {
                let playerRating = groupRatings[player.shortid][game_slug];
                player.rating = playerRating.rating;

                if (player.rating < minRating) minRating = player.rating;

                if (player.rating > maxRating) maxRating = player.rating;

                groupRating += player.rating;

                this.players[player.shortid] = party.captain;
            }

            //group rating is average + 50% of the way to highest ranked player
            let groupRatingAverage = groupRating / party.players.length;
            groupRating =
                groupRatingAverage + (maxRating - groupRatingAverage) * 0.5;

            queue.rating = groupRating;

            this.addToQueue(party, queue);
        }

        rabbitmq.publish("ws", "onQueueUpdate", {
            type: "added",
            payload: msg,
        });

        await this.calculateQueueSizes("add");
    }

    async addToQueue(party, queue, skipRedis) {
        // captain already in queue, clear out old queue, and add new
        let nodeKey = `${party.captain}/${queue.mode}/${queue.game_slug}`;
        if (nodeKey in this.partyNodes) {
            if (!(party.captain in this.queuedParties)) {
                this.partyNodes[nodeKey].remove();
                delete this.partyNodes[nodeKey];
            } else {
                console.warn("Captain already in queue: ", party.captain);
                return;
            }
        }

        this.queuedParties[party.captain] = party;
        let key = queue.mode + "/" + queue.game_slug;

        await redis.hset("queuedParties", party.captain, party);

        if (!(key in this.queues)) this.queues[key] = yallist.create();

        let list = this.queues[key];
        let node = list.push(party.captain);
        this.partyNodes[nodeKey] = node;

        //notify chats that someone has joined a queue
        let gameinfo = await storage.getGameInfo(queue.game_slug);
        if (gameinfo && gameinfo.maxplayers > 1) {
            await rabbitmq.publishQueue("notifyDiscord", {
                type: "queue",
                captain: party.captain,
                players: party.players,
                rating: party.rating,
                game_title: gameinfo?.name || queue.game_slug,
                game_slug: queue.game_slug,
                mode: queue.mode,
                thumbnail: gameinfo?.preview_images || "",
            });
        }

        await this.retryMatchPlayers(queue.mode, queue.game_slug, true);
    }

    async retryMatchPlayers(mode, game_slug, skipTimer) {
        let modeId = await rooms.getGameModeID(mode);
        let modeInfos = await storage.getModes();
        let modeInfo = modeInfos[modeId];
        let modeData = modeInfo.data || {};
        let retryDelay = modeData.retryDelay || 2000;
        let timeoutKey = mode + "/" + game_slug;
        let timeoutHandle = this.timeouts[timeoutKey] || 0;

        //only allow a single settimeout to keep attempting rank convergence
        if (timeoutHandle > 0) {
            clearTimeout(this.timeouts[timeoutKey]);
            this.timeouts[timeoutKey] = 0;
        }

        //match players together for specific mode/game_slug
        if (skipTimer) {
            this.timeouts[timeoutKey] = setTimeout(() => {
                this.matchPlayers(mode, game_slug);
            }, retryDelay / 10);
        } else {
            this.timeouts[timeoutKey] = setTimeout(() => {
                this.matchPlayers(mode, game_slug);
            }, retryDelay);
        }
    }

    async matchPlayers(mode, game_slug) {
        try {
            let key = mode + "/" + game_slug;

            let list = this.queues[key];
            if (!list || list.size() == 0) {
                console.warn("[matchPlayers] queue list does not exist: ", key);
                return false;
            }

            //grab the gameinfo so we know min/max sizes of game and game defined partys
            let gameinfo = await storage.getGameInfo(game_slug);
            if (!gameinfo) {
                console.warn(
                    "[matchPlayers] Gameinfo does not exist for: ",
                    game_slug
                );
                delete this.queues[key];
                return;
            }

            let result = false;
            //ranked matches try to match based on user ratings
            if (mode == "rank") {
                result = await this.attemptRankedMatch(gameinfo, list);
            }
            //all other matches don't matter
            else result = await this.attemptAnyMatch(gameinfo, list);

            let allPlayerCount = 0;
            //players are still in list, attempt more matches
            list.forEach((captain, i, list, node) => {
                if (!this.queuedParties[captain]) {
                    return;
                }
                let party = this.queuedParties[captain];
                allPlayerCount += party?.players?.length || 0;
            });

            //simple use case, but in future, make it more advanced based on party sizes too
            if (allPlayerCount >= gameinfo.minplayers) {
                this.retryMatchPlayers(mode, game_slug);
            }
        } catch (e) {
            console.error(e);
        }
        return false;
    }

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
        //create the game defined party vacancy sizes and player list
        //parties that have leftover players will be pushed to spectator list
        let teamsBySize = [];
        let maxTeamSize = 0;
        //free for all scenario
        if (!gameinfo.maxteams) {
            for (let i = 0; i < gameinfo.maxplayers; i++) {
                let partyid = i + 1;
                teamsBySize.push({
                    team_slug: "team_" + partyid,
                    maxplayers: 1,
                    minplayers: 1,
                    vacancy: 1,
                    players: [],
                    captains: [],
                });
            }
            maxTeamSize = 1;
        }
        //battlegrounds scenario
        else if (gameinfo.maxteams == 1) {
            let team = gameinfo.teamlist[0];
            let maxteamcount = Math.floor(
                gameinfo.maxplayers / team.maxplayers
            );
            for (let i = 0; i < maxteamcount; i++) {
                let partyid = i + 1;
                teamsBySize.push({
                    team_slug: "team_" + partyid,
                    maxplayers: team.maxplayers,
                    minplayers: team.minplayers,
                    vacancy: team.maxplayers,
                    players: [],
                    captains: [],
                });
            }
            maxTeamSize = team.maxplayers;
        }
        //traditional team scenario
        else {
            for (const team of gameinfo.teamlist) {
                if (team.maxplayers > maxTeamSize)
                    maxTeamSize = team.maxplayers;
                teamsBySize.push({
                    team_slug: team.team_slug,
                    maxplayers: team.maxplayers,
                    minplayers: team.minplayers,
                    vacancy: team.maxplayers,
                    players: [],
                    captains: [],
                });
            }
        }
        //sort in descending order, so we can fill largest vacancies first
        teamsBySize.sort((a, b) => {
            b.vacancy - a.vacancy;
        });

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
        let mode = "rank";

        //make sure our first node exists
        let cur = list.first();
        if (cur == null) return false; //this should happen, but its here just in case

        //get mode data for rating radius spread
        let modeInfos = await storage.getModes();
        let modeId = await rooms.getGameModeID(mode);
        let modeInfo = modeInfos[modeId];
        let modeData = modeInfo.data || {};
        let attemptKey = mode + "/" + game_slug;

        //default the attempts counter
        if (typeof this.attempts[attemptKey] === "undefined") {
            this.attempts[attemptKey] = 0;
        }

        let depth = this.attempts[attemptKey];
        let delta = modeData.delta || 50;
        let threshold = modeData.threshold || 200;
        let offset = threshold + delta * depth;
        let maxLobbies = Math.ceil(5000 / offset + 1);
        let lobbies = new Array(maxLobbies);

        //Build lobbies by grouping parties based on party rating
        list.forEach((captain, i, lst, node) => {
            if (!this.queuedParties[captain]) return;

            let party = this.queuedParties[captain];
            if (!party) return;

            if (!party.players || party.players.length == 0) {
                //leave queue here
            }

            let queue = party.queues.find(
                (queue) => queue.game_slug == game_slug && queue.mode == mode
            );
            if (!queue) return;
            let lobbyId = parseInt(Math.ceil(queue.rating / offset));
            console.log("[" + captain + "] = ", lobbyId, queue.rating);

            if (!Array.isArray(lobbies[lobbyId])) lobbies[lobbyId] = [];
            lobbies[lobbyId].push(party);
        });

        //create the partySizes of all players in the queue for this mode/game_slug
        for (const lobby of lobbies) {
            if (!lobby) continue;
            let chosenParties = await this.buildRoomsFromLobby(
                lobby,
                gameinfo,
                mode,
                []
            );

            for (const captain of chosenParties) {
                this.OnLeaveQueue(captain);
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
        let mode = "experimental";

        //make sure our first node exists
        let cur = list.first();
        if (cur == null) return false; //this should happen, but its here just in case

        //get mode data for rating radius spread
        let modeInfos = await storage.getModes();
        let modeId = await rooms.getGameModeID(mode);
        let modeInfo = modeInfos[modeId];
        let modeData = modeInfo.data || {};
        let attemptKey = mode + "/" + game_slug;

        //default the attempts counter
        if (typeof this.attempts[attemptKey] === "undefined") {
            this.attempts[attemptKey] = 0;
        }

        let depth = this.attempts[attemptKey];
        let delta = modeData.delta || 50;
        let threshold = modeData.threshold || 200;
        let offset = threshold + delta * depth;
        let lobbies = new Array(1);

        //Build lobbies by grouping parties based on party rating
        list.forEach((captain, i, lst, node) => {
            if (!this.queuedParties[captain]) return;

            let party = this.queuedParties[captain];
            if (!party) return;

            if (!party.players || party.players.length == 0) {
                //leave queue here
            }

            let lobbyId = 0; //parseInt(Math.ceil(party.rating / offset));
            console.log("[" + captain + "] = ", lobbyId, party.rating);

            if (!Array.isArray(lobbies[lobbyId])) lobbies[lobbyId] = [];
            lobbies[lobbyId].push(party);
        });

        //create the partySizes of all players in the queue for this mode/game_slug
        for (const lobby of lobbies) {
            if (!lobby) continue;
            let chosenParties = await this.buildRoomsFromLobby(
                lobby,
                gameinfo,
                mode,
                []
            );

            for (const captain of chosenParties) {
                this.OnLeaveQueue(captain);
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

        let key = mode + "/" + gameinfo.game_slug;

        let teamsBySize = this.createTeamsBySize(gameinfo);

        let partiesBySize = [];

        let originalLobbySize = 0;

        //build party list to sort the lobby by party size
        for (const party of lobby) {
            if (!this.queuedParties[party.captain]) continue;

            // let qparty = this.queuedParties[party.captain][key];
            originalLobbySize += party.players.length;
            partiesBySize.push(party);
        }

        //sort parties by size in descending order, so we can join largest parties first
        partiesBySize.sort((a, b) => {
            return b.players.length - a.players.length;
        });

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
            validTeams.sort((a, b) => {
                //randomize order if the vacancies match
                if (a.vacancy == b.vacancy) {
                    return Math.floor(Math.random() * 2) == 0 ? -1 : 1;
                }

                //lower vacancy first
                return a.vacancy - b.vacancy;
            });

            let selectedTeam = validTeams[0]; // validTeams[Math.floor(Math.random() * validTeams.length)];
            // let partyPlayers = [...party.players];
            // let { selected, spectators } = this.selectRandomPlayers(partyPlayers, selectedTeam.vacancy);

            //move players into the team
            for (const player of party.players) {
                // let player = party.players[shortid];
                selectedTeam.players.push({
                    shortid: player.shortid,
                    displayname: player.displayname,
                    rating: player.rating,
                    portraitid: player.portraitid,
                    countrycode: player.countrycode,
                });
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
            selectedTeam.vacancy =
                selectedTeam.maxplayers - selectedTeam.players.length;
        }

        //make sure all teams have minimum player requirements
        let failedTeams = [];
        let passedTeams = [];
        let totalPlayers = 0;
        for (const team of teamsBySize) {
            if (team.players.length < team.minplayers) {
                failedTeams.push(team);

                for (const captain of team.captains) {
                    let party = this.queuedParties[captain];
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

        if (
            passedTeams.length >= gameinfo.minteams &&
            totalPlayers >= gameinfo.minplayers
        ) {
            await this.createGameAndJoinPlayers(gameinfo, mode, teamsBySize);
            console.warn("Created Game Room: ", teamsBySize);

            chosenParties = chosenParties.concat(tempChosenParties);
            if (
                remainingPlayers >= gameinfo.minplayers &&
                remainingPlayers != originalLobbySize
            ) {
                chosenParties = await this.buildRoomsFromLobby(
                    newLobby,
                    gameinfo,
                    mode,
                    chosenParties
                );
            }
        }

        return chosenParties;
    }

    comparePlayers(a, b, depth, threshold) {
        let ratio = 1.0 - depth / 10.0;
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
                let action = { type: "join", user: {} };
                action.user.shortid = player.shortid;
                action.user.displayname = player.displayname;
                action.user.rating = player.rating;
                action.user.portraitid = player.portraitid || 1;
                action.user.countrycode = player.countrycode || "US";

                shortids.push(player.shortid);

                if (player.rating > highestRating)
                    highestRating = player.rating;

                actions.push(action);

                if (!gameinfo.maxteams) continue;

                action.user.team_slug = team.team_slug;
            }
        }

        //create room using the first player in lobby
        let room = await this.createRoom(
            gameinfo.game_slug,
            mode,
            owner,
            highestRating
        );
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
            await rooms.assignPlayersToRoom(
                shortids,
                room_slug,
                gameinfo.game_slug
            );
        } catch (e) {
            console.error(e);
        }

        try {
            await rooms.notifyPlayerRoom(room_slug, gameinfo);
        } catch (e) {
            console.error(e);
        }
    }

    async createRoom(game_slug, mode, shortid, rating) {
        if (mode != "rank") rating = 0;

        let roomMeta = await rooms.createRoom(shortid, rating, game_slug, mode);
        return roomMeta;
    }

    async sendJoinRequest(gameinfo, room_slug, actions) {
        try {
            let game_slug = gameinfo.game_slug;
            let teams = gameinfo.teamlist || [];
            await rabbitmq.publishQueue("loadGame", {
                game_slug,
                room_slug,
                actions,
                teams,
            });

            await rabbitmq.publishQueue("notifyDiscord", {
                type: "join",
                actions,
                game_title: gameinfo?.name || game_slug,
                game_slug,
                room_slug,
                teams,
                thumbnail: gameinfo?.preview_images || "",
            });
        } catch (e) {
            console.error(e);
        }
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

let fakeusers = require("./fakeusers_final");

async function start() {
    while (!(rabbitmq.isActive() && redis.isActive)) {
        console.warn("[GameReceiver] waiting on rabbitmq and redis...");
        await sleep(1000);
        //return;
    }
    // let partyid = payload.partyid;
    // let players = payload.players;
    // let captain = payload.captain;

    let q = new QueueManager();

    let teams = [];

    for (let i = 0; i < 100; i++) {
        let team = {
            players: {},
            maxplayers: Math.max(1, 1 + Math.floor(Math.random() * 10)),
        };
        teams.push(team);
    }

    for (let i = 0; i < fakeusers.length; i++) {
        let fakeuser = fakeusers[i];
        let randomTeam = teams[Math.floor(Math.random() * teams.length)];
        if (randomTeam) {
            let shortids = Object.keys(randomTeam.players);
            if (shortids.length >= randomTeam.maxplayers) {
                i--; //repeat until another team found
                continue;
            }

            if (!randomTeam.captain) randomTeam.captain = fakeuser.shortid;

            randomTeam.players[fakeuser.shortid] = fakeuser.displayname;
        }
    }

    for (const team of teams) {
        let partyid = await q.onJoinParty(team);
        if (partyid) {
            team.partyid = partyid;
        }
    }
    // console.log("Created teams:", teams);

    // let partyid = msg.partyid;
    // let queues = msg.queues;
    // let players = msg.players;
    // let captain = msg.captain;

    for (const team of teams) {
        let players = [];
        for (const shortid in team.players) {
            players.push({ shortid, displayname: team.players[shortid] });
        }

        let queues = [{ mode: "rank", game_slug: "test-4" }];
        let captain = team.captain;
        let partyid = team.partyid;
        await q.onAddToQueue({ captain, queues, partyid });
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
            game_slug: "tictactoe",
            mode: "rank",
            shortid: genShortId(5),
        };
        q.onAddToQueue(msg);
    }

    await sleep(5000);
    let msg = {
        game_slug: "tictactoe",
        mode: "rank",
        shortid: genShortId(5),
    };
    q.onAddToQueue(msg);
}

// start();

module.exports = new QueueManager();
