
const events = require('events');
const emitter = new events.EventEmitter();

class Events {

    constructor() { }

    addLeaveFromTeamListener(func) {
        emitter.on('onLeaveTeam', func);
    }

    emitLeaveFromTeam(payload) {
        emitter.emit('onLeaveTeam', payload);
    }

    addAddToQueueListener(func) {
        emitter.on('onJoinQueue', func);
    }

    addAddToTeamListener(func) {
        emitter.on('onJoinTeam', func);
    }

    emitAddToTeam(payload) {
        emitter.emit('onJoinTeam', payload);
    }

    emitAddToQueue(payload) {
        emitter.emit('onJoinQueue', payload);
    }

    addLeaveFromQueueListener(func) {
        emitter.on('onLeaveQueue', func);
    }

    emitLeaveFromQueue(payload) {
        emitter.emit('onLeaveQueue', payload);
    }

}

module.exports = new Events();