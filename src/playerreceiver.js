const rabbitmq = require('fsg-shared/services/rabbitmq');
const redis = require('fsg-shared/services/redis');
const profiler = require('fsg-shared/util/profiler');
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
            while (!(rabbitmq.isActive() && redis.isActive)) {
                console.warn("[MatchMaker] waiting on rabbitmq and redis...");
                await this.sleep(1000);
            }

            await rabbitmq.subscribeQueue('joinQueue', this.onJoinQueue.bind(this));
            await rabbitmq.subscribeQueue('removeQueue', this.onRemoveQueue.bind(this));
            rs(true);
        })
    }

    async onJoinQueue(msg) {
        events.emitAddToQueue(msg);
    }
    async onRemoveQueue(msg) {
        events.emitRemoveFromQueue(msg);
    }
}

module.exports = new PlayerReceiver();