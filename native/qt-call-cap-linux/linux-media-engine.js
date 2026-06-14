'use strict';

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const dgram = require('dgram');

class LinuxMediaEngine {
    constructor({ log, record, onRemoteEnd, onRemoteMedia }) {
        this.log = log;
        this.record = record;
        this.onRemoteEnd = typeof onRemoteEnd === 'function' ? onRemoteEnd : null;
        this.onRemoteMedia = typeof onRemoteMedia === 'function' ? onRemoteMedia : null;
        this.processes = [];
        this.relays = [];
        this.active = false;
        this.videoDevice = null;
        this.desktopCapture = false;
        this.recentPorts = new Map();
    }

    getDeviceList() {
        // The upstream call UI expects device arrays even if Linux currently
        // lets GStreamer pick the default devices automatically.
        return {
            autoAudioInput: true,
            autoAudioOutput: true,
            defaultAudInputDevice: null,
            defaultAudOutputDevice: null,
            defaultVidDevice: null,
            audioInputDevices: this.getGstDevices('Audio/Source'),
            audioOutputDevices: this.getGstDevices('Audio/Sink'),
            videoInputDevices: this.getGstDevices('Video/Source')
        };
    }

    startOutgoingCall(call) {
        if (this.active) {
            return { ok: true, alreadyStarted: true };
        }

        const runtime = this.checkRuntime();
        if (!runtime.ok) {
            return runtime;
        }

        if (!call || !call.transportConfig || !call.transportConfig.rtpAddress) {
            return {
                ok: false,
                reason: 'missing-rtp-address'
            };
        }

        const remote = this.parseAddress(call.transportConfig.rtpAddress);
        if (!remote) {
            return {
                ok: false,
                reason: 'invalid-rtp-address',
                address: call.transportConfig.rtpAddress
            };
        }

        const localPort = this.pickLocalPort('ZALO_LINUX_CALL_LOCAL_RTP_PORT', 42000);
        const codec = this.selectCodec(call.transportConfig.codec);
        const payload = this.getPayload(codec);
        const sampleRate = this.getSampleRate(codec);
        const channels = this.getChannels(codec);
        const rtpClockRate = this.getRtpClockRate(codec);
        const bitrate = Number(process.env.ZALO_LINUX_CALL_AUDIO_BITRATE || 20000);
        const receiveEnabled = process.env.ZALO_LINUX_CALL_RECEIVE_AUDIO !== '0';
        const relayEnabled = receiveEnabled && process.env.ZALO_LINUX_CALL_UDP_RELAY !== '0';
        const zrtcMediaEnabled = relayEnabled && this.shouldUseZrtcMedia(call);
        const debugMedia = process.env.ZALO_LINUX_CALL_DEBUG_MEDIA === '1';
        const audioLevelEnabled = process.env.ZALO_LINUX_CALL_AUDIO_LEVEL !== '0';
        const audioSource = this.buildAudioSourceArgs();
        const videoConfig = this.buildVideoConfig(call);
        const videoEnabled = videoConfig.enabled && this.checkVideoRuntime().ok;
        const launchPrefix = debugMedia ? ['-m'] : ['-q'];
        const videoLaunchPrefix = debugMedia || process.env.ZALO_LINUX_CALL_DEBUG_VIDEO !== '0' ?
            ['-m'] :
            ['-q'];
        const sendLaunchPrefix = debugMedia || audioLevelEnabled ? ['-m'] : ['-q'];
        const receivePort = relayEnabled ?
            this.pickLocalPort('ZALO_LINUX_CALL_DECODE_RTP_PORT', 52000) :
            localPort;
        const videoReceivePort = videoEnabled ?
            this.pickLocalPort('ZALO_LINUX_CALL_DECODE_VIDEO_RTP_PORT', 62000) :
            null;
        const receiveSourceArgs = [
            'udpsrc',
            `port=${receivePort}`,
            'reuse=true',
            `caps=application/x-rtp,media=audio,encoding-name=OPUS,payload=${payload},clock-rate=${rtpClockRate}`
        ];
        if (debugMedia) {
            receiveSourceArgs.push('timeout=5000000000');
        }

        // Keep one external UDP socket for both directions. If gst udpsrc and
        // udpsink bind the same local port independently, Linux can deliver
        // remote packets to the sender socket instead of the receive pipeline.
        const relay = relayEnabled ?
            this.startUdpRelay({
                localPort,
                remote,
                receivePort,
                videoReceivePort,
                call,
                videoConfig,
                zrtcMediaEnabled,
                debugMedia
            }) :
            null;

        // The receive side decodes packets forwarded by the UDP relay. When
        // relay is disabled, it falls back to listening on the RTP port.
        const receiveArgs = [
            ...launchPrefix,
            ...receiveSourceArgs,
            '!',
            'rtpjitterbuffer',
            'latency=80',
            'drop-on-latency=true',
            '!',
            'rtpopusdepay',
            '!',
            'opusdec',
            'plc=true',
            'use-inband-fec=true',
            '!',
            'audioconvert',
            '!',
            'audioresample',
            '!',
            'autoaudiosink',
            'sync=false'
        ];

        // Full-duplex audio:
        // receive: RTP/Opus from server -> decode -> speaker
        // send: mic -> raw audio -> Opus -> RTP payload -> Zalo RTP server.
        const sendArgs = [
            ...sendLaunchPrefix,
            ...audioSource.args,
            '!',
            'audioconvert',
            '!',
            'audioresample',
            '!',
            `audio/x-raw,rate=${sampleRate},channels=${channels}`,
            '!',
            'level',
            'post-messages=true',
            'interval=1000000000',
            '!',
            'opusenc',
            'frame-size=20',
            `bitrate=${bitrate}`,
            'audio-type=voice',
            'inband-fec=false',
            '!',
            'rtpopuspay',
            `pt=${payload}`,
            'mtu=1300',
            '!',
            'udpsink',
            `host=${relayEnabled ? '127.0.0.1' : remote.host}`,
            `port=${relayEnabled ? localPort : remote.port}`,
            ...(relayEnabled ? [] : [`bind-port=${localPort}`]),
            'sync=false',
            'async=false'
        ];
        const videoReceiveArgs = videoEnabled ? this.buildVideoReceiveArgs({
            launchPrefix: videoLaunchPrefix,
            receivePort: videoReceivePort,
            videoConfig
        }) : null;
        const videoSendArgs = videoEnabled ? this.buildVideoSendArgs({
            launchPrefix,
            videoConfig,
            host: relayEnabled ? '127.0.0.1' : remote.host,
            port: relayEnabled ? localPort : remote.port
        }) : null;

        const receiver = receiveEnabled ? this.spawnGst('audio-recv', receiveArgs) : null;
        const sender = this.spawnGst('audio-send', sendArgs);
        if (receiver) {
            this.processes.push(receiver);
        }
        this.processes.push(sender);
        if (videoReceiveArgs) {
            this.processes.push(this.spawnGst('video-recv', videoReceiveArgs));
        }
        if (videoSendArgs) {
            this.processes.push(this.spawnGst('video-send', videoSendArgs));
        }
        this.active = true;

        const state = {
            localRtpPort: localPort,
            remoteRtpAddress: call.transportConfig.rtpAddress,
            payload,
            codec: codec.name || null,
            sampleRate,
            channels,
            rtpClockRate,
            audioSource: audioSource.summary,
            audioLevel: audioLevelEnabled,
            sendOnly: !receiveEnabled,
            receive: receiveEnabled,
            udpRelay: relayEnabled,
            zrtcMedia: zrtcMediaEnabled,
            video: videoEnabled ? {
                payload: videoConfig.payload,
                codec: videoConfig.codec && videoConfig.codec.name || 'h264',
                width: videoConfig.width,
                height: videoConfig.height,
                fps: videoConfig.fps,
                bitrate: videoConfig.bitrate,
                localReceivePort: videoReceivePort,
                source: videoConfig.sourceSummary
            } : null,
            localReceivePort: receiveEnabled ? receivePort : null,
            relay: relay ? {
                localPort,
                receivePort,
                videoReceivePort,
                remote: `${remote.host}:${remote.port}`,
                zrtcMedia: relay.zrtcMediaEnabled,
                zrtcToken: relay.zrtcToken || null
            } : null
        };

        this.record('mediaStarted', state);
        return { ok: true, data: state };
    }

    stop(options = {}) {
        // Track every spawned pipeline so call teardown can terminate media
        // reliably even when signaling fails or the window is closed manually.
        for (const child of this.processes.splice(0)) {
            if (!child || child.killed) {
                continue;
            }

            try {
                child.kill('SIGTERM');
                this.scheduleGstForceKill(child);
            } catch (_) {}
        }

        for (const relay of this.relays.splice(0)) {
            const delayedClose = this.sendZrtcEndCallPackets(relay, options.zrtcEndCall);
            this.record('mediaRelayStopped', this.getRelaySummary(relay));

            this.closeRelay(relay, delayedClose);
        }

        this.active = false;
    }

    getActivitySummary() {
        return {
            active: this.active,
            processCount: this.processes.length,
            relayCount: this.relays.length,
            relays: this.relays.map((relay) => this.getRelaySummary(relay))
        };
    }

    checkRuntime() {
        // Fail before starting the call window if the required GStreamer
        // plugins are missing. The engine will then cancel/log the call.
        const required = [
            ['gst-launch-1.0', '--version'],
            ['gst-inspect-1.0', 'autoaudiosrc'],
            ['gst-inspect-1.0', 'autoaudiosink'],
            ['gst-inspect-1.0', 'audioconvert'],
            ['gst-inspect-1.0', 'audioresample'],
            ['gst-inspect-1.0', 'opusenc'],
            ['gst-inspect-1.0', 'opusdec'],
            ['gst-inspect-1.0', 'rtpopuspay'],
            ['gst-inspect-1.0', 'rtpopusdepay'],
            ['gst-inspect-1.0', 'rtpjitterbuffer'],
            ['gst-inspect-1.0', 'udpsink'],
            ['gst-inspect-1.0', 'udpsrc']
        ];

        for (const command of required) {
            const result = spawnSync(command[0], command.slice(1), {
                stdio: 'ignore'
            });
            if (result.status !== 0) {
                return {
                    ok: false,
                    reason: 'missing-gstreamer-runtime',
                    command: command.join(' ')
                };
            }
        }

        return { ok: true };
    }

    checkVideoRuntime() {
        if (process.env.ZALO_LINUX_CALL_VIDEO === '0') {
            return { ok: false, reason: 'video-disabled-by-env' };
        }

        const required = [
            'autovideosrc',
            'autovideosink',
            'videoconvert',
            'videoscale',
            'videorate',
            'rtph264pay',
            'rtph264depay',
            'h264parse'
        ];

        for (const element of required) {
            if (!this.hasGstElement(element)) {
                return { ok: false, reason: 'missing-video-gstreamer-runtime', element };
            }
        }

        if (!this.getVideoEncoderElement()) {
            return { ok: false, reason: 'missing-h264-encoder' };
        }

        if (!this.getVideoDecoderElement()) {
            return { ok: false, reason: 'missing-h264-decoder' };
        }

        return { ok: true };
    }

    buildVideoConfig(call) {
        const codec = this.selectVideoCodec(call && call.transportConfig);
        const enabled = process.env.ZALO_LINUX_CALL_VIDEO !== '0' &&
            !!(
                codec ||
                call && (Number(call.callType) === 3 || Number(call.callType) === 6) ||
                call && call.transportConfig && call.transportConfig.videoEnabled
            );
        const zrtcConfig = call && call.transportConfig && call.transportConfig.zrtcConfig || {};
        const width = Number(process.env.ZALO_LINUX_CALL_VIDEO_WIDTH || zrtcConfig.maxWidth || 640);
        const height = Number(process.env.ZALO_LINUX_CALL_VIDEO_HEIGHT || zrtcConfig.maxHeight || 480);
        const fps = Number(process.env.ZALO_LINUX_CALL_VIDEO_FPS || zrtcConfig.codecMaxFps || 15);
        const bitrate = Number(process.env.ZALO_LINUX_CALL_VIDEO_BITRATE || zrtcConfig.startupBitrate || 500);

        return {
            enabled,
            codec: codec || this.getDefaultVideoCodec(),
            payload: this.getVideoPayload(codec),
            width: Number.isFinite(width) ? width : 640,
            height: Number.isFinite(height) ? height : 480,
            fps: Number.isFinite(fps) ? Math.max(1, Math.min(30, fps)) : 15,
            bitrate: Number.isFinite(bitrate) ? Math.max(100, bitrate) : 500,
            sourceArgs: this.buildVideoSourceArgs(),
            sourceSummary: this.buildVideoSourceSummary()
        };
    }

