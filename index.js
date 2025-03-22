#!/usr/bin/env -S node --trace-warnings
import net from 'node:net';
import { Repeater } from '@repeaterjs/repeater';
import fs from 'node:fs/promises';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';
import { Temporal } from '@js-temporal/polyfill';
import wifi from 'node-wifi';

const LEDCONTROL_ENDPOINT = 'aris-raspi.local'; // same as LEDControl web interface page
const WIFI_SSID = 'Sugar Shack'; // only run module if on specific ssid; if empty, run always

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exec = promisify(execCb);

const palettesList = [
    0, 20,  50,  51,  60,  61,
    70,  80,  90, 100, 101, 102, 200,
    210, 220, 230, 240, 250, 260, 270,
    280, 290, 500
];

// led-control palette averages for the default palettes
// should probably have a mechanism to update it whenever
// the server has new palette info
const palettes = {
    0: ['#ffb313', '#ff0e7e', '#467cff'],
    20: ['#ff3555', '#7b5dfe', '#0efbff'],
    50: ['#ff6e56', '#7bcfff', '#2b4cff'],
    51: ['#ff6043', '#ff92ec', '#296eff'],
    60: ['#ff7446', '#ff88bd', '#8136ff'],
    61: ['#ffad1e', '#88f3ff', '#3165ff'],
    70: ['#ff0000', '#ff8585', '#00adfe'],
    80: ['#ff0000', '#af00ff', '#0068ff'],
    90: ['#ffecd9', '#e02eff', '#8dc8ff'],
    100: ['#fe0062', '#fe698b', '#18ffbc'],
    101: ['#c90dff', '#fe4b99', '#0ae8ff'],
    102: ['#fecf42', '#ff5054', '#01f0ff'],
    200: ['#2068ff', '#309aff', '#84ceff'],
    210: ['#7901ff', '#0114ff', '#7768ff'],
    220: ['#ae41ff', '#3276ff', '#53cdff'],
    230: ['#ff5e9f', '#4753ff', '#8b13fe'],
    240: ['#ff0020', '#ff2079', '#ff4679'],
    250: ['#ff3082', '#ff3970', '#8dc8ff'],
    260: ['#ff5e53', '#ff5579', '#ff4de9'],
    270: ['#ff539b', '#ff4242', '#ffcc5e'],
    280: ['#ff0000', '#ff534e', '#ff8a00'],
    290: ['#ff7832', '#ff9e5b', '#fef480'],
    500: ['#ff0000', '#00ffff', '#ff0002']
};

