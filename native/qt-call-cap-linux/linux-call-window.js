'use strict';

const { spawn } = require('child_process');
const path = require('path');

class LinuxCallWindow {
    constructor({ log, record, onAnswer, onHangup, onUnexpectedExit }) {
        this.log = log;
        this.record = record;
        this.onAnswer = onAnswer;
        this.onHangup = onHangup;
        this.onUnexpectedExit = onUnexpectedExit;
        this.child = null;
        this.closingChildren = new WeakSet();
    }

    open(call, mediaState) {
        // Reuse the existing helper window if media restarts or call metadata is
        // refreshed, instead of spawning multiple Electron children.
        if (this.child && !this.child.killed) {
            this.send({
                type: 'update',
                call: this.buildCallInfo(call, mediaState)
            });
            return;
        }

        const electronPath = this.resolveElectronPath();
        if (!electronPath) {
            this.record('callWindowError', { reason: 'missing-electron-binary' });
            return;
        }

        const scriptPath = path.join(__dirname, 'call-window-main.js');
        const payload = JSON.stringify(this.buildCallInfo(call, mediaState));
        const env = Object.assign({}, process.env);
        // The parent Electron process may run with ELECTRON_RUN_AS_NODE. Remove
        // it so the child starts as a GUI Electron app, not a Node process.
        delete env.ELECTRON_RUN_AS_NODE;
        const child = spawn(electronPath, [scriptPath, payload], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env
        });

        this.child = child;
        this.record('callWindowSpawn', { electronPath, scriptPath });

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');

        let buffer = '';
        child.stdout.on('data', (chunk) => {
            // call-window-main writes one JSON event per line to stdout.
            buffer += chunk;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';
            for (const line of lines) {
                this.handleLine(line);
            }
        });

        child.stderr.on('data', (chunk) => {
            const message = chunk.trim();
            if (message) this.log('call window stderr', { message });
        });

        child.on('exit', (code, signal) => {
            const expected = this.closingChildren.has(child);
            this.closingChildren.delete(child);
            this.record('callWindowExit', { code, signal, expected });
            if (this.child === child) {
                this.child = null;
            }
            if (!expected && typeof this.onUnexpectedExit === 'function') {
                this.onUnexpectedExit({ code, signal });
            }
        });

        child.on('error', (error) => {
            this.record('callWindowError', { message: error.message });
            this.log('call window error', { message: error.message });
        });
    }

    update(call, mediaState) {
        this.send({
            type: 'update',
            call: this.buildCallInfo(call, mediaState)
        });
    }

    close() {
        if (!this.child || this.child.killed) {
            this.child = null;
            return;
        }

        const child = this.child;
        this.closingChildren.add(child);
        this.send({ type: 'close' });
        // Give the child a graceful close first so it does not report a user
        // hangup for parent-driven teardown. Kill only if it gets stuck.
        setTimeout(() => {
            if (!child.killed) {
                try {
                    child.kill('SIGTERM');
                } catch (_) {}
            }
        }, 1500);
    }

    send(message) {
        if (!this.child || this.child.killed || !this.child.stdin.writable) {
            return;
        }

        try {
            this.child.stdin.write(`${JSON.stringify(message)}\n`);
        } catch (_) {}
    }

    handleLine(line) {
        if (!line) {
            return;
        }

        let message;
        try {
            message = JSON.parse(line);
        } catch (_) {
            this.log('call window stdout', { message: line });
            return;
        }

        this.record('callWindowMessage', message);
        // Window close and the hangup button both flow through the same engine
        // path so signaling cleanup and call log creation stay centralized.
        if (message.type === 'answer' && typeof this.onAnswer === 'function') {
            this.onAnswer({ source: message.source || 'window' });
            return;
        }

        if (message.type === 'hangup' && typeof this.onHangup === 'function') {
            this.onHangup({ source: message.source || 'window' });
        }
    }

    buildCallInfo(call, mediaState) {
        return {
            callId: call && call.callId,
            calleeId: call && call.calleeId,
            calleeName: call && call.calleeName,
            callType: call && call.callType,
            isVideo: !!(call && (call.callType === 3 || call.callType === 6)),
            startedAt: call && call.startedAt,
            answeredAt: call && call.answeredAt,
            direction: call && call.direction,
            incoming: !!(call && call.incoming),
            ringing: !!(call && !call.incoming && !call.answeredAt),
            state: call && call.state,
            media: mediaState || null
        };
    }

    resolveElectronPath() {
        // The npm electron package exports the absolute binary path after
        // install. If install failed, return null and let the engine log it.
        try {
            const electronPath = require('electron');
            if (typeof electronPath === 'string') {
                return electronPath;
            }
        } catch (_) {}

        return null;
    }
}

module.exports = LinuxCallWindow;