    buildVideoReceiveArgs({ launchPrefix, receivePort, videoConfig }) {
        return [
            ...launchPrefix,
            'udpsrc',
            `port=${receivePort}`,
            'reuse=true',
            `caps=application/x-rtp,media=video,encoding-name=H264,payload=${videoConfig.payload},clock-rate=90000,packetization-mode=1`,
            '!',
            'rtpjitterbuffer',
            'latency=120',
            'drop-on-latency=true',
            '!',
            'rtph264depay',
            'request-keyframe=true',
            'wait-for-keyframe=false',
            '!',
            'h264parse',
            '!',
            ...this.getVideoDecoderArgs(),
            '!',
            'videoconvert',
            '!',
            'videoscale',
            '!',
            ...this.buildVideoSinkArgs()
        ];
    }

    buildVideoSendArgs({ launchPrefix, videoConfig, host, port }) {
        const encoder = this.getVideoEncoderElement();
        const encoderArgs = encoder === 'x264enc' ? [
            'x264enc',
            'tune=zerolatency',
            'speed-preset=veryfast',
            `bitrate=${videoConfig.bitrate}`,
            `key-int-max=${Math.max(15, videoConfig.fps * 2)}`
        ] : [
            encoder,
            `bitrate=${videoConfig.bitrate * 1000}`
        ];

        return [
            ...launchPrefix,
            ...videoConfig.sourceArgs,
            '!',
            'videoconvert',
            '!',
            'videoscale',
            '!',
            'videorate',
            '!',
            `video/x-raw,format=I420,width=${videoConfig.width},height=${videoConfig.height},framerate=${videoConfig.fps}/1`,
            '!',
            ...encoderArgs,
            '!',
            'h264parse',
            'config-interval=1',
            '!',
            'rtph264pay',
            `pt=${videoConfig.payload}`,
            'mtu=1200',
            'config-interval=1',
            '!',
            'udpsink',
            `host=${host}`,
            `port=${port}`,
            'sync=false',
            'async=false'
        ];
    }

    buildVideoSourceArgs() {
        const source = String(process.env.ZALO_LINUX_CALL_VIDEO_SOURCE || '').trim();
        if (source) {
            return source.split(/\s+/);
        }

        if (this.desktopCapture) {
            return this.buildDesktopVideoSourceArgs();
        }

        const device = String(this.videoDevice || process.env.ZALO_LINUX_CALL_VIDEO_DEVICE || '').trim();
        if (this.hasGstElement('v4l2src')) {
            return [
                'v4l2src',
                ...(device ? [`device=${device}`] : []),
                '!',
                'video/x-raw,format=YUY2,width=640,height=480,framerate=30/1'
            ];
        }

        return ['autovideosrc'];
    }

    buildDesktopVideoSourceArgs() {
        if (this.hasGstElement('pipewiresrc')) {
            return ['pipewiresrc'];
        }

        if (this.hasGstElement('ximagesrc')) {
            return [
                'ximagesrc',
                'use-damage=false',
                'show-pointer=true'
            ];
        }

        return ['autovideosrc'];
    }

    buildVideoSourceSummary() {
        const source = String(process.env.ZALO_LINUX_CALL_VIDEO_SOURCE || '').trim();
        if (source) {
            return source;
        }

        if (this.desktopCapture) {
            if (this.hasGstElement('pipewiresrc')) {
                return 'pipewiresrc desktop';
            }

            if (this.hasGstElement('ximagesrc')) {
                return 'ximagesrc desktop';
            }
        }

        const device = String(this.videoDevice || process.env.ZALO_LINUX_CALL_VIDEO_DEVICE || '').trim();
        if (this.hasGstElement('v4l2src')) {
            return device ?
                `v4l2src device=${device} YUY2 640x480@30` :
                'v4l2src YUY2 640x480@30';
        }

        return 'autovideosrc';
    }

    setVideoDevice(id) {
        this.videoDevice = id || null;
        this.desktopCapture = false;
        this.record('mediaVideoDeviceChanged', {
            id: this.videoDevice
        });
    }

    setDesktopCapture(enabled) {
        this.desktopCapture = !!enabled;
        this.record('mediaDesktopCaptureChanged', {
            enabled: this.desktopCapture
        });
    }

    getVideoEncoderElement() {
        if (this.hasGstElement('x264enc')) {
            return 'x264enc';
        }

        if (this.hasGstElement('openh264enc')) {
            return 'openh264enc';
        }

        return null;
    }

    getVideoDecoderElement() {
        if (this.hasGstElement('avdec_h264')) {
            return 'avdec_h264';
        }

        if (this.hasGstElement('openh264dec')) {
            return 'openh264dec';
        }

        return null;
    }

    getVideoDecoderArgs() {
        const decoder = this.getVideoDecoderElement();
        if (decoder === 'avdec_h264') {
            return [
                decoder,
                'output-corrupt=true',
                'direct-rendering=false'
            ];
        }

        return [decoder];
    }

    buildVideoSinkArgs() {
        const configured = String(process.env.ZALO_LINUX_CALL_VIDEO_SINK || '').trim();
        if (configured) {
            return configured.split(/\s+/);
        }

        const displaySink = this.getPreferredVideoDisplaySink();
        if (this.hasGstElement('fpsdisplaysink') && displaySink) {
            return [
                'fpsdisplaysink',
                `video-sink=${displaySink}`,
                'text-overlay=false',
                'silent=false',
                'fps-update-interval=1000',
                'sync=false',
            ];
        }

        if (displaySink) {
            return [
                displaySink,
                'sync=false',
                'async=false',
                'force-aspect-ratio=true'
            ];
        }

        return [
            'autovideosink',
            'sync=false'
        ];
    }

    getPreferredVideoDisplaySink() {
        // Wayland can run XWayland sinks, but native waylandsink is more reliable
        // for standalone video windows on the user's current Linux desktop.
        if (process.env.XDG_SESSION_TYPE === 'wayland' && this.hasGstElement('waylandsink')) {
            return 'waylandsink';
        }

        if (this.hasGstElement('ximagesink')) {
            return 'ximagesink';
        }

        if (this.hasGstElement('glimagesink')) {
            return 'glimagesink';
        }

        if (this.hasGstElement('waylandsink')) {
            return 'waylandsink';
        }

        return null;
    }

    buildAudioSourceArgs() {
        const preferred = String(process.env.ZALO_LINUX_CALL_AUDIO_SOURCE || '').trim().toLowerCase();
        const input = String(process.env.ZALO_LINUX_CALL_AUDIO_INPUT || '').trim();

        if (!preferred || preferred === 'auto') {
            return {
                args: ['autoaudiosrc'],
                summary: 'autoaudiosrc'
            };
        }

        if (preferred === 'pulse' && this.hasGstElement('pulsesrc')) {
            return {
                args: ['pulsesrc', 'client-name=ZaloCall Linux'].concat(input ? [`device=${input}`] : []),
                summary: input ? `pulsesrc:${input}` : 'pulsesrc:default'
            };
        }

        if (preferred === 'alsa' && this.hasGstElement('alsasrc')) {
            return {
                args: ['alsasrc'].concat(input ? [`device=${input}`] : []),
                summary: input ? `alsasrc:${input}` : 'alsasrc:default'
            };
        }

        if (preferred === 'pipewire' && this.hasGstElement('pipewiresrc')) {
            const target = input || this.getDefaultPipeWireSourceTarget();
            return {
                args: ['pipewiresrc', 'client-name=ZaloCall Linux'].concat(target ? [`target-object=${target}`] : []),
                summary: target ? `pipewiresrc:${target}` : 'pipewiresrc:default'
            };
        }

        // Fall back to the runtime default when the requested backend is not
        // available. In real calls pipewiresrc can pass standalone tests but
        // still stall inside the relay pipeline, so it stays opt-in.
        return {
            args: ['autoaudiosrc'],
            summary: 'autoaudiosrc'
        };
    }

    hasGstElement(name) {
        const result = spawnSync('gst-inspect-1.0', [name], {
            stdio: 'ignore'
        });
        return result.status === 0;
    }

    getDefaultPipeWireSourceTarget() {
        const result = spawnSync('wpctl', ['inspect', '@DEFAULT_AUDIO_SOURCE@'], {
            encoding: 'utf8',
            timeout: 2000
        });
        if (result.status !== 0 || !result.stdout) {
            return '';
        }

        const serial = result.stdout.match(/^\s*\*?\s*object\.serial\s*=\s*"([^"]+)"/m);
        if (serial) {
            return serial[1];
        }

        const name = result.stdout.match(/^\s*\*?\s*node\.name\s*=\s*"([^"]+)"/m);
        return name ? name[1] : '';
    }

    spawnGst(name, args) {
        // Keep full pipeline args in the protocol log; it is the fastest way to
        // debug no-audio cases without reproducing the whole renderer flow.
        this.record('mediaSpawn', {
            name,
            command: 'gst-launch-1.0',
            args
        });

        const child = spawn('gst-launch-1.0', args, {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        child.__zaloMediaName = name;

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');

        child.stdout.on('data', (data) => {
            const message = data.trim();
            if (message) {
                this.recordAudioLevel(name, message);
                this.log(`media ${name} stdout`, { message });
            }
        });
        child.stderr.on('data', (data) => {
            const message = data.trim();
            if (message) {
                this.recordAudioLevel(name, message);
                this.log(`media ${name} stderr`, { message });
            }
        });
        child.on('exit', (code, signal) => {
            this.record('mediaExit', { name, code, signal });
            this.log(`media ${name} exit`, { code, signal });
        });
        child.on('error', (error) => {
            this.record('mediaError', { name, message: error.message });
            this.log(`media ${name} error`, { message: error.message });
        });

        return child;
    }

    scheduleGstForceKill(child) {
        const delayMs = Math.max(150, Number(process.env.ZALO_LINUX_CALL_GST_FORCE_KILL_MS || 350));
        const timer = setTimeout(() => {
            if (!child || child.exitCode !== null || child.signalCode !== null) {
                return;
            }

            try {
                this.record('mediaForceKill', {
                    name: child.__zaloMediaName || 'unknown',
                    pid: child.pid || null,
                    delayMs
                });
                child.kill('SIGKILL');
            } catch (_) {}
        }, delayMs);

        if (timer.unref) timer.unref();
    }

    recordAudioLevel(name, message) {
        if (name !== 'audio-send' || !/level/.test(message)) {
            return;
        }

        const rms = this.extractGstDoubleList(message, 'rms');
        const peak = this.extractGstDoubleList(message, 'peak');
        if (!rms.length && !peak.length) {
            return;
        }

        this.record('mediaAudioLevel', {
            name,
            rms,
            peak,
            silent: peak.length ? Math.max(...peak) < -55 : undefined
        });
    }

    extractGstDoubleList(message, field) {
        const match = message.match(new RegExp(`${field}=\\((?:double|GValueArray)\\)<?([^>;]+)>?`));
        if (!match) {
            return [];
        }

        return match[1]
            .split(',')
            .map((value) => Number(value.trim()))
            .filter((value) => Number.isFinite(value));
    }

    sendZrtcEndCallPackets(relay, call) {
        if (!call) {
            return false;
        }

        const packetInfo = this.buildZrtcEndCallPacket(call);
        if (!packetInfo) {
            this.record('mediaZrtcEndCallSkipped', Object.assign(this.getRelaySummary(relay), {
                reason: 'missing-zrtc-endcall-fields',
                localUserId: call.localUserId || null,
                callId: call.callId || null
            }));
            return false;
        }

        const count = Math.max(1, Number(process.env.ZALO_LINUX_CALL_ZRTC_END_COUNT || 10));
        const spacingMs = Math.max(0, Number(process.env.ZALO_LINUX_CALL_ZRTC_END_SPACING_MS || 60));
        const debugMedia = process.env.ZALO_LINUX_CALL_DEBUG_MEDIA === '1';

        for (let index = 0; index < count; index += 1) {
            const sendPacket = () => {
                relay.socket.send(packetInfo.packet, relay.remotePort, relay.remoteHost, (error) => {
                    if (error) {
                        this.record('mediaZrtcEndCallError', Object.assign(
                            this.getRelaySummary(relay),
                            {
                                index,
                                message: error.message
                            }
                        ));
                    }
                });
            };

            if (index === 0 || spacingMs === 0) {
                sendPacket();
            } else {
                const timer = setTimeout(sendPacket, spacingMs * index);
                if (timer.unref) timer.unref();
            }
        }

        relay.zrtcEndCloseDelayMs = Math.max(
            relay.zrtcEndCloseDelayMs || 0,
            spacingMs * Math.max(0, count - 1) + 150
        );

        this.record('mediaZrtcEndCallPacket', Object.assign(
            this.getRelaySummary(relay),
            {
                count,
                bytes: packetInfo.packet.length,
                localUserId: packetInfo.localUserId,
                callId: packetInfo.callId,
                token: packetInfo.token,
                packetHex: debugMedia ? packetInfo.packet.toString('hex') : undefined
            }
        ));

        return true;
    }

    buildZrtcEndCallPacket(call) {
        const localUserId = this.toUInt32(call && call.localUserId);
        const callId = this.toUInt32(
            call && this.getFirstValue(
                call.transportConfig && call.transportConfig.callId,
                call.callId
            )
        );
        const token = this.toUInt32(
            call && this.getFirstValue(
                call.zrtcToken,
                call.transportConfig && call.transportConfig.token,
                0
            )
        );

        if (localUserId === null || callId === null) {
            return null;
        }

        // Matches macOS zrtc::ZRTPPacket::initZRTPPacketRequestEndCall +
        // buildPacket(): type=1, subcmd=3, payload userId/token/callId.
        const packet = Buffer.alloc(25);
        packet[0] = 0x01;
        packet[1] = 0x01;
        packet.writeUInt32LE(0, 2);
        packet.writeUInt32LE(0, 6);
        packet.writeUInt32LE(localUserId, 10);
        packet.writeUInt32LE(token || 0, 14);
        packet.writeUInt16LE(3, 18);
        packet[20] = 0;
        packet.writeUInt32LE(callId, 21);

        return {
            packet,
            localUserId,
            callId,
            token: token || 0
        };
    }

    closeRelay(relay, delayed) {
        relay.stopping = true;

        if (relay.zrtcInitTimer) {
            clearTimeout(relay.zrtcInitTimer);
            relay.zrtcInitTimer = null;
        }

        if (relay.localRtcpTimer) {
            clearInterval(relay.localRtcpTimer);
            relay.localRtcpTimer = null;
        }

        if (relay.localZrtcControlTimer) {
            clearInterval(relay.localZrtcControlTimer);
            relay.localZrtcControlTimer = null;
        }

        if (relay.localPacketWatchTimer) {
            clearTimeout(relay.localPacketWatchTimer);
            relay.localPacketWatchTimer = null;
        }

        if (relay.videoKeyframeRequestTimer) {
            clearInterval(relay.videoKeyframeRequestTimer);
            relay.videoKeyframeRequestTimer = null;
        }

        const close = () => {
            relay.closed = true;
            try {
                relay.socket.close();
            } catch (_) {}
        };

        if (!delayed) {
            close();
            return;
        }

        const configuredDelay = Number(process.env.ZALO_LINUX_CALL_ZRTC_END_CLOSE_DELAY_MS || 0);
        const delayMs = Math.max(
            25,
            relay.zrtcEndCloseDelayMs || 0,
            Number.isFinite(configuredDelay) ? configuredDelay : 0,
            120
        );
        const timer = setTimeout(close, delayMs);
        if (timer.unref) timer.unref();
    }

    startUdpRelay({ localPort, remote, receivePort, videoReceivePort, call, videoConfig, zrtcMediaEnabled, debugMedia }) {
        const relay = {
            socket: dgram.createSocket({
                type: 'udp4',
                reuseAddr: true
            }),
            localPort,
            remoteHost: remote.host,
            remotePort: remote.port,
            receivePort,
            videoReceivePort,
            localPackets: 0,
            localBytes: 0,
            localRtpPayloadBytes: 0,
            localRtpSsrc: null,
            localRtpTimestamp: 0,
            localRtcpPackets: 0,
            localRtcpBytes: 0,
            localRtcpTimer: null,
            localZrtcControlPackets: 0,
            localZrtcControlToken: crypto.randomInt(0x100000000),
            localZrtcControlTimer: null,
            localPacketWatchTimer: null,
            remotePackets: 0,
            remoteBytes: 0,
            localPayload: this.getPayload(this.selectCodec(call && call.transportConfig && call.transportConfig.codec)),
            videoPayload: videoConfig && videoConfig.enabled ? videoConfig.payload : null,
            remotePlainPayload: null,
            remoteVideoPayload: null,
            remoteVideoSsrc: null,
            remoteVideoNalTypes: new Set(),
            remoteVideoHasSps: false,
            remoteVideoHasPps: false,
            remoteVideoHasIdr: false,
            remoteVideoNalTypeLogged: false,
            videoKeyframeRequestTimer: null,
            videoKeyframeRequests: 0,
            videoFirSequence: 0,
            localPayloadRewritePackets: 0,
            localSsrcRewritePackets: 0,
            localPlainRtpLogged: false,
            localVideoPlainRtpLogged: false,
            remotePayloadRewritePackets: 0,
            remoteVideoAnnexBPackets: 0,
            zrtcMediaEnabled: !!zrtcMediaEnabled,
            zrtcPacketMode: this.getZrtcPacketMode(call),
            zrtcAnswerDowngraded: !!(call && call.transportConfig && call.transportConfig.zrtcAnswerDowngraded),
            zrtcToken: this.toUInt32(call && call.zrtcToken) || 0,
            zrtcInitPacket: zrtcMediaEnabled ? this.buildZrtcInitPacket(call) : null,
            zrtcInitAttempts: 0,
            zrtcInitTimer: null,
            zrtcLastInitSentAt: 0,
            zrtcWrappedLocalPackets: 0,
            zrtcWrappedLocalBytes: 0,
            zrtcDroppedLocalPackets: 0,
            zrtcDroppedLocalBytes: 0,
            zrtcPlainFallbackPackets: 0,
            zrtcDualLocalPackets: 0,
            zrtcDualWrapperPackets: 0,
            zrtcRemoteAudioPackets: 0,
            zrtcRemoteVideoPackets: 0,
            zrtcRemoteVideoInvalidPackets: 0,
            zrtcRemoteVideoDroppedPackets: 0,
            zrtcRemoteRtcpPackets: 0,
            zrtcRemoteControlPackets: 0,
            zrtcRemotePlainPackets: 0,
            zrtcRemoteUnknownPackets: 0,
            zrtcRemoteVideoWrapperLogged: false,
            zrtcRemoteInvalidVideoWrapperLogged: false,
            zrtcRemoteVideoDropLogged: false,
            zrtcPlainOnlyLocalPackets: 0,
            call,
            videoConfig,
            debugMedia: !!debugMedia,
            stopping: false,
            closed: false
        };

        if (relay.zrtcMediaEnabled && !relay.zrtcInitPacket) {
            this.record('mediaZrtcInitSkipped', Object.assign(this.getRelaySummary(relay), {
                reason: 'missing-zrtc-init-fields',
                localUserId: call && call.localUserId || null,
                partnerUserId: this.getCallPartnerUserId(call),
                callId: call && this.getFirstValue(
                    call.transportConfig && call.transportConfig.callId,
                    call.callId
                ) || null,
                session: call && call.transportConfig && call.transportConfig.session || null
            }));
        }

        relay.socket.on('listening', () => {
            this.record('mediaRelayStarted', this.getRelaySummary(relay));
            this.log('media udp relay started', this.getRelaySummary(relay));
            this.sendZrtcInitPacket(relay, 'startup');
            this.startLocalPacketWatch(relay);
        });

        relay.socket.on('message', (message, rinfo) => {
            if (relay.stopping || relay.closed) {
                return;
            }

            if (!this.isRemoteEndpoint(relay, rinfo) && this.isLoopbackAddress(rinfo.address)) {
                relay.localPackets += 1;
                relay.localBytes += message.length;
                const outboundPackets = this.prepareLocalMediaPackets(relay, message);
                if (!outboundPackets.length) {
                    return;
                }

                for (const outbound of outboundPackets) {
                    this.noteRelayPacket(relay, 'local-to-remote', outbound.length);
                    relay.socket.send(outbound, relay.remotePort, relay.remoteHost, (error) => {
                        if (error) this.log('media udp relay send remote error', { message: error.message });
                    });
                }
                return;
            }

            relay.remotePackets += 1;
            relay.remoteBytes += message.length;
            const inbound = this.prepareRemoteMediaPacket(relay, message);
            if (!inbound) {
                return;
            }

            this.noteRelayPacket(relay, 'remote-to-local', inbound.length);
            relay.socket.send(inbound, this.getReceivePortForRemotePacket(relay, inbound), '127.0.0.1', (error) => {
                if (error) this.log('media udp relay send local error', { message: error.message });
            });
        });

        relay.socket.on('error', (error) => {
            this.record('mediaRelayError', Object.assign(this.getRelaySummary(relay), {
                message: error.message
            }));
            this.log('media udp relay error', {
                message: error.message,
                localPort: relay.localPort
            });
        });

        relay.socket.bind(relay.localPort, '0.0.0.0');
        this.relays.push(relay);
        return relay;
    }

    startLocalPacketWatch(relay) {
        if (relay.localPacketWatchTimer || process.env.ZALO_LINUX_CALL_LOCAL_PACKET_WATCH === '0') {
            return;
        }

        const delayMs = Math.max(1000, Number(process.env.ZALO_LINUX_CALL_LOCAL_PACKET_WATCH_MS || 3000));
        relay.localPacketWatchTimer = setTimeout(() => {
            relay.localPacketWatchTimer = null;
            if (relay.closed || relay.localPackets > 0) {
                return;
            }

            // No packet here means GStreamer never delivered local RTP to the
            // UDP relay. That is different from a muted mic, which still emits
            // RTP packets with quiet Opus frames.
            this.record('mediaNoLocalPackets', this.getRelaySummary(relay));
        }, delayMs);
        if (relay.localPacketWatchTimer.unref) relay.localPacketWatchTimer.unref();
    }

    shouldUseZrtcMedia(call) {
        if (process.env.ZALO_LINUX_CALL_ZRTC_MEDIA !== undefined) {
            return process.env.ZALO_LINUX_CALL_ZRTC_MEDIA !== '0';
        }

        return !(call && call.transportConfig && call.transportConfig.zrtcMedia === false);
    }

    prepareLocalMediaPackets(relay, message) {
        message = this.prepareLocalRtpPacket(relay, message);
        this.rememberLocalRtpPacket(relay, message);

        if (!relay.zrtcMediaEnabled) {
            return [this.preparePlainLocalMediaPacket(relay, message)];
        }

        if (this.shouldSendPlainMediaOnly(relay)) {
            relay.zrtcPlainOnlyLocalPackets += 1;
            this.noteZrtcPlainOnly(relay, message.length);
            return [this.preparePlainLocalMediaPacket(relay, message)];
        }

        const token = this.getRelayZrtcToken(relay);
        if (!token) {
            if (this.shouldFallbackToPlainMedia(relay)) {
                relay.zrtcPlainFallbackPackets += 1;
                this.noteZrtcPlainFallback(relay, message.length);
                return [this.preparePlainLocalMediaPacket(relay, message)];
            }

            relay.zrtcDroppedLocalPackets += 1;
            relay.zrtcDroppedLocalBytes += message.length;
            this.sendZrtcInitPacket(relay, 'await-token');
            this.noteZrtcAwaitToken(relay, message.length);

            if (process.env.ZALO_LINUX_CALL_ZRTC_SEND_ZERO_TOKEN !== '1') {
                return [];
            }
        }

        const packet = this.buildZrtcMediaPacket(relay, message, token || 0, false);
        relay.zrtcWrappedLocalPackets += 1;
        relay.zrtcWrappedLocalBytes += packet.length;

        if (this.shouldDualSendZrtcWrappers(relay, token || 0)) {
            const fallbackPacket = this.buildZrtcMediaPacket(relay, message, token || 0, false, {
                forceLong: true
            });

            if (!fallbackPacket.equals(packet)) {
                relay.zrtcDualWrapperPackets += 1;
                this.noteZrtcDualWrapperSend(relay, message.length);
                return [
                    packet,
                    fallbackPacket
                ];
            }
        }

        if (this.shouldDualSendPlainMedia(relay)) {
            relay.zrtcDualLocalPackets += 1;
            this.noteZrtcDualSend(relay, message.length);
            return [
                this.preparePlainLocalMediaPacket(relay, message),
                packet
            ];
        }

        return [packet];
    }

    rememberLocalRtpPacket(relay, message) {
        if (!this.isRtpPacket(message)) {
            return;
        }

        relay.localRtpSsrc = this.getRtpSsrc(message);
        relay.localRtpTimestamp = message.readUInt32BE(4);
        relay.localRtpPayloadBytes += this.getRtpPayloadByteLength(message);

        this.ensureLocalRtcpReporter(relay);
        this.ensureLocalZrtcControlReporter(relay);
    }

    ensureLocalRtcpReporter(relay) {
        if (
            relay.localRtcpTimer ||
            relay.closed ||
            process.env.ZALO_LINUX_CALL_SEND_RTCP === '0'
        ) {
            return;
        }

        const intervalMs = Math.max(500, Number(process.env.ZALO_LINUX_CALL_RTCP_INTERVAL_MS || 1000));
        relay.localRtcpTimer = setInterval(() => {
            this.sendLocalRtcpReport(relay);
        }, intervalMs);
        if (relay.localRtcpTimer.unref) relay.localRtcpTimer.unref();
    }

    sendLocalRtcpReport(relay) {
        if (
            !relay ||
            relay.closed ||
            !relay.socket ||
            !Number.isInteger(relay.localRtpSsrc)
        ) {
            return false;
        }

        const rtcp = this.buildRtcpSenderReport(relay);
        const packet = relay.zrtcMediaEnabled ?
            this.buildZrtcMediaPacket(relay, rtcp, 0, true) :
            rtcp;

        relay.localRtcpPackets += 1;
        relay.localRtcpBytes += packet.length;
        relay.socket.send(packet, relay.remotePort, relay.remoteHost, (error) => {
            if (error) {
                this.record('mediaLocalRtcpError', Object.assign(this.getRelaySummary(relay), {
                    message: error.message
                }));
            }
        });

        if (relay.localRtcpPackets === 1 || relay.localRtcpPackets % 5 === 0) {
            this.record('mediaLocalRtcpPacket', Object.assign(this.getRelaySummary(relay), {
                bytes: packet.length,
                ssrc: relay.localRtpSsrc,
                rtpTimestamp: relay.localRtpTimestamp
            }));
        }

        return true;
    }

    ensureLocalZrtcControlReporter(relay) {
        if (
            relay.localZrtcControlTimer ||
            relay.closed ||
            !relay.zrtcMediaEnabled ||
            process.env.ZALO_LINUX_CALL_SEND_ZRTC_CONTROL === '0'
        ) {
            return;
        }

        const intervalMs = Math.max(500, Number(process.env.ZALO_LINUX_CALL_ZRTC_CONTROL_INTERVAL_MS || 1000));
        relay.localZrtcControlTimer = setInterval(() => {
            this.sendLocalZrtcControlPacket(relay);
        }, intervalMs);
        if (relay.localZrtcControlTimer.unref) relay.localZrtcControlTimer.unref();
    }

    sendLocalZrtcControlPacket(relay) {
        if (
            !relay ||
            relay.closed ||
            !relay.socket ||
            !relay.zrtcMediaEnabled
        ) {
            return false;
        }

        const packet = this.buildZrtcQualityPacket(relay);
        if (!packet) {
            return false;
        }

        relay.localZrtcControlPackets += 1;
        relay.socket.send(packet, relay.remotePort, relay.remoteHost, (error) => {
            if (error) {
                this.record('mediaLocalZrtcControlError', Object.assign(this.getRelaySummary(relay), {
                    message: error.message
                }));
            }
        });

        if (relay.localZrtcControlPackets === 1 || relay.localZrtcControlPackets % 5 === 0) {
            this.record('mediaLocalZrtcControlPacket', Object.assign(this.getRelaySummary(relay), {
                bytes: packet.length,
                token: relay.localZrtcControlToken
            }));
        }

        return true;
    }

    buildZrtcQualityPacket(relay) {
        const localUserId = this.toUInt32(relay.call && relay.call.localUserId);
        if (localUserId === null) {
            return null;
        }

        const packet = Buffer.alloc(47);
        const sequence = (relay.localZrtcControlPackets + 1) >>> 0;

        // Mirrors the periodic type=1/subcmd=32 control packet observed from
        // Zalo peers. It appears to feed call quality/transport liveness.
        packet[0] = 0x01;
        packet[1] = 0x01;
        packet.writeUInt32LE(0, 2);
        packet.writeUInt32LE(sequence, 6);
        packet.writeUInt32LE(localUserId, 10);
        packet.writeUInt32LE(relay.localZrtcControlToken >>> 0, 14);
        packet.writeUInt16LE(32, 18);
        packet[20] = 0x0a;
        packet.writeUInt32LE(22, 21);
        packet.writeUInt32LE(0, 25);
        packet.writeUInt32LE(4, 29);
        packet.writeUInt32LE(1, 33);
        packet.writeUInt32LE(0, 37);
        packet.writeUInt32LE(0, 41);
        packet.writeUInt16LE(0x80, 45);

        return packet;
    }

    buildRtcpSenderReport(relay) {
        const now = Date.now();
        const ntpSeconds = Math.floor(now / 1000) + 2208988800;
        const ntpFraction = Math.floor(((now % 1000) / 1000) * 0x100000000);
        const report = Buffer.alloc(28);

        // RTCP SR: V=2, RC=0, PT=200, length=6, then sender statistics.
        report[0] = 0x80;
        report[1] = 200;
        report.writeUInt16BE(6, 2);
        report.writeUInt32BE(relay.localRtpSsrc >>> 0, 4);
        report.writeUInt32BE(ntpSeconds >>> 0, 8);
        report.writeUInt32BE(ntpFraction >>> 0, 12);
        report.writeUInt32BE(relay.localRtpTimestamp >>> 0, 16);
        report.writeUInt32BE((relay.localPackets || 0) >>> 0, 20);
        report.writeUInt32BE((relay.localRtpPayloadBytes || 0) >>> 0, 24);

        return report;
    }

    preparePlainLocalMediaPacket(relay, message) {
        if (!this.isRtpPacket(message)) {
            return message;
        }

        const mediaKind = this.getLocalRtpMediaKind(relay, message);
        const targetPayload = mediaKind === 'video' ?
            this.toPayloadType(relay.remoteVideoPayload || relay.videoPayload) :
            this.toPayloadType(relay.remotePlainPayload);
        if (targetPayload === null) {
            return message;
        }

        const currentPayload = this.getRtpPayloadType(message);
        if (currentPayload === targetPayload) {
            return message;
        }

        relay.localPayloadRewritePackets += 1;
        this.noteRtpPayloadRewrite(relay, 'local-to-remote', currentPayload, targetPayload);

        return this.rewriteRtpPayloadType(message, targetPayload);
    }

    prepareLocalRtpPacket(relay, message) {
        if (!this.isRtpPacket(message)) {
            return message;
        }

        let prepared = message;
        const mediaKind = this.getLocalRtpMediaKind(relay, prepared);
        const targetPayload = mediaKind === 'video' ?
            this.toPayloadType(relay.videoPayload) :
            this.toPayloadType(relay.localPayload);
        const currentPayload = this.getRtpPayloadType(prepared);
        if (targetPayload !== null && currentPayload !== targetPayload) {
            relay.localPayloadRewritePackets += 1;
            this.noteRtpPayloadRewrite(relay, 'local-to-remote', currentPayload, targetPayload);
            prepared = this.rewriteRtpPayloadType(prepared, targetPayload);
        }

        if (!this.shouldRewriteLocalSsrc(relay)) {
            this.noteLocalPlainRtp(relay, prepared, mediaKind);
            return prepared;
        }

        const targetSsrc = this.toUInt32(relay.call && relay.call.localUserId);
        const currentSsrc = this.getRtpSsrc(prepared);
        if (targetSsrc !== null && currentSsrc !== targetSsrc) {
            relay.localSsrcRewritePackets += 1;
            if (relay.localSsrcRewritePackets === 1 || relay.localSsrcRewritePackets % 250 === 0) {
                this.record('mediaRtpSsrcRewrite', Object.assign(this.getRelaySummary(relay), {
                    direction: 'local-to-remote',
                    fromSsrc: currentSsrc,
                    toSsrc: targetSsrc
                }));
            }
            prepared = this.rewriteRtpSsrc(prepared, targetSsrc);
        }

        this.noteLocalPlainRtp(relay, prepared, mediaKind);
        return prepared;
    }

    shouldRewriteLocalSsrc(relay) {
        if (process.env.ZALO_LINUX_CALL_REWRITE_LOCAL_SSRC !== undefined) {
            return process.env.ZALO_LINUX_CALL_REWRITE_LOCAL_SSRC !== '0';
        }

        // Zalo peers identify their incoming RTP stream by user-id SSRC. Remote
        // packets observed from real clients use peer user id as SSRC, while
        // GStreamer emits a random SSRC by default. Keep Linux aligned with the
        // native call engine unless explicitly disabled for debugging.
        return !!(relay && relay.zrtcMediaEnabled);
    }

    noteLocalPlainRtp(relay, message, mediaKind = 'audio') {
        const flag = mediaKind === 'video' ? 'localVideoPlainRtpLogged' : 'localPlainRtpLogged';
        if (relay[flag] || !this.isRtpPacket(message)) {
            return;
        }

        relay[flag] = true;
        this.record('mediaLocalPlainRtp', Object.assign(this.getRelaySummary(relay), {
            mediaKind,
            payload: this.getRtpPayloadType(message),
            sequence: this.getRtpSequence(message),
            timestamp: message.readUInt32BE(4),
            ssrc: this.getRtpSsrc(message),
            localUserId: relay.call && relay.call.localUserId || null,
            bytes: message.length,
            packetHex: relay.debugMedia ? message.toString('hex') : undefined
        }));
    }

    prepareRemoteMediaPacket(relay, message) {
        if (!relay.zrtcMediaEnabled || !message || message.length === 0) {
            return message;
        }

        const type = message[0];

        if (type === 3) {
            if (message.length <= 5) {
                return null;
            }

            this.rememberRelayToken(relay, message.readUInt32LE(1), 'remote-audio');
            return this.prepareRemotePlainRtpPacket(relay, message.subarray(5));
        }

        if (type === 4) {
            if (message.length <= 1) {
                return null;
            }

            // Packet mode 2 peers send media as one-byte ZRTC media type (4)
            // followed directly by a normal RTP packet.
            relay.zrtcPacketMode = 2;
            return this.prepareRemotePlainRtpPacket(relay, message.subarray(1));
        }

        if (type === 5) {
            relay.zrtcRemoteRtcpPackets += 1;
            this.noteZrtcControlPacket(relay, 'remote-rtcp', message);
            return null;
        }

        if (type === 14) {
            return this.unwrapZrtcVideoMediaPacket(relay, message);
        }

        if (type === 15) {
            // Type 15 has the same wrapper shape as type 14, but the payload is
            // RTCP. Do not feed it into GStreamer; just count it for diagnostics.
            relay.zrtcRemoteRtcpPackets += 1;
            this.noteZrtcControlPacket(relay, 'remote-video-rtcp', message.subarray(5));
            return null;
        }

        if (type === 0x7f) {
            return this.unwrapZrtcP2pMediaPacket(relay, message);
        }

        if (type === 1 || type === 2) {
            this.handleRemoteZrtcControlPacket(relay, message);
            return null;
        }

        // Keep compatibility with servers/peers that still send plain RTP.
        // Unknown non-RTP ZRTC/control packets must not be fed into GStreamer.
        if (this.isRtpPacket(message)) {
            return this.prepareRemotePlainRtpPacket(relay, message);
        }

        relay.zrtcRemoteUnknownPackets += 1;
        this.noteZrtcUnknownPacket(relay, message);
        return null;
    }

    unwrapZrtcVideoMediaPacket(relay, message) {
        // Zalo video media has appeared with more than one native wrapper shape.
        // Instead of hard-coding a single prefix length, find the embedded RTP
        // header and log the first wrapper so future native parity work is sane.
        const rtpOffset = this.findRtpOffset(message, [5, 1, 9, 13, 17, 21, 25, 29, 33]);
        if (rtpOffset === -1) {
            relay.zrtcRemoteVideoInvalidPackets += 1;
            this.noteRemoteVideoWrapper(relay, message, null);
            return null;
        }

        this.noteRemoteVideoWrapper(relay, message, rtpOffset);
        return this.prepareRemotePlainRtpPacket(relay, message.subarray(rtpOffset), 'video');
    }

    findRtpOffset(message, preferredOffsets = []) {
        for (const offset of preferredOffsets) {
            if (offset > 0 && offset < message.length && this.isRtpPacket(message.subarray(offset))) {
                return offset;
            }
        }

        const scanLimit = Math.min(message.length - 12, 64);
        for (let offset = 1; offset <= scanLimit; offset += 1) {
            if (preferredOffsets.includes(offset)) {
                continue;
            }

            if (this.isRtpPacket(message.subarray(offset))) {
                return offset;
            }
        }

        return -1;
    }

    noteRemoteVideoWrapper(relay, message, rtpOffset) {
        const flag = rtpOffset === null ?
            'zrtcRemoteInvalidVideoWrapperLogged' :
            'zrtcRemoteVideoWrapperLogged';
        if (relay[flag]) {
            return;
        }

        relay[flag] = true;
        const rtp = rtpOffset === null ? null : message.subarray(rtpOffset);
        this.record('mediaRemoteVideoWrapper', Object.assign(this.getRelaySummary(relay), {
            bytes: message.length,
            rtpOffset,
            rtpPayload: rtp ? this.getRtpPayloadType(rtp) : null,
            rtpSequence: rtp ? this.getRtpSequence(rtp) : null,
            rtpSsrc: rtp ? this.getRtpSsrc(rtp) : null,
            packetHex: message.subarray(0, Math.min(message.length, 96)).toString('hex')
        }));
    }

    prepareRemotePlainRtpPacket(relay, message, mediaKindOverride = null) {
        relay.zrtcRemotePlainPackets += 1;

        const remotePayload = this.getRtpPayloadType(message);
        const mediaKind = mediaKindOverride || this.getRemoteRtpMediaKind(relay, message);
        if (remotePayload === null) {
            if (mediaKind === 'video') {
                relay.zrtcRemoteVideoInvalidPackets += 1;
            }
            return null;
        }

        if (mediaKind === 'video') {
            const normalized = this.normalizeRemoteH264RtpPacket(relay, message);
            if (!normalized) {
                relay.zrtcRemoteVideoDroppedPackets += 1;
                this.noteDroppedRemoteVideoPacket(relay, message, remotePayload, 'invalid-annexb-h264');
                return null;
            }
            message = normalized;
        }

        const videoRejectReason = mediaKind === 'video' ?
            this.getRemoteVideoRejectReason(relay, message, remotePayload) :
            null;
        if (videoRejectReason) {
            relay.zrtcRemoteVideoDroppedPackets += 1;
            this.noteDroppedRemoteVideoPacket(relay, message, remotePayload, videoRejectReason);
            return null;
        }

        if (mediaKind === 'video') {
            relay.zrtcRemoteVideoPackets += 1;
            this.trackRemoteVideoPacket(relay, message);
        } else {
            relay.zrtcRemoteAudioPackets += 1;
        }
        this.notifyRemoteMedia(relay, mediaKind, message);

        const payloadField = mediaKind === 'video' ? 'remoteVideoPayload' : 'remotePlainPayload';
        if (relay[payloadField] === null && remotePayload !== null) {
            relay[payloadField] = remotePayload;
            this.record('mediaRemotePlainRtp', Object.assign(this.getRelaySummary(relay), {
                mediaKind,
                payload: remotePayload,
                sequence: this.getRtpSequence(message),
                ssrc: this.getRtpSsrc(message),
                bytes: message.length,
                packetHex: relay.debugMedia ? message.toString('hex') : undefined
            }));
        }

        const targetPayload = mediaKind === 'video' ?
            this.toPayloadType(relay.videoPayload) :
            this.toPayloadType(relay.localPayload);
        if (targetPayload === null || remotePayload === null || remotePayload === targetPayload) {
            return message;
        }

        relay.remotePayloadRewritePackets += 1;
        this.noteRtpPayloadRewrite(relay, 'remote-to-local', remotePayload, targetPayload);

        return this.rewriteRtpPayloadType(message, targetPayload);
    }

    notifyRemoteMedia(relay, mediaKind, message) {
        if (!this.onRemoteMedia) {
            return;
        }

        const flag = mediaKind === 'video' ? 'remoteVideoMediaNotified' : 'remoteAudioMediaNotified';
        if (relay[flag]) {
            return;
        }

        relay[flag] = true;
        this.onRemoteMedia(Object.assign(this.getRelaySummary(relay), {
            mediaKind,
            bytes: message.length
        }));
    }

    getRemoteVideoRejectReason(relay, message, payload) {
        if (process.env.ZALO_LINUX_CALL_ACCEPT_REMOTE_VIDEO_PAYLOAD === '1') {
            return null;
        }

        const expected = this.toPayloadType(relay && relay.videoPayload);
        if (process.env.ZALO_LINUX_CALL_VALIDATE_H264 !== '0') {
            const nalType = this.getH264NalTypeFromRtp(message);
            if (!this.isSupportedH264NalType(nalType)) {
                return 'invalid-h264-nal';
            }
        }

        return null;
    }

    trackRemoteVideoPacket(relay, message) {
        const ssrc = this.getRtpSsrc(message);
        if (ssrc !== null) {
            relay.remoteVideoSsrc = ssrc;
        }

        const nalTypes = this.getH264NalTypesFromRtp(message);
        if (nalTypes.length) {
            for (const nalType of nalTypes) {
                relay.remoteVideoNalTypes.add(nalType);
            }

            relay.remoteVideoHasSps = relay.remoteVideoHasSps || nalTypes.includes(7);
            relay.remoteVideoHasPps = relay.remoteVideoHasPps || nalTypes.includes(8);
            relay.remoteVideoHasIdr = relay.remoteVideoHasIdr || nalTypes.includes(5);
            this.noteRemoteVideoNalTypes(relay, message, nalTypes);
        }

        if (!this.hasRemoteVideoKeyframeState(relay)) {
            this.ensureVideoKeyframeRequester(relay, 'missing-sps-pps-idr');
        } else if (relay.videoKeyframeRequestTimer) {
            clearInterval(relay.videoKeyframeRequestTimer);
            relay.videoKeyframeRequestTimer = null;
            this.record('mediaVideoKeyframeRequestStopped', Object.assign(this.getRelaySummary(relay), {
                reason: 'decoder-config-seen',
                nalTypes: Array.from(relay.remoteVideoNalTypes).sort((a, b) => a - b)
            }));
        }
    }

    hasRemoteVideoKeyframeState(relay) {
        return !!(relay && relay.remoteVideoHasSps && relay.remoteVideoHasPps && relay.remoteVideoHasIdr);
    }

    noteRemoteVideoNalTypes(relay, message, nalTypes) {
        if (
            relay.remoteVideoNalTypeLogged &&
            !nalTypes.includes(5) &&
            !nalTypes.includes(7) &&
            !nalTypes.includes(8)
        ) {
            return;
        }

        relay.remoteVideoNalTypeLogged = true;
        this.record('mediaRemoteVideoNalTypes', Object.assign(this.getRelaySummary(relay), {
            sequence: this.getRtpSequence(message),
            ssrc: this.getRtpSsrc(message),
            nalTypes,
            allNalTypes: Array.from(relay.remoteVideoNalTypes).sort((a, b) => a - b),
            hasSps: relay.remoteVideoHasSps,
            hasPps: relay.remoteVideoHasPps,
            hasIdr: relay.remoteVideoHasIdr
        }));
    }

    ensureVideoKeyframeRequester(relay, reason) {
        if (
            !relay ||
            relay.closed ||
            relay.videoKeyframeRequestTimer ||
            process.env.ZALO_LINUX_CALL_REQUEST_VIDEO_KEYFRAME === '0'
        ) {
            return;
        }

        this.sendVideoKeyframeRequest(relay, reason);

        const intervalMs = Math.max(500, Number(process.env.ZALO_LINUX_CALL_KEYFRAME_REQUEST_INTERVAL_MS || 1000));
        relay.videoKeyframeRequestTimer = setInterval(() => {
            if (
                relay.closed ||
                this.hasRemoteVideoKeyframeState(relay) ||
                relay.videoKeyframeRequests >= Math.max(1, Number(process.env.ZALO_LINUX_CALL_KEYFRAME_REQUEST_MAX || 10))
            ) {
                clearInterval(relay.videoKeyframeRequestTimer);
                relay.videoKeyframeRequestTimer = null;
                return;
            }

            this.sendVideoKeyframeRequest(relay, 'retry-missing-sps-pps-idr');
        }, intervalMs);
        if (relay.videoKeyframeRequestTimer.unref) relay.videoKeyframeRequestTimer.unref();
    }

    sendVideoKeyframeRequest(relay, reason) {
        if (!relay || relay.closed || !relay.socket || relay.remoteVideoSsrc === null) {
            return false;
        }

        const senderSsrc = this.toUInt32(relay.call && relay.call.localUserId) ||
            this.toUInt32(relay.localRtpSsrc) ||
            1;
        const mediaSsrc = this.toUInt32(relay.remoteVideoSsrc);
        if (mediaSsrc === null) {
            return false;
        }

        const feedbackPackets = [
            this.buildRtcpPliPacket(senderSsrc, mediaSsrc),
            this.buildRtcpFirPacket(relay, senderSsrc, mediaSsrc)
        ].filter(Boolean);
        const wrapperMode = this.getVideoRtcpWrapperMode(relay);

        let sent = false;
        relay.videoKeyframeRequests += 1;
        for (const rtcp of feedbackPackets) {
            const packets = this.wrapVideoRtcpFeedbackPackets(relay, rtcp);

            for (const packet of packets) {
                relay.socket.send(packet, relay.remotePort, relay.remoteHost, (error) => {
                    if (error) {
                        this.record('mediaVideoKeyframeRequestError', Object.assign(this.getRelaySummary(relay), {
                            reason,
                            wrapperMode,
                            message: error.message
                        }));
                    }
                });
                sent = true;
            }
        }

        if (sent) {
            this.record('mediaVideoKeyframeRequest', Object.assign(this.getRelaySummary(relay), {
                reason,
                count: relay.videoKeyframeRequests,
                senderSsrc,
                mediaSsrc,
                feedback: ['pli', 'fir'],
                wrapperMode,
                packetCount: feedbackPackets.length * this.getVideoRtcpWrapperCount(relay)
            }));
        }

        return sent;
    }

    wrapVideoRtcpFeedbackPackets(relay, rtcp) {
        if (!relay.zrtcMediaEnabled) {
            return [rtcp];
        }

        const mode = this.getVideoRtcpWrapperMode(relay);
        const packets = [];

        // Real Zalo video RTCP from peers arrives as wrapper type 15 with a
        // five-byte prefix. Keyframe requests must use the same video lane, or
        // iOS keeps sending delta frames without SPS/PPS/IDR.
        if (mode === '15' || mode === 'video' || mode === 'dual') {
            packets.push(this.buildZrtcVideoRtcpPacket(rtcp));
        }

        // Keep a selectable fallback for older experiments where feedback used
        // the generic RTCP wrapper. It is off by default because logs show Zalo
        // video RTCP on type 15.
        if (mode === '5' || mode === 'media' || mode === 'dual') {
            packets.push(this.buildZrtcMediaPacket(relay, rtcp, 0, true));
        }

        return packets.length ? packets : [this.buildZrtcVideoRtcpPacket(rtcp)];
    }

    getVideoRtcpWrapperMode(relay) {
        if (!relay || !relay.zrtcMediaEnabled) {
            return 'plain';
        }

        return String(process.env.ZALO_LINUX_CALL_VIDEO_RTCP_WRAPPER || '15').trim().toLowerCase();
    }

    getVideoRtcpWrapperCount(relay) {
        const mode = this.getVideoRtcpWrapperMode(relay);
        return mode === 'dual' ? 2 : 1;
    }

    buildRtcpPliPacket(senderSsrc, mediaSsrc) {
        const packet = Buffer.alloc(12);
        packet[0] = 0x81; // V=2, FMT=1 Picture Loss Indication.
        packet[1] = 206; // Payload-specific feedback.
        packet.writeUInt16BE(2, 2);
        packet.writeUInt32BE(senderSsrc >>> 0, 4);
        packet.writeUInt32BE(mediaSsrc >>> 0, 8);
        return packet;
    }

    buildRtcpFirPacket(relay, senderSsrc, mediaSsrc) {
        const packet = Buffer.alloc(20);
        packet[0] = 0x84; // V=2, FMT=4 Full Intra Request.
        packet[1] = 206;
        packet.writeUInt16BE(4, 2);
        packet.writeUInt32BE(senderSsrc >>> 0, 4);
        packet.writeUInt32BE(mediaSsrc >>> 0, 8);
        packet.writeUInt32BE(mediaSsrc >>> 0, 12);
        packet[16] = (relay.videoFirSequence = ((relay.videoFirSequence || 0) + 1) & 0xff);
        packet[17] = 0;
        packet[18] = 0;
        packet[19] = 0;
        return packet;
    }

    buildZrtcVideoRtcpPacket(rtcp) {
        const packet = Buffer.alloc(rtcp.length + 5);
        packet[0] = 15;
        packet.writeUInt32LE(0, 1);
        rtcp.copy(packet, 5);
        return packet;
    }

    normalizeRemoteH264RtpPacket(relay, message) {
        if (process.env.ZALO_LINUX_CALL_NORMALIZE_ANNEXB_VIDEO === '0') {
            return message;
        }

        const headerLength = this.getRtpHeaderLength(message);
        if (headerLength === null || message.length <= headerLength) {
            return null;
        }

        const paddingLength = (message[0] & 0x20) !== 0 ? message[message.length - 1] : 0;
        const payloadEnd = Math.max(headerLength, message.length - paddingLength);
        const payload = message.subarray(headerLength, payloadEnd);
        const nalUnits = this.splitAnnexBNalUnits(payload);
        if (!nalUnits) {
            return message;
        }

        const normalizedPayload = this.buildRtpH264PayloadFromNalUnits(nalUnits);
        if (!normalizedPayload) {
            return null;
        }

        relay.remoteVideoAnnexBPackets += 1;
        this.noteRemoteVideoAnnexBPacket(relay, message, nalUnits, normalizedPayload.length);

        const header = Buffer.from(message.subarray(0, headerLength));
        // The normalized packet intentionally drops RTP padding because the
        // payload length changes. Clear the padding flag so downstream depay
        // does not read a stale padding byte from the old packet tail.
        header[0] &= 0xdf;
        return Buffer.concat([header, normalizedPayload]);
    }

    splitAnnexBNalUnits(payload) {
        const firstStartCodeLength = this.getAnnexBStartCodeLength(payload, 0);
        if (!firstStartCodeLength) {
            return null;
        }

        const nalUnits = [];
        let offset = firstStartCodeLength;
        while (offset < payload.length) {
            const nextStart = this.findNextAnnexBStartCode(payload, offset);
            const end = nextStart === -1 ? payload.length : nextStart;
            const nal = payload.subarray(offset, end);
            if (nal.length > 0) {
                nalUnits.push(nal);
            }

            if (nextStart === -1) {
                break;
            }

            offset = nextStart + this.getAnnexBStartCodeLength(payload, nextStart);
        }

        return nalUnits.length ? nalUnits : null;
    }

    findNextAnnexBStartCode(payload, offset) {
        for (let i = offset; i < payload.length - 3; i += 1) {
            if (this.getAnnexBStartCodeLength(payload, i)) {
                return i;
            }
        }

        return -1;
    }

    getAnnexBStartCodeLength(payload, offset) {
        if (offset + 3 <= payload.length &&
            payload[offset] === 0 &&
            payload[offset + 1] === 0 &&
            payload[offset + 2] === 1) {
            return 3;
        }

        if (offset + 4 <= payload.length &&
            payload[offset] === 0 &&
            payload[offset + 1] === 0 &&
            payload[offset + 2] === 0 &&
            payload[offset + 3] === 1) {
            return 4;
        }

        return 0;
    }

    buildRtpH264PayloadFromNalUnits(nalUnits) {
        if (!nalUnits.length) {
            return null;
        }

        if (nalUnits.length === 1) {
            return Buffer.from(nalUnits[0]);
        }

        let nri = 0;
        let totalLength = 1;
        for (const nal of nalUnits) {
            if (!nal.length || nal.length > 0xffff) {
                return null;
            }

            nri = Math.max(nri, nal[0] & 0x60);
            totalLength += 2 + nal.length;
        }

        const payload = Buffer.alloc(totalLength);
        payload[0] = nri | 24; // STAP-A packet with the highest NRI from children.
        let offset = 1;
        for (const nal of nalUnits) {
            payload.writeUInt16BE(nal.length, offset);
            offset += 2;
            nal.copy(payload, offset);
            offset += nal.length;
        }

        return payload;
    }

    noteRemoteVideoAnnexBPacket(relay, message, nalUnits, normalizedBytes) {
        const count = relay.remoteVideoAnnexBPackets;
        if (count !== 1 && count % 250 !== 0) {
            return;
        }

        this.record('mediaRemoteVideoAnnexB', Object.assign(this.getRelaySummary(relay), {
            count,
            sequence: this.getRtpSequence(message),
            ssrc: this.getRtpSsrc(message),
            nalTypes: nalUnits.slice(0, 6).map((nal) => nal[0] & 0x1f),
            nalCount: nalUnits.length,
            normalizedBytes
        }));
    }

    noteDroppedRemoteVideoPacket(relay, message, payload, reason) {
        if (relay.zrtcRemoteVideoDropLogged) {
            return;
        }

        relay.zrtcRemoteVideoDropLogged = true;
        this.record('mediaRemoteVideoDropped', Object.assign(this.getRelaySummary(relay), {
            payload,
            expectedPayload: this.toPayloadType(relay.videoPayload),
            nalType: this.getH264NalTypeFromRtp(message),
            sequence: this.getRtpSequence(message),
            ssrc: this.getRtpSsrc(message),
            bytes: message.length,
            reason,
            packetHex: message.subarray(0, Math.min(message.length, 96)).toString('hex')
        }));
    }

    unwrapZrtcP2pMediaPacket(relay, message) {
        if (message.length < 9) {
            return null;
        }

        const subcmd = message.readUInt16LE(7);
        if (subcmd === 6) {
            return this.prepareRemotePlainRtpPacket(relay, message.subarray(9));
        }

        if (subcmd === 7) {
            relay.zrtcRemoteRtcpPackets += 1;
            this.noteZrtcControlPacket(relay, 'remote-p2p-rtcp', message);
            return null;
        }

        this.noteZrtcControlPacket(relay, `remote-p2p-${subcmd}`, message);
        return null;
    }

    getLocalRtpMediaKind(relay, message) {
        const payload = this.getRtpPayloadType(message);
        if (
            relay &&
            this.toPayloadType(relay.videoPayload) !== null &&
            payload === this.toPayloadType(relay.videoPayload)
        ) {
            return 'video';
        }

        return 'audio';
    }

    getRemoteRtpMediaKind(relay, message) {
        const payload = this.getRtpPayloadType(message);
        if (
            relay &&
            this.toPayloadType(relay.videoPayload) !== null &&
            payload === this.toPayloadType(relay.videoPayload)
        ) {
            return 'video';
        }

        if (
            relay &&
            this.toPayloadType(relay.remoteVideoPayload) !== null &&
            payload === this.toPayloadType(relay.remoteVideoPayload)
        ) {
            return 'video';
        }

        return 'audio';
    }

    getReceivePortForRemotePacket(relay, message) {
        return this.getRemoteRtpMediaKind(relay, message) === 'video' && relay.videoReceivePort ?
            relay.videoReceivePort :
            relay.receivePort;
    }

    handleRemoteZrtcControlPacket(relay, message) {
        relay.zrtcRemoteControlPackets += 1;

        let subcmd = null;
        let resultCode = null;
        let token = null;
        let callId = null;
        let remoteUserId = null;

        if (message.length >= 21) {
            subcmd = message.readUInt16LE(18);
            token = message.length >= 18 ? message.readUInt32LE(14) : null;
            remoteUserId = message.length >= 14 ? message.readUInt32LE(10) : null;
            callId = (message[0] === 1 || subcmd === 3) && message.length >= 25 ?
                message.readUInt32LE(21) :
                null;

            if (message[0] === 2 && (subcmd === 11 || subcmd === 12)) {
                resultCode = message.length >= 25 ? message.readUInt32LE(21) : null;
                token = this.getZrtcInitResponseToken(message);
                if (token) {
                    this.rememberRelayToken(relay, token, 'init-response');
                }
            }
        }

        this.noteZrtcControlPacket(relay, 'remote-control', message, {
            subcmd,
            resultCode,
            token,
            callId,
            remoteUserId
        });

        if ((message[0] === 1 || message[0] === 2) && subcmd === 3) {
            const details = {
                callId: callId ? String(callId) : null,
                remoteUserId: remoteUserId ? String(remoteUserId) : null,
                token: token || 0
            };

            this.record('mediaZrtcRemoteEndCallPacket', Object.assign(
                this.getRelaySummary(relay),
                details
            ));

            if (this.onRemoteEnd) {
                this.onRemoteEnd(details);
            }
        }
    }

    sendZrtcInitPacket(relay, reason) {
        if (
            !relay ||
            relay.closed ||
            !relay.zrtcMediaEnabled ||
            !relay.zrtcInitPacket ||
            this.getRelayZrtcToken(relay)
        ) {
            return false;
        }

        const now = Date.now();
        const retryMs = Math.max(100, Number(process.env.ZALO_LINUX_CALL_ZRTC_INIT_RETRY_MS || 300));
        if (reason !== 'startup' && now - relay.zrtcLastInitSentAt < retryMs) {
            this.scheduleZrtcInitRetry(relay);
            return false;
        }

        const maxAttempts = Math.max(1, Number(process.env.ZALO_LINUX_CALL_ZRTC_INIT_ATTEMPTS || 20));
        if (relay.zrtcInitAttempts >= maxAttempts) {
            return false;
        }

        relay.zrtcInitAttempts += 1;
        relay.zrtcLastInitSentAt = now;
        relay.socket.send(relay.zrtcInitPacket.packet, relay.remotePort, relay.remoteHost, (error) => {
            if (error) {
                this.record('mediaZrtcInitError', Object.assign(
                    this.getRelaySummary(relay),
                    {
                        reason,
                        message: error.message
                    }
                ));
            }
        });

        if (relay.zrtcInitAttempts === 1 || relay.zrtcInitAttempts % 5 === 0) {
            this.record('mediaZrtcInitPacket', Object.assign(
                this.getRelaySummary(relay),
                {
                    reason,
                    bytes: relay.zrtcInitPacket.packet.length,
                    localUserId: relay.zrtcInitPacket.localUserId,
                    partnerUserId: relay.zrtcInitPacket.partnerUserId,
                    callId: relay.zrtcInitPacket.callId,
                    subcmd: relay.zrtcInitPacket.subcmd,
                    packetHex: relay.debugMedia ? relay.zrtcInitPacket.packet.toString('hex') : undefined
                }
            ));
        }

        this.scheduleZrtcInitRetry(relay);
        return true;
    }

    scheduleZrtcInitRetry(relay) {
        if (
            relay.closed ||
            relay.zrtcInitTimer ||
            this.getRelayZrtcToken(relay) ||
            !relay.zrtcInitPacket
        ) {
            return;
        }

        const maxAttempts = Math.max(1, Number(process.env.ZALO_LINUX_CALL_ZRTC_INIT_ATTEMPTS || 20));
        if (relay.zrtcInitAttempts >= maxAttempts) {
            return;
        }

        const retryMs = Math.max(100, Number(process.env.ZALO_LINUX_CALL_ZRTC_INIT_RETRY_MS || 300));
        relay.zrtcInitTimer = setTimeout(() => {
            relay.zrtcInitTimer = null;
            this.sendZrtcInitPacket(relay, 'retry');
        }, retryMs);
        if (relay.zrtcInitTimer.unref) relay.zrtcInitTimer.unref();
    }

    rememberRelayToken(relay, token, source) {
        const parsed = this.toUInt32(token);
        if (!parsed || relay.zrtcToken === parsed) {
            return;
        }

        relay.zrtcToken = parsed;
        if (relay.call) {
            relay.call.zrtcToken = parsed;
        }

        if (relay.zrtcInitTimer) {
            clearTimeout(relay.zrtcInitTimer);
            relay.zrtcInitTimer = null;
        }

        this.record('mediaZrtcToken', Object.assign(this.getRelaySummary(relay), {
            source,
            token: parsed
        }));
    }

    getRelayZrtcToken(relay) {
        const callToken = this.toUInt32(relay.call && relay.call.zrtcToken);
        if (callToken) {
            relay.zrtcToken = callToken;
            return callToken;
        }

        return relay.zrtcToken || 0;
    }

    noteZrtcAwaitToken(relay, bytes) {
        if (
            relay.zrtcDroppedLocalPackets !== 1 &&
            relay.zrtcDroppedLocalPackets % 250 !== 0
        ) {
            return;
        }

        this.record('mediaZrtcAwaitToken', Object.assign(this.getRelaySummary(relay), {
            bytes
        }));
    }

    shouldFallbackToPlainMedia(relay) {
        if (process.env.ZALO_LINUX_CALL_ZRTC_PLAIN_FALLBACK === '0') {
            return false;
        }

        const maxAttempts = Math.max(1, Number(process.env.ZALO_LINUX_CALL_ZRTC_INIT_ATTEMPTS || 20));
        return relay.zrtcRemotePlainPackets > 0 && relay.zrtcInitAttempts >= maxAttempts;
    }

    noteZrtcPlainFallback(relay, bytes) {
        if (
            relay.zrtcPlainFallbackPackets !== 1 &&
            relay.zrtcPlainFallbackPackets % 250 !== 0
        ) {
            return;
        }

        this.record('mediaZrtcPlainFallback', Object.assign(this.getRelaySummary(relay), {
            bytes
        }));
    }

    shouldSendPlainMediaOnly(relay) {
        return relay.zrtcMediaEnabled &&
            process.env.ZALO_LINUX_CALL_ZRTC_PLAIN_ONLY !== '0' &&
            relay.zrtcRemotePlainPackets > 0 &&
            relay.zrtcRemoteAudioPackets === 0;
    }

    noteZrtcPlainOnly(relay, bytes) {
        if (
            relay.zrtcPlainOnlyLocalPackets !== 1 &&
            relay.zrtcPlainOnlyLocalPackets % 250 !== 0
        ) {
            return;
        }

        this.record('mediaZrtcPlainOnly', Object.assign(this.getRelaySummary(relay), {
            bytes
        }));
    }

    shouldDualSendPlainMedia(relay) {
        if (!relay.zrtcMediaEnabled || process.env.ZALO_LINUX_CALL_ZRTC_DUAL_SEND !== '1') {
            return false;
        }

        if (Number(relay.zrtcPacketMode) !== 2) {
            return relay.zrtcRemoteAudioPackets === 0;
        }

        if (!this.isZrtcAnswerDowngraded(relay)) {
            return false;
        }

        const maxPackets = Math.max(0, Number(process.env.ZALO_LINUX_CALL_ZRTC_DUAL_SEND_PACKETS || 1500));
        return relay.localPackets <= maxPackets;
    }

    isZrtcAnswerDowngraded(relay) {
        return !!(
            relay.zrtcAnswerDowngraded ||
            relay.call &&
                relay.call.transportConfig &&
                relay.call.transportConfig.zrtcAnswerDowngraded
        );
    }

    noteZrtcDualSend(relay, bytes) {
        if (
            relay.zrtcDualLocalPackets !== 1 &&
            relay.zrtcDualLocalPackets % 250 !== 0
        ) {
            return;
        }

        this.record('mediaZrtcDualSend', Object.assign(this.getRelaySummary(relay), {
            bytes
        }));
    }

    shouldDualSendZrtcWrappers(relay, token) {
        if (!relay || !relay.zrtcMediaEnabled || !token) {
            return false;
        }

        if (process.env.ZALO_LINUX_CALL_ZRTC_DUAL_WRAPPER === '0') {
            return false;
        }

        if (!relay.call || relay.call.incoming || Number(relay.zrtcPacketMode) !== 2) {
            return false;
        }

        // Some Zalo peers answer packetMode=2 but never emit downlink media
        // when the caller only sends the short type=4 wrapper. Send both early
        // wrapper shapes until remote audio appears, then converge immediately.
        if (relay.zrtcRemoteAudioPackets > 0) {
            return false;
        }

        const maxPackets = Math.max(0, Number(process.env.ZALO_LINUX_CALL_ZRTC_DUAL_WRAPPER_PACKETS || 300));
        return relay.localPackets <= maxPackets;
    }

    noteZrtcDualWrapperSend(relay, bytes) {
        if (
            relay.zrtcDualWrapperPackets !== 1 &&
            relay.zrtcDualWrapperPackets % 250 !== 0
        ) {
            return;
        }

        this.record('mediaZrtcDualWrapperSend', Object.assign(this.getRelaySummary(relay), {
            bytes
        }));
    }

    getZrtcInitResponseToken(message) {
        if (!message || message.length < 21 || message[0] !== 2) {
            return 0;
        }

        const subcmd = message.readUInt16LE(18);
        if (subcmd !== 11 && subcmd !== 12) {
            return 0;
        }

        // macOS parsePacket() stores packet[29..32] into ZRTPPacket::_token
        // for successful type=2 init responses. packet[14..17] is the common
        // header token and stays zero during the init handshake.
        if (message.length >= 33 && message.readUInt32LE(21) === 0) {
            return message.readUInt32LE(29);
        }

        return message.length >= 18 ? message.readUInt32LE(14) : 0;
    }

    noteZrtcControlPacket(relay, direction, message, extra = {}) {
        const count = direction.indexOf('rtcp') === -1 ?
            relay.zrtcRemoteControlPackets :
            relay.zrtcRemoteRtcpPackets;

        if (count > 5 && count % 50 !== 0) {
            return;
        }

        this.record('mediaZrtcControlPacket', Object.assign(this.getRelaySummary(relay), extra, {
            direction,
            type: message && message.length ? message[0] : null,
            bytes: message ? message.length : 0,
            packetHex: message && (relay.debugMedia || count <= 5) ? message.toString('hex') : undefined
        }));
    }

    noteZrtcUnknownPacket(relay, message) {
        if (
            relay.zrtcRemoteUnknownPackets !== 1 &&
            relay.zrtcRemoteUnknownPackets % 50 !== 0
        ) {
            return;
        }

        this.record('mediaZrtcUnknownPacket', Object.assign(this.getRelaySummary(relay), {
            type: message && message.length ? message[0] : null,
            bytes: message ? message.length : 0,
            packetHex: message && (relay.debugMedia || relay.zrtcRemoteUnknownPackets <= 3) ?
                message.toString('hex') :
                undefined
        }));
    }

    noteRtpPayloadRewrite(relay, direction, fromPayload, toPayload) {
        const count = direction === 'remote-to-local' ?
            relay.remotePayloadRewritePackets :
            relay.localPayloadRewritePackets;

        if (count !== 1 && count % 250 !== 0) {
            return;
        }

        this.record('mediaRtpPayloadRewrite', Object.assign(this.getRelaySummary(relay), {
            direction,
            fromPayload,
            toPayload
        }));
    }

    buildZrtcMediaPacket(relay, payload, token, isRtcp, options = {}) {
        if (!isRtcp && !options.forceLong && this.shouldUseShortZrtcMediaPacket(relay)) {
            const packet = Buffer.alloc(payload.length + 1);
            packet[0] = 4;
            payload.copy(packet, 1);
            return packet;
        }

        const packet = Buffer.alloc(payload.length + 5);
        packet[0] = isRtcp ? 5 : 3;
        packet.writeUInt32LE(token >>> 0, 1);
        payload.copy(packet, 5);
        return packet;
    }

    shouldUseShortZrtcMediaPacket(relay) {
        if (process.env.ZALO_LINUX_CALL_ZRTC_SHORT_MEDIA !== undefined) {
            return process.env.ZALO_LINUX_CALL_ZRTC_SHORT_MEDIA !== '0';
        }

        // packetMode=2 is the short ZRTC media lane: type=4 followed by RTP.
        // Outgoing calls were connected but silent when Linux ignored this and
        // kept sending the token-prefixed type=3 frame. Keep incoming calls on
        // the older long frame because that path is already known to work.
        return !!(
            relay &&
            relay.call &&
            !relay.call.incoming &&
            Number(relay.zrtcPacketMode) === 2
        );
    }

    getZrtcPacketMode(call) {
        const explicit = Number(process.env.ZALO_LINUX_CALL_ZRTC_PACKET_MODE);
        if (Number.isFinite(explicit) && explicit > 0) {
            return explicit;
        }

        const configured = Number(call && call.transportConfig && call.transportConfig.packetMode);
        if (Number.isFinite(configured) && configured > 0) {
            return configured;
        }

        return call && call.transportConfig && call.transportConfig.zrtcMedia ? 2 : 0;
    }

    buildZrtcInitPacket(call) {
        const localUserId = this.toUInt32(call && call.localUserId);
        const partnerUserId = this.getCallPartnerUserId(call);
        const callId = this.toUInt32(
            call && this.getFirstValue(
                call.transportConfig && call.transportConfig.callId,
                call.callId
            )
        );
        const session = String(
            call &&
            call.transportConfig &&
            this.getFirstValue(call.transportConfig.session, call.transportConfig.sessId) ||
            ''
        );

        if (localUserId === null || partnerUserId === null || callId === null || !session) {
            return null;
        }

        const isCaller = !(call && call.incoming);
        const subcmd = isCaller ? 11 : 12;
        const sessionBytes = Buffer.from(session, 'utf8');
        const extra = String(
            !isCaller &&
            call &&
            call.transportConfig &&
            this.getFirstValue(call.transportConfig.extendData, call.transportConfig.extend_data) ||
            ''
        );
        const extraBytes = Buffer.from(extra, 'utf8');
        const hasExtra = !isCaller && extraBytes.length > 0;
        const length = 31 + sessionBytes.length + (hasExtra ? 2 + extraBytes.length : 0);
        const packet = Buffer.alloc(length);

        // Matches macOS initZRTPPacketRequestInitCall + buildPacket():
        // type=1, subcmd=11(caller)/12(callee), then call/partner/session.
        packet[0] = 0x01;
        packet[1] = 0x01;
        packet.writeUInt32LE(0, 2);
        packet.writeUInt32LE(0, 6);
        packet.writeUInt32LE(localUserId, 10);
        packet.writeUInt32LE(0, 14);
        packet.writeUInt16LE(subcmd, 18);
        packet[20] = 1;
        packet.writeUInt32LE(callId, 21);
        packet.writeUInt32LE(partnerUserId, 25);
        packet.writeUInt16LE(sessionBytes.length, 29);
        sessionBytes.copy(packet, 31);

        if (hasExtra) {
            const extraOffset = 31 + sessionBytes.length;
            packet.writeUInt16LE(extraBytes.length, extraOffset);
            extraBytes.copy(packet, extraOffset + 2);
        }

        return {
            packet,
            localUserId,
            partnerUserId,
            callId,
            subcmd
        };
    }

    getCallPartnerUserId(call) {
        const values = [
            call && call.calleeSignalId,
            call && call.callerId,
            call && call.calleeId,
            call && call.calleeNoisedId
        ];

        for (const value of values) {
            const parsed = this.toUInt32(value);
            if (parsed !== null) {
                return parsed;
            }
        }

        return null;
    }

    noteRelayPacket(relay, direction, bytes) {
        const count = direction === 'local-to-remote' ?
            relay.localPackets :
            relay.remotePackets;

        if (count !== 1 && count % 250 !== 0) {
            return;
        }

        this.record('mediaRelayPacket', Object.assign(this.getRelaySummary(relay), {
            direction,
            bytes
        }));
    }

    getRelaySummary(relay) {
        return {
            localPort: relay.localPort,
            receivePort: relay.receivePort,
            videoReceivePort: relay.videoReceivePort || undefined,
            remote: `${relay.remoteHost}:${relay.remotePort}`,
            localPackets: relay.localPackets,
            localBytes: relay.localBytes,
            remotePackets: relay.remotePackets,
            remoteBytes: relay.remoteBytes,
            localPayload: relay.localPayload,
            videoPayload: relay.videoPayload || undefined,
            remotePlainPayload: relay.remotePlainPayload === null ? undefined : relay.remotePlainPayload,
            remoteVideoPayload: relay.remoteVideoPayload === null ? undefined : relay.remoteVideoPayload,
            remoteVideoSsrc: relay.remoteVideoSsrc === null ? undefined : relay.remoteVideoSsrc,
            remoteVideoNalTypes: relay.remoteVideoNalTypes && relay.remoteVideoNalTypes.size ?
                Array.from(relay.remoteVideoNalTypes).sort((a, b) => a - b) :
                undefined,
            remoteVideoHasSps: relay.remoteVideoHasSps || undefined,
            remoteVideoHasPps: relay.remoteVideoHasPps || undefined,
            remoteVideoHasIdr: relay.remoteVideoHasIdr || undefined,
            videoKeyframeRequests: relay.videoKeyframeRequests || undefined,
            localPayloadRewritePackets: relay.localPayloadRewritePackets || undefined,
            localSsrcRewritePackets: relay.localSsrcRewritePackets || undefined,
            localRtcpPackets: relay.localRtcpPackets || undefined,
            localZrtcControlPackets: relay.localZrtcControlPackets || undefined,
            remotePayloadRewritePackets: relay.remotePayloadRewritePackets || undefined,
            zrtcMedia: relay.zrtcMediaEnabled || undefined,
            zrtcPacketMode: relay.zrtcPacketMode || undefined,
            zrtcAnswerDowngraded: this.isZrtcAnswerDowngraded(relay) || undefined,
            zrtcToken: relay.zrtcToken || undefined,
            zrtcInitAttempts: relay.zrtcInitAttempts || undefined,
            zrtcWrappedLocalPackets: relay.zrtcWrappedLocalPackets || undefined,
            zrtcDroppedLocalPackets: relay.zrtcDroppedLocalPackets || undefined,
            zrtcPlainFallbackPackets: relay.zrtcPlainFallbackPackets || undefined,
            zrtcDualLocalPackets: relay.zrtcDualLocalPackets || undefined,
            zrtcDualWrapperPackets: relay.zrtcDualWrapperPackets || undefined,
            zrtcRemoteAudioPackets: relay.zrtcRemoteAudioPackets || undefined,
            zrtcRemoteVideoPackets: relay.zrtcRemoteVideoPackets || undefined,
            zrtcRemoteVideoInvalidPackets: relay.zrtcRemoteVideoInvalidPackets || undefined,
            zrtcRemoteVideoDroppedPackets: relay.zrtcRemoteVideoDroppedPackets || undefined,
            zrtcRemoteRtcpPackets: relay.zrtcRemoteRtcpPackets || undefined,
            zrtcRemoteControlPackets: relay.zrtcRemoteControlPackets || undefined,
            zrtcRemotePlainPackets: relay.zrtcRemotePlainPackets || undefined,
            zrtcRemoteUnknownPackets: relay.zrtcRemoteUnknownPackets || undefined,
            zrtcPlainOnlyLocalPackets: relay.zrtcPlainOnlyLocalPackets || undefined
        };
    }

    isRtpPacket(message) {
        return !!(
            message &&
            message.length >= 12 &&
            (message[0] & 0xc0) === 0x80
        );
    }

    getRtpPayloadType(message) {
        if (!this.isRtpPacket(message)) {
            return null;
        }

        return message[1] & 0x7f;
    }

    getRtpSequence(message) {
        if (!this.isRtpPacket(message)) {
            return null;
        }

        return message.readUInt16BE(2);
    }

    getRtpSsrc(message) {
        if (!this.isRtpPacket(message)) {
            return null;
        }

        return message.readUInt32BE(8);
    }

    getRtpPayloadByteLength(message) {
        const headerLength = this.getRtpHeaderLength(message);
        if (headerLength === null) {
            return 0;
        }

        const paddingLength = (message[0] & 0x20) !== 0 ? message[message.length - 1] : 0;
        const payloadLength = message.length - headerLength - paddingLength;
        return payloadLength > 0 ? payloadLength : 0;
    }

    getRtpHeaderLength(message) {
        if (!this.isRtpPacket(message)) {
            return null;
        }

        const csrcCount = message[0] & 0x0f;
        let headerLength = 12 + csrcCount * 4;
        if (message.length < headerLength) {
            return null;
        }

        if ((message[0] & 0x10) !== 0) {
            if (message.length < headerLength + 4) {
                return null;
            }

            const extensionWords = message.readUInt16BE(headerLength + 2);
            headerLength += 4 + extensionWords * 4;
        }

        return message.length >= headerLength ? headerLength : null;
    }

    getH264NalTypeFromRtp(message) {
        const nalTypes = this.getH264NalTypesFromRtp(message);
        return nalTypes.length ? nalTypes[0] : null;
    }

    getH264NalTypesFromRtp(message) {
        const headerLength = this.getRtpHeaderLength(message);
        if (headerLength === null || message.length <= headerLength) {
            return [];
        }

        const paddingLength = (message[0] & 0x20) !== 0 ? message[message.length - 1] : 0;
        const payloadEnd = Math.max(headerLength, message.length - paddingLength);
        const payload = message.subarray(headerLength, payloadEnd);
        if (!payload.length) {
            return [];
        }

        const nalType = payload[0] & 0x1f;
        if (nalType === 24) {
            return this.getStapANalTypes(payload);
        }

        if ((nalType === 28 || nalType === 29) && payload.length >= 2) {
            return [payload[1] & 0x1f];
        }

        return [nalType];
    }

    getStapANalTypes(payload) {
        const nalTypes = [];
        let offset = 1;
        while (offset + 2 <= payload.length) {
            const nalLength = payload.readUInt16BE(offset);
            offset += 2;
            if (!nalLength || offset + nalLength > payload.length) {
                break;
            }

            nalTypes.push(payload[offset] & 0x1f);
            offset += nalLength;
        }

        return nalTypes;
    }

    getH264PayloadFromRtp(message) {
        const headerLength = this.getRtpHeaderLength(message);
        if (headerLength === null || message.length <= headerLength) {
            return null;
        }

        const paddingLength = (message[0] & 0x20) !== 0 ? message[message.length - 1] : 0;
        const payloadEnd = Math.max(headerLength, message.length - paddingLength);
        return message.subarray(headerLength, payloadEnd);
    }

    isSupportedH264NalType(nalType) {
        return Number.isInteger(nalType) &&
            ((nalType >= 1 && nalType <= 24) || nalType === 28 || nalType === 29);
    }

    rewriteRtpPayloadType(message, payload) {
        payload = this.toPayloadType(payload);
        if (payload === null || !this.isRtpPacket(message)) {
            return message;
        }

        const rewritten = Buffer.from(message);
        rewritten[1] = (rewritten[1] & 0x80) | payload;
        return rewritten;
    }

    rewriteRtpSsrc(message, ssrc) {
        const parsed = this.toUInt32(ssrc);
        if (parsed === null || !this.isRtpPacket(message)) {
            return message;
        }

        const rewritten = Buffer.from(message);
        rewritten.writeUInt32BE(parsed >>> 0, 8);
        return rewritten;
    }

    isLoopbackAddress(address) {
        return address === '127.0.0.1' ||
            address === '::1' ||
            address === '::ffff:127.0.0.1' ||
            /^127\./.test(address || '');
    }

    isRemoteEndpoint(relay, rinfo) {
        if (!relay || !rinfo) {
            return false;
        }

        return rinfo.port === relay.remotePort &&
            this.normalizeIpAddress(rinfo.address) === this.normalizeIpAddress(relay.remoteHost);
    }

    normalizeIpAddress(address) {
        return String(address || '').replace(/^::ffff:/, '');
    }

    pruneRecentPorts() {
        const now = Date.now();
        for (const [port, expiresAt] of this.recentPorts.entries()) {
            if (expiresAt <= now) {
                this.recentPorts.delete(port);
            }
        }
    }

    rememberRecentPort(port) {
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
            return;
        }

        const ttlMs = Math.max(1000, Number(process.env.ZALO_LINUX_CALL_PORT_REUSE_TTL_MS || 8000));
        this.recentPorts.set(port, Date.now() + ttlMs);
    }

    isRecentPort(port) {
        this.pruneRecentPorts();
        return this.recentPorts.has(port);
    }

    pickLocalPort(envName, base) {
        const configured = Number(process.env[envName] || 0);
        if (Number.isInteger(configured) && configured > 0 && configured <= 65535) {
            return configured;
        }

        const safeBase = Math.max(1024, Math.min(65534, Number(base) || 50000));
        const maxOffset = Math.max(1, Math.min(10000, 65535 - safeBase));
        for (let attempt = 0; attempt < 64; attempt += 1) {
            const port = safeBase + crypto.randomInt(maxOffset);
            if (!this.isRecentPort(port) && this.isUdpPortAvailable(port)) {
                this.rememberRecentPort(port);
                return port;
            }
        }

        const fallback = safeBase + crypto.randomInt(maxOffset);
        this.rememberRecentPort(fallback);
        return fallback;
    }

    isUdpPortAvailable(port) {
        // GStreamer fails hard if udpsrc picks a port already owned by another
        // process. `ss` is cheap and available on normal Linux desktops.
        const result = spawnSync('ss', ['-H', '-lun', `sport = :${port}`], {
            encoding: 'utf8',
            timeout: 500
        });

        if (result.status !== 0) {
            return true;
        }

        return !String(result.stdout || '').trim();
    }

    getFirstValue(...values) {
        for (const value of values) {
            if (value !== undefined && value !== null && value !== '') {
                return value;
            }
        }

        return undefined;
    }

    toUInt32(value) {
        if (value === undefined || value === null || value === '') {
            return null;
        }

        const number = Number(value);
        if (!Number.isFinite(number) || number < 0 || number > 0xffffffff) {
            return null;
        }

        return number >>> 0;
    }

    toPayloadType(value) {
        if (value === undefined || value === null || value === '') {
            return null;
        }

        const number = Number(value);
        if (!Number.isInteger(number) || number < 0 || number > 127) {
            return null;
        }

        return number;
    }

    getGstDevices(deviceClass) {
        // Parse gst-device-monitor output loosely. Device IDs are informational
        // for now because autoaudiosrc/autovideosrc choose the runtime default.
        const result = spawnSync('gst-device-monitor-1.0', [deviceClass], {
            encoding: 'utf8',
            timeout: 3000
        });
        if (result.status !== 0 || !result.stdout) {
            return [];
        }

        const devices = [];
        let current = null;
        for (const line of result.stdout.split(/\r?\n/)) {
            const name = line.match(/^\s*name\s+:\s+(.+)$/);
            if (name) {
                current = {
                    id: name[1],
                    name: name[1],
                    key: name[1]
                };
                devices.push(current);
                continue;
            }

            const launch = line.match(/^\s*gst-launch-1\.0\s+(.+)$/);
            if (launch && current) {
                current.pipeline = launch[1];
            }
        }

        return devices;
    }

    parseAddress(address) {
        // Zalo returns RTP endpoints as "host:port"; IPv6 may be bracketed.
        if (!address || typeof address !== 'string') {
            return null;
        }

        const match = address.match(/^\[?([^\]]+?)\]?:(\d+)$/);
        if (!match) {
            return null;
        }

        return {
            host: match[1],
            port: Number(match[2])
        };
    }

    getVideoPayload(codec) {
        const selected = this.selectVideoCodec(codec);
        return Number(selected && selected.payload || process.env.ZALO_LINUX_CALL_VIDEO_PAYLOAD || 97);
    }

    getDefaultVideoCodec() {
        return {
            name: 'h264',
            payload: Number(process.env.ZALO_LINUX_CALL_VIDEO_PAYLOAD || 97)
        };
    }

    selectVideoCodec(...values) {
        const codecs = [];
        for (const value of values) {
            codecs.push(...this.collectVideoCodecs(value));
        }

        const normalized = codecs
            .filter((codec) => codec && typeof codec === 'object')
            .map((codec) => Object.assign({}, codec, {
                payload: Number(codec.payload)
            }))
            .filter((codec) => Number.isInteger(codec.payload) && codec.payload >= 0 && codec.payload <= 127);

        if (!normalized.length) {
            return null;
        }

        const explicitPayload = Number(process.env.ZALO_LINUX_CALL_VIDEO_PAYLOAD);
        if (Number.isInteger(explicitPayload)) {
            const explicit = normalized.find((codec) => codec.payload === explicitPayload);
            if (explicit) {
                return explicit;
            }
        }

        return normalized.find((codec) => /h264/i.test(String(codec.name || ''))) ||
            normalized.find((codec) => codec.payload === 97) ||
            normalized[0];
    }

    collectVideoCodecs(value, seen = new WeakSet()) {
        if (!value) {
            return [];
        }

        if (typeof value === 'string') {
            const parsed = this.parseJsonObject(value);
            return Object.keys(parsed).length ? this.collectVideoCodecs(parsed, seen) : [];
        }

        if (Array.isArray(value)) {
            return value.filter((item) => item && typeof item === 'object');
        }

        if (typeof value !== 'object') {
            return [];
        }

        if (seen.has(value)) {
            return [];
        }
        seen.add(value);

        const codecs = [];
        if (value.video && Array.isArray(value.video.codec)) {
            codecs.push(...value.video.codec);
        }

        if (value.videoCodec) {
            codecs.push(...this.collectVideoCodecs([value.videoCodec], seen));
        }

        if (value.extendData || value.extend_data) {
            codecs.push(...this.collectVideoCodecs(value.extendData || value.extend_data, seen));
        }

        if (value.extraData) {
            const extra = this.parseJsonObject(value.extraData);
            codecs.push(...this.collectVideoCodecs(extra.extendData || extra.extend_data || extra, seen));
        }

        if (value.params) {
            codecs.push(...this.collectVideoCodecs(this.parseJsonObject(value.params), seen));
        }

        return codecs;
    }

    parseJsonObject(value) {
        if (!value) {
            return {};
        }

        if (typeof value === 'object' && !Array.isArray(value)) {
            return value;
        }

        if (typeof value !== 'string') {
            return {};
        }

        try {
            const parsed = JSON.parse(value.trim());
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (_) {
            return {};
        }
    }

    getPayload(codec) {
        const selected = this.selectCodec(codec);
        return Number(selected.payload || 112);
    }

    getSampleRate(codec) {
        const selected = this.selectCodec(codec);
        const match = String(selected.name || '').match(/opus\/(\d+)\//i);
        return match ? Number(match[1]) : 16000;
    }

    getChannels(codec) {
        const selected = this.selectCodec(codec);
        const match = String(selected.name || '').match(/opus\/\d+\/(\d+)/i);
        return match ? Number(match[1]) : 1;
    }

    getRtpClockRate(codec) {
        const selected = this.selectCodec(codec);
        if (/^opus\//i.test(String(selected.name || ''))) {
            return 48000;
        }

        return this.getSampleRate(selected);
    }

    selectCodec(codec) {
        if (codec && typeof codec === 'object' && !Array.isArray(codec)) {
            return codec;
        }

        const parsed = this.parseCodec(codec);
        const explicitPayload = Number(process.env.ZALO_LINUX_CALL_AUDIO_PAYLOAD);
        if (Number.isInteger(explicitPayload)) {
            const explicit = parsed.find((item) => Number(item && item.payload) === explicitPayload);
            if (explicit) {
                return explicit;
            }
        }

        // Match Linux signaling defaults: payload 112 is the working mono Opus
        // path for Zalo's current desktop peer behavior.
        return parsed.find((item) => Number(item && item.payload) === 112) ||
            parsed.find((item) => /opus\/16000\/1/i.test(String(item && item.name || ''))) ||
            parsed.find((item) => Number(item && item.payload) === 113) ||
            parsed[0] ||
            { payload: 112, name: 'opus/16000/1' };
    }

    parseCodec(codec) {
        if (!codec) {
            return [];
        }

        if (Array.isArray(codec)) {
            return codec;
        }

        if (typeof codec === 'object') {
            return [codec];
        }

        if (typeof codec !== 'string') {
            return [];
        }

        try {
            const parsed = JSON.parse(codec.trim());
            return Array.isArray(parsed) ? parsed : [parsed];
        } catch (_) {
            return [];
        }
    }
}

module.exports = LinuxMediaEngine;