const post = async(data) => {
    return await fetch('http://' + LEDCONTROL_ENDPOINT + '/updatesettings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
};

async function ssidCheck() {
    if (WIFI_SSID === '') return;
    else {
        wifi.init({ iface: 'wlp0s20f3' }); // should probably auto-detect or provide a config option
        const connections = await wifi.getCurrentConnections();
        if (connections.length !== 1) {
            console.error(`Unsupported number of wifi connections (${connections.length})`);
            process.exit(1);
        }
        else {
            if (connections[0].ssid !== WIFI_SSID) {
                console.error('Not running under unknown ssid ' + connections[0].ssid);
                process.exit(1);
            }
            else return;
        }
    }
}

async function socketLoop() {
    // Function-scope / loop-scope variables
    let configUpdateRepeater, // Repeater for config update
        ipc, // node:net server for ipc via IPC_FILE
        ipcMessages, // Repeater for ipc stream
        errStream, // node:fs write stream for error file (IPC_FILE + '.log')
        startAnimInterval; 
    // Hope no one else is using this
    const IPC_FILE = '/tmp/waybar-led';

    try {
        const fd = await fs.open(IPC_FILE + '.log', 'a');
        errStream = fd.createWriteStream();
    }
    catch (e) {
        console.error('Error opening logfile', e);
        process.exit(1);
    }
    errStream.on('error', e => { throw e; });

    const writeError = (...e) => {
        const now = Temporal.Now.plainDateTimeISO().toString().split('.')[0];
        if (!errStream.writableEnded) errStream.write(`[${now}] ${e.join(' ')}\n`);
        else console.error(`[${now}]`, ...e);
    };
    const errStreamClose = signal => {
        writeError(`Quitting (${signal})`);
        errStream.end();
        process.exit(0);
    }
    process.on('SIGINT', () => errStreamClose('SIGINT'));
    process.on('SIGQUIT', () => errStreamClose('SIGQUIT'));
    process.on('SIGTERM', () => errStreamClose('SIGTERM'));
    process.on('exit', code => {
        console.trace('Process exiting with code ' + code);
    });

    writeError('---------');
    writeError('Starting...');
    
    try {
        console.log('...');
        let i = 0;
        startAnimInterval = setInterval(() => {
            if (i % 3 === 0) console.log('/..');
            else if (i % 3 === 1) console.log('.-.');
            else if (i % 3 === 2) console.log('..\\');
            i++;
        }, 500);
        ipc = net.createServer();
        ipcMessages = new Repeater(async(push, stop) => {
            let connections = 0, conn;
            ipc.listen(IPC_FILE);
            
            ipc.on('close', () => {
                connections = 0;
                stop(new Error('IPC socket ended unexpectedly'));
            });
            ipc.on('error', (e) => {
                ipc.close();
                stop(e);
            });
            ipc.on('connection', sock => {
                if (connections !== 0) {
                    return;
                }
                connections++;
                conn = sock;
                conn.setEncoding('utf8');
                conn.on('close', () => connections--);
                conn.on('error', e => stop(e));
                conn.on('data', data => push(data));
            });
            await stop;
            conn?.destroy();
            await ipc[Symbol.asyncDispose]();
        });
        configUpdateRepeater = new Repeater(async(push, stop) => {
            setInterval(async() => {
                try {
                    let currentConfig = await fetch('http://' + LEDCONTROL_ENDPOINT + "/getsettings");
                    push(await currentConfig.text());
                }
                catch (e) {
                    stop(e);
                }
            }, 1000);
        });

        const isJson = text => {
            try {
                return JSON.parse(text);
            }
            catch {
                return false;
            }
        };

        let currentConfig;
        // This loop lasts until either of these Repeaters stop
        // sending messages, which should only happen on error
        for await (const msg of Repeater.merge([configUpdateRepeater, ipcMessages])) {
            let config = isJson(msg);
            if (config !== false) {
                currentConfig = config;
                if (startAnimInterval) {
                    clearInterval(startAnimInterval);
                    startAnimInterval = false;
                }
                if (config.on === 0) {
                    console.log('×');
                }
                else {
                    const palette = palettes[config.groups.main.palette] || ['#000000', '#000000', '#000000'];
                    console.log(`<span color='${palette[0]}' rise='0.1pt'></span><span color='${palette[1]}' rise='0.1pt'></span><span color='${palette[2]}' rise='0.1pt'></span> ${(config.global_brightness.toFixed(2) * 100).toFixed(0)}%`);
                }
                // format: if on: {  } (three circles for palette) { brightness % }
                // format: if off: ×
            }
            else {
                switch (msg) {
                    case 'palette_up':
                        await post({ groups: { main: { palette: palettesList[palettesList.indexOf(currentConfig.groups.main.palette) + 1] ?? 0 }}});
                        continue;
                    case 'palette_down':
                        await post({ groups: { main: { palette: palettesList[palettesList.indexOf(currentConfig.groups.main.palette) - 1] ?? 500 }}});
                        continue;
                    case 'brightness_up':
                        await post({ global_brightness: currentConfig.global_brightness + 0.1 > 1 ? 1 : +(currentConfig.global_brightness + 0.1).toFixed(2) });
                        continue;
                    case 'brightness_down':
                        await post({ global_brightness: currentConfig.global_brightness - 0.1 < 0 ? 0 : +(currentConfig.global_brightness - 0.1).toFixed(2) });
                        continue;
                    case 'power':
                        await post({ on: currentConfig.on === 1 ? 0 : 1});
                        continue;
                    default:
                        throw new Error('Unknown IPC message ' + msg);
                }
            }
        }
        // Throw if the loop ends, just in case it does
        // without throwing on its own
        throw new Error('Loop ended unexpectedly');
    }
    catch (e) {
        // Stop the loading animation
        clearInterval(startAnimInterval);
        // Clean up server connections
        ipc?.close();
        errStream?.end();
        // Clean up termination listeners
        process.removeAllListeners('SIGINT');
        process.removeAllListeners('SIGQUIT');
        process.removeAllListeners('SIGTERM');
        process.removeAllListeners('exit');
        // If the error is due to the ipc connection failing
        // because a previous process didn't clean up properly,
        // delete the old ipc file, but only if no other process
        // is still using it
        if (e?.code === 'EADDRINUSE') {
            try {
                const lsof = await exec('lsof ' + IPC_FILE);
                writeError('Someone else is using', IPC_FILE + '\n' + lsof.stdout);
            }
            catch (e) {
                if (e?.code === 0) { // someone else is using this socket, continue to the rest of the error handler
                }
                else { // no one else is using this socket, we can delete it
                    writeError('Deleting old ' + IPC_FILE);
                    await fs.rm(IPC_FILE); // if this fails, it requires
                    // manual intervention anyway (a `chmod +w IPC_FILE`
                    // should suffice)
                    return; // breaks out of the loop (effectively a `continue`)
                }
            }
        }
        writeError('main async iterator loop error', e?.code, e?.message);
        writeError('Restarting in 1s...');
        console.log('~~~');
    }
    return sleep(1000);
}

try {
    while (true) {
        await ssidCheck();
        await socketLoop();
    }
}
catch (e) {
    console.error('Uncaught module error', e);
    process.exit(1);
}
