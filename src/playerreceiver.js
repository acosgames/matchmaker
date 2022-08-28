const rabbitmq = require('shared/services/rabbitmq');
const redis = require('shared/services/redis');
const profiler = require('shared/util/profiler');
const events = require('./events');
const queuemanager = require('./queuemanager');

class PlayerReceiver {

    constructor() {

    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    start() {
        return new Promise(async (rs, rj) => {
            while (!rabbitmq.isActive() || !redis.isActive) {
                console.warn("[MatchMaker] waiting on rabbitmq and redis...");
                await this.sleep(1000);
            }


            await queuemanager.loadQueues();

            await rabbitmq.subscribeQueue('leaveTeam', this.onLeaveTeam.bind(this));
            await rabbitmq.subscribeQueue('joinTeam', this.onJoinTeam.bind(this));
            await rabbitmq.subscribeQueue('joinQueue', this.onJoinQueue.bind(this));
            await rabbitmq.subscribeQueue('leaveQueue', this.onLeaveQueue.bind(this));
            rs(true);
        })
    }

    async onLeaveTeam(msg) {
        events.emitLeaveFromTeam(msg);
    }
    async onJoinTeam(msg) {
        events.emitAddToTeam(msg);
    }
    async onJoinQueue(msg) {
        events.emitAddToQueue(msg);
    }
    async onLeaveQueue(msg) {
        events.emitLeaveFromQueue(msg);
    }
}

module.exports = new PlayerReceiver();