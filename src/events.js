
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

    addRemoveFromQueueListener(func) {
        emitter.on('onRemoveQueue', func);
    }

    emitRemoveFromQueue(payload) {
        emitter.emit('onRemoveQueue', payload);
    }

}

module.exports = new Events();