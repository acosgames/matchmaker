import rabbitmq from "shared/services/rabbitmq.js";
import redis from "shared/services/redis.js";
import profiler from "shared/util/profiler.js";
import events from "./events.js";
import queuemanager from "./queuemanager.js";

class PlayerReceiver {
    constructor() {}

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    start() {
        return new Promise(async (rs, rj) => {
            while (!rabbitmq.isActive() || !redis.isActive()) {
                console.warn("[MatchMaker] waiting on rabbitmq and redis...");
                await this.sleep(1000);
            }

            await queuemanager.loadQueues();

            await rabbitmq.subscribeQueue(
                "leaveParty",
                this.onLeaveParty.bind(this)
            );
            await rabbitmq.subscribeQueue(
                "joinParty",
                this.onJoinParty.bind(this)
            );
            await rabbitmq.subscribeQueue(
                "joinQueue",
                this.onJoinQueue.bind(this)
            );
            await rabbitmq.subscribeQueue(
                "leaveQueue",
                this.onLeaveQueue.bind(this)
            );
            rs(true);
        });
    }

    async onLeaveParty(msg) {
        events.emitOnLeaveParty(msg);
    }
    async onJoinParty(msg) {
        events.emitOnJoinParty(msg);
    }
    async onJoinQueue(msg) {
        events.emitOnJoinQueue(msg);
    }
    async onLeaveQueue(msg) {
        events.emitOnLeaveQueue(msg);
    }
}

export default new PlayerReceiver();
