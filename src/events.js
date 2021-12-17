
const events = require('events');
const emitter = new events.EventEmitter();

class Events {

    constructor() { }


    addAddToQueueListener(func) {
        emitter.on('onJoinQueue', func);
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