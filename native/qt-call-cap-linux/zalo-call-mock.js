#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const LinuxCallEngine = require('./linux-call-engine');

const KEY = 'yjAF9oqMWl6XfXYJn9mA7w==';
const IV = Buffer.from('0'.repeat(32), 'hex');
const MAX_CHUNK_SIZE = 4000;
const DEFAULT_RECV_SOCKET = '/tmp/socketzalorecv2021';
const DEFAULT_SEND_SOCKET = '/tmp/socketzalosend2021';

// This helper replaces the proprietary Linux call binary. The Electron main
// process talks to it through the same two Unix sockets used by the macOS
// helper: "send" carries renderer commands to native, "recv" carries native
// responses back to the renderer.
const recvSocketPath = process.argv[2] || DEFAULT_RECV_SOCKET;
const sendSocketPath = process.argv[3] || DEFAULT_SEND_SOCKET;
const verbose = process.env.ZALO_CALL_MOCK_VERBOSE === '1';
const logPath = process.env.ZALO_CALL_LOG || process.env.ZALO_CALL_MOCK_LOG || path.join(os.tmpdir(), 'zalo-call-linux.log');

let recvSocket = null;
let sendSocket = null;
let shuttingDown = false;
const engine = new LinuxCallEngine({ log, send: sendToMain });
let callTimeout = null;

function log(message, data) {
    const line = `[${new Date().toISOString()}] ${message}${data ? ` ${JSON.stringify(data)}` : ''}\n`;
    try {
        fs.appendFileSync(logPath, line);
    } catch (_) {}
    process.stdout.write(line);
}

function encrypt(input) {
    // Zalo's native call socket payloads are AES encrypted before chunking.
    const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(KEY, 'base64'), IV);
    return Buffer.concat([cipher.update(input), cipher.final()]).toString('hex');
}

function decrypt(input) {
    // Keep the same socket protocol as upstream so the bundled renderer code
    // can stay mostly unchanged.
    const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(KEY, 'base64'), IV);
    return Buffer.concat([
        decipher.update(Buffer.from(input, 'hex')),
        decipher.final()
    ]).toString();
}

function buildChunks(payload) {
    // The original helper splits large encrypted JSON payloads with "$" as the
    // frame delimiter and a small multipart header for long messages.
    const total = Math.floor((payload.length + MAX_CHUNK_SIZE - 1) / MAX_CHUNK_SIZE);
    const id = Date.now();

    if (total <= 1) {
        return [`${payload}$`];
    }

    const chunks = [];
    let rest = payload;
    for (let index = 0; index < total; index += 1) {
        chunks.push(`${rest.slice(0, MAX_CHUNK_SIZE)}#${id}#${total}#${index}#$`);
        rest = rest.slice(MAX_CHUNK_SIZE);
    }
    return chunks;
}

function createChunkParser(onMessage) {
    // Reassembles multipart frames before decrypting and dispatching them.
    const multipart = new Map();

    return (data) => {
        const parts = data.toString().split('$');

        for (const rawPart of parts) {
            if (!rawPart) continue;

            const match = rawPart.match(/^(.*)#(\d+)#(\d+)#(\d+)#$/);
            if (!match) {
                onMessage(rawPart);
                continue;
            }

            const [, payload, id, totalRaw, indexRaw] = match;
            const total = Number(totalRaw);
            const index = Number(indexRaw);
            const state = multipart.get(id) || { total, chunks: [] };
            state.chunks[index] = payload;
            multipart.set(id, state);

            if (state.chunks.filter(Boolean).length === state.total) {
                multipart.delete(id);
                onMessage(state.chunks.join(''));
            }
        }
    };
}

function sendToMain(message) {
    // "Main" here means the Electron side that owns recvSocket.
    if (!message || typeof message !== 'object') {
        log('send ignored', { reason: 'non-object-message', valueType: typeof message });
        return;
    }

    if (!recvSocket || recvSocket.destroyed) {
        return;
    }

    const encrypted = encrypt(JSON.stringify(message));
    for (const chunk of buildChunks(encrypted)) {
        recvSocket.write(chunk);
    }

    if (verbose) {
        log('send', message);
    } else {
        log('send', { type: message.type, command: message.command });
    }
}

function handleCommand(message) {
    // Convert renderer/native commands into LinuxCallEngine actions. The engine
    // returns protocol messages, while this bridge handles encryption/socket IO.
    if (!message || typeof message !== 'object') {
        log('recv ignored', { reason: 'non-object-command', valueType: typeof message });
        return;
    }

    if (verbose) {
        log('recv', message);
    } else {
        log('recv', { type: message.type, command: message.command });
    }

    if (message.type === 'request' && message.command === 'killMe') {
        shutdown(0);
        return;
    }

    if (message.command === 'listDevice') {
        sendToMain({
            type: 'response',
            command: 'listDevice',
            data: engine.getDeviceList()
        });
        return;
    }

    if (message.command === 'makeCall') {
        clearCallTimeout();
        for (const response of engine.makeCall(message.data)) {
            sendToMain(response);
        }
        scheduleCallTimeout();
        return;
    }

    if (message.command === 'endCall') {
        clearCallTimeout();
        for (const response of engine.handleEndCall()) {
            sendToMain(response);
        }
        return;
    }

    if (message.type === 'recvSignal') {
        clearCallTimeout();
        for (const response of engine.handleRecvSignal(message.command, message.data)) {
            sendToMain(response);
        }
        scheduleCallTimeout();
        return;
    }

    if (message.command === 'init' || message.command === 'updateLocal') {
        sendToMain(engine.init(message.data));
        return;
    }

    if (message.type === 'control') {
        clearCallTimeout();
        for (const response of engine.handleControl(message.data)) {
            sendToMain(response);
        }
        scheduleCallTimeout();
    }
}

function clearCallTimeout() {
    if (callTimeout) {
        clearTimeout(callTimeout);
        callTimeout = null;
    }
}

function scheduleCallTimeout() {
    const callId = engine.getCurrentCallId();
    if (!callId) {
        return;
    }

    // Before media starts there may be no remote control event. Free the call
    // state and write a missed/cancel log instead of leaving "in call" stuck.
    callTimeout = setTimeout(() => {
        callTimeout = null;
        for (const response of engine.handleCallTimeout(callId)) {
            sendToMain(response);
        }
    }, Number(process.env.ZALO_CALL_REQUEST_TIMEOUT_MS || 15000));
}

function connectSocket(socketPath, role, onConnect) {
    // The main app creates the socket server first. If the connection drops,
    // reconnect so dev reloads do not require restarting this helper manually.
    const socket = net.createConnection(socketPath);

    socket.on('connect', () => {
        log(`${role} connected`, { socketPath });
        onConnect(socket);
    });

    socket.on('error', (error) => {
        log(`${role} error`, { code: error.code, message: error.message });
    });

    socket.on('close', () => {
        log(`${role} closed`);
        if (!shuttingDown) {
            setTimeout(() => connectSocket(socketPath, role, onConnect), 1000);
        }
    });

    return socket;
}

function start() {
    const parser = createChunkParser((encrypted) => {
        try {
            handleCommand(JSON.parse(decrypt(encrypted).replace(/[\0]/g, '')));
        } catch (error) {
            log('parse error', { message: error.message });
        }
    });

    recvSocket = connectSocket(recvSocketPath, 'recv', () => {
        sendToMain({
            type: 'update',
            command: 'native-ready',
            data: { platform: process.platform, linux: true }
        });
    });

    sendSocket = connectSocket(sendSocketPath, 'send', (socket) => {
        socket.on('data', (data) => {
            socket.write('ack');
            parser(data);
        });
    });
}

function shutdown(code) {
    shuttingDown = true;
    clearCallTimeout();
    engine.shutdown();
    if (recvSocket && !recvSocket.destroyed) recvSocket.destroy();
    if (sendSocket && !sendSocket.destroyed) sendSocket.destroy();
    process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

log('zalo call linux helper starting', { recvSocketPath, sendSocketPath, logPath });
start();
