
const events = require('events');
const emitter = new events.EventEmitter();

class Events {

    constructor() { }

    addOnLeavePartyListener(func) {
        emitter.on('onLeaveParty', func);
    }

    emitOnLeaveParty(payload) {
        emitter.emit('onLeaveParty', payload);
    }

    addOnJoinQueueListener(func) {
        emitter.on('onJoinQueue', func);
    }

    addOnJoinPartyListener(func) {
        emitter.on('onJoinParty', func);
    }

    emitOnJoinParty(payload) {
        emitter.emit('onJoinParty', payload);
    }

    emitOnJoinQueue(payload) {
        emitter.emit('onJoinQueue', payload);
    }

    addOnLeaveQueueListener(func) {
        emitter.on('onLeaveQueue', func);
    }

    emitOnLeaveQueue(payload) {
        emitter.emit('onLeaveQueue', payload);
    }

}

module.exports = new Events();