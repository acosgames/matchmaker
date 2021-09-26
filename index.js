// const WorkerManager = require('./src/workermanager');
// const wm = new WorkerManager();

const axios = require('axios');
const credutil = require('fsg-shared/util/credentials');

const playerreceiver = require('./src/playerreceiver');


axios.interceptors.response.use(
    response => {
        return response
    },
    error => {
        if (!error.response) {
            console.log("Waiting on fsg-api to be online...");
        }

        return Promise.reject(error)
    }
)

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function start() {

    let credentials = credutil();
    let url = credentials.platform.api.url;
    while (true) {

        try {
            let response = await axios.get(url)
            if (response)
                break;
        }
        catch (e) { }

        await sleep(2000);
    }


    // wm.connect();

    await playerreceiver.start();
    console.log("[MatchMaker] STARTED @ " + (new Date()).toString());
}

start();


process.on('SIGINT', function () {
    console.log('SIGINT');
    process.exit();
});



