#!/usr/bin/env node
import WebSocket from 'ws';
import net from 'node:net';
import { Repeater } from '@repeaterjs/repeater';
import fs from 'node:fs/promises';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';
import { Temporal } from '@js-temporal/polyfill';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exec = promisify(execCb);

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

async function socketLoop() {
    let ws, wsMessages, ipc, ipcMessages, errStream, startAnimInterval;
    const IPC_FILE = '/tmp/waybar-led';
    const writeError = (...e) => {
        const now = Temporal.Now.plainDateTimeISO().toString().split('.')[0];
        if (errStream) errStream.write(`[${now}] ${e.join(' ')}\n`);
        else console.error(`[${now}]`, ...e);
    };
    try {
        const fd = await fs.open(IPC_FILE + '.log', 'a');
        errStream = fd.createWriteStream();
    }
    catch (e) {
        console.error('Error opening logfile', e);
        process.exit(1);
    }
    errStream.on('error', e => { throw e; });
    const errStreamClose = signal => {
        writeError(`Quitting (${signal})`);
        errStream?.end();
        process.exit(0);
    }
    process.on('SIGINT', () => errStreamClose('SIGINT'));
    process.on('SIGQUIT', () => errStreamClose('SIGQUIT'));
    process.on('SIGTERM', () => errStreamClose('SIGTERM'));


    writeError('---------');
    while (true) {
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
            ws = new WebSocket('ws://raspberrypi.local:8080');
            wsMessages = new Repeater(async(push, stop) => {
                ws.on('message', ev => push(ev.toString()));
                ws.on('error', e => stop(e));
                ws.on('close', () => stop(new Error('WebSocket ended unexpectedly')));
            });
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

            const isJson = text => {
                try {
                    JSON.parse(text);
                    return true;
                }
                catch (e) {
                    return false;
                }
            };

            for await (const msg of Repeater.merge([wsMessages, ipcMessages])) {
                let config;
                if (isJson(msg)) {
                    config = JSON.parse(msg);
                    if (config.on === 0) {
                        console.log('×');
                    }
                    else {
                        const palette = palettes[config.groups.main.palette] || ['#000000', '#000000', '#000000'];
                        if (startAnimInterval) {
                            clearInterval(startAnimInterval);
                            startAnimInterval = false;
                        }
                        console.log(`<span color='${palette[0]}' rise='0.1pt'></span><span color='${palette[1]}' rise='0.1pt'></span><span color='${palette[2]}' rise='0.1pt'></span> ${(config.global_brightness.toFixed(2) * 100).toFixed(0)}%`);
                    }
                    //format: if on: {  } (three circles for palette) { brightness % }
                    //format: if off: ×
                }
                else {
                    switch (msg) {
                        case 'palette_up':
                        case 'palette_down':
                        case 'brightness_up':
                        case 'brightness_down':
                        case 'power':
                            ws.send(msg);
                            continue;
                        default:
                            throw new Error('Unknown IPC message ' + msg);
                    }
                }
            }
            throw new Error('Loop ended unexpectedly');
        }
        catch (e) {
            clearInterval(startAnimInterval);
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
                        await fs.rm(IPC_FILE);
                        continue;
                    }
                }
            }
            writeError('main async iterator loop error', e?.code, e?.message);
            writeError('Restarting in 10s...');
            console.log('~~~');
        }
        await sleep(10000);
    }
}

try {
    while (true) {
        await socketLoop();
    }
}
catch (e) {
    console.error('Uncaught socketLoop error', e);
    process.exit(1);
}