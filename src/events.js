
const events = require('events');
const emitter = new events.EventEmitter();

class Events {

    constructor() { }

    addOnLeaveTeamListener(func) {
        emitter.on('onLeaveTeam', func);
    }

    emitOnLeaveTeam(payload) {
        emitter.emit('onLeaveTeam', payload);
    }

    addOnJoinQueueListener(func) {
        emitter.on('onJoinQueue', func);
    }

    addOnJoinTeamListener(func) {
        emitter.on('onJoinTeam', func);
    }

    emitOnJoinTeam(payload) {
        emitter.emit('onJoinTeam', payload);
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