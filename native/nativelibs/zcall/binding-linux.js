'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const LinuxCallEngine = require('../../qt-call-cap-linux/linux-call-engine');

const DEFAULT_AUDIO_CODEC = [
    { frmPtime: 20, payload: 112, name: 'opus/16000/1', dynamicFptime: 0 },
    { frmPtime: 20, payload: 113, name: 'opus/48000/2', dynamicFptime: 0 }
];
const NATIVE_EVENT_TYPES = new Set([
    'onCallAudioState',
    'onCallAutoHangup',
    'onCallChangeZRTP',
    'onCallQualityChanged',
    'onCallState',
    'onCallVideoState',
    'onIncomingCall',
    'onInitZrtpRequestFailed',
    'onInitZrtpWithServer',
    'onMakeCall'
]);

function isLinuxCallEnabled() {
    return process.platform === 'linux' &&
        (process.env.ZALO_ENABLE_LINUX_CALL === '1' ||
            process.env.ZALO_ENABLE_CALL_MOCK === '1');
}

function safeJsonParse(value, fallback = {}) {
    if (!value) {
        return fallback;
    }

    if (typeof value === 'object') {
        return value;
    }

    try {
        return JSON.parse(value);
    } catch (_) {
        return fallback;
    }
}

class LinuxZCallBinding {
    constructor() {
        this.callback = null;
        this.eventQueue = [];
        this.protocolQueue = [];
        this.config = {};
        this.settings = {};
        this.mediaConfig = {};
        this.servers = [];
        this.localState = {};
        this.logPath = process.env.ZALO_CALL_LOG ||
            path.join(os.tmpdir(), 'zalo-call-linux-binding.log');

        // This is the JS replacement for the missing Linux zcall_*.node binary.
        // It preserves the native binding method names consumed by vcmac.js,
        // then delegates signaling/window/media state to qt-call-cap-linux.
        this.engine = new LinuxCallEngine({
            log: this.log.bind(this),
            send: this.enqueueEngineEvent.bind(this),
            nativeEvents: true
        });
    }

    log(message, data) {
        const suffix = data ? ` ${JSON.stringify(data)}` : '';
        const line = `[${new Date().toISOString()}] ${message}${suffix}\n`;

        try {
            fs.appendFileSync(this.logPath, line);
        } catch (_) {}
    }

    enqueueEvent(message) {
        if (!message) {
            return;
        }

        this.eventQueue.push(message);

        // The original native callback is mainly a wake-up signal; the wrapper
        // still consumes concrete events through getEventMessage().
        if (this.callback) {
            try {
                this.callback();
            } catch (error) {
                this.log('callback failed', { message: error.message });
            }
        }
    }

    enqueueEngineEvent(message) {
        this.enqueueProtocolEvent(message);
        this.enqueueNativeEvents();
    }

    enqueueProtocolEvent(message) {
        if (message) {
            this.protocolQueue.push(message);
            if (this.callback) {
                try {
                    this.callback();
                } catch (error) {
                    this.log('callback failed', { message: error.message });
                }
            }
        }
    }

    enqueueResponses(responses) {
        for (const response of responses || []) {
            this.enqueueProtocolEvent(response);
        }

        this.enqueueNativeEvents();
    }

    enqueueNativeEvents() {
        if (!this.engine || typeof this.engine.drainNativeEvents !== 'function') {
            return;
        }

        for (const event of this.engine.drainNativeEvents()) {
            if (NATIVE_EVENT_TYPES.has(event && event.type)) {
                this.enqueueEvent(event);
            }
        }
    }

    test(value) {
        // vcmac.check() expects native test(123) to echo 123.
        return isLinuxCallEnabled() ? value : false;
    }

    check() {
        return isLinuxCallEnabled();
    }

    setCallback(callback) {
        this.callback = typeof callback === 'function' ? callback : null;
    }

    setConfig(
        settingsJson,
        userId,
        partnerId,
        protocol,
        callId,
        session,
        zrtcConfig,
        enableChangeZRTP,
        isVideoCall,
        logPath,
        osInfo,
        clientVersion
    ) {
        this.settings = safeJsonParse(settingsJson, {});
        if (logPath) {
            this.logPath = logPath;
        }

        // Store every field that vcmac.js normally passes into zcall_mac.node.
        // Later makeCall()/incomingCall() converts this native-shaped state to
        // LinuxCallEngine's protocol-shaped payload.
        this.config = {
            userId,
            fromId: userId,
            toId: partnerId,
            partnerId,
            protocol,
            callId,
            sessId: session,
            session,
            zrtc_config: safeJsonParse(zrtcConfig, {}),
            changeZRTP: { enable: enableChangeZRTP ? 1 : 0 },
            isVideoCall: !!isVideoCall,
            settings: this.settings,
            osInfo,
            clientVersion
        };
        this.engine.clearConfiguredTransport();
    }

    setConfigData(config) {
        // Some call sites may talk to the binding directly instead of going
        // through vcmac.js. Match native _initCallConfig: each call receives
        // a fresh config object instead of inheriting callId/session/transport.
        this.config = Object.assign({}, config || {});
        this.settings = this.config.settings || this.settings || {};
        this.engine.clearConfiguredTransport();
        return Promise.resolve(true);
    }

    setConfigServer(rtcpAddress, rtpAddress) {
        this.config = Object.assign({}, this.config, {
            rtcpIP: rtcpAddress,
            rtpIP: rtpAddress,
            rtcpAddress,
            rtpAddress
        });
        if (rtcpAddress || rtpAddress) {
            this.engine.setConfiguredTransport(this.config);
        } else {
            this.engine.clearConfiguredTransport();
        }
        this.enqueueNativeEvents();
    }

    setListServers(serversJson) {
        const servers = safeJsonParse(serversJson, []);
        this.servers = Array.isArray(servers) ? servers : [];

        if (this.servers[0]) {
            this.setConfigServer(this.servers[0].rtcpaddr, this.servers[0].rtpaddr);
        }
    }

    setMediaConfig(audioConfig, extendData) {
        this.mediaConfig = { audioConfig, extendData };
        this.config = Object.assign({}, this.config, {
            audioConfig,
            extendData
        });
        this.engine.setMediaConfig(audioConfig, extendData);
        this.enqueueNativeEvents();
    }

    setState(session, peerId, zrtcConfig) {
        this.config = Object.assign({}, this.config, {
            authSession: session,
            genPeerId: peerId,
            zrtc_config: safeJsonParse(zrtcConfig, this.config.zrtc_config || {})
        });
    }

    updateCallerInfo(audioConfig, extendData) {
        this.setMediaConfig(audioConfig, extendData);
        this.engine.updateCallerInfo(audioConfig, extendData);
        this.enqueueNativeEvents();
    }

    makeCall() {
        if (!this.check()) {
            this.enqueueProtocolEvent(this.buildPopup('ZaloCall Linux', 'Linux call mode is not enabled.'));
            return;
        }

        this.enqueueResponses(this.engine.makeCall(this.buildMakeCallPayload()));
    }

    incomingCall() {
        if (!this.check()) {
            this.enqueueProtocolEvent(this.buildPopup('ZaloCall Linux', 'Linux call mode is not enabled.'));
            return;
        }

        this.enqueueResponses(this.engine.handleControl(this.buildIncomingControl()));
    }

    answerIncomingCall() {
        this.enqueueResponses(this.engine.handleAnswerIncomingCall());
    }

    answerCall() {
        this.answerIncomingCall();
    }

    acceptCall() {
        this.answerIncomingCall();
    }

    stop() {
        this.enqueueResponses(this.engine.handleEndCall({ source: 'zcall-binding' }));
    }

    mute(isMute) {
        this.enqueueResponses(this.engine.handleControl({
            act_type: 'voip',
            act: isMute ? 'mute_audio' : 'unmute_audio'
        }));
    }

    stopCapture(isStop) {
        this.enqueueResponses(this.engine.handleControl({
            act_type: 'voip',
            act: isStop ? 'stop_capture' : 'start_capture'
        }));
    }

    holdAudio(hold) {
        this.enqueueResponses(this.engine.handleControl({
            act_type: 'voip',
            act: hold ? 'hold_audio' : 'resume_audio'
        }));
    }

    getCallInfo() {
        return JSON.stringify(this.engine.getCallInfo());
    }

    getJsonStats406(startNetworkType = 0, endNetworkType = 0) {
        return JSON.stringify(this.engine.getJsonStats406(startNetworkType, endNetworkType));
    }

    getListDevices() {
        return JSON.stringify(this.engine.getNativeDeviceList());
    }

    getEventMessage() {
        const event = this.protocolQueue.shift() || this.eventQueue.shift();
        return event ? JSON.stringify(event) : null;
    }

    getProtocolMessage() {
        const event = this.protocolQueue.shift();
        return event ? JSON.stringify(event) : null;
    }

    getVideoFrame() {
        return null;
    }

    getVideoFrameLocal() {
        return null;
    }

    changeAudioDevice(inputId, outputId) {
        this.engine.changeAudioDevice(inputId, outputId);
        this.enqueueNativeEvents();
    }

    setAudioVolume(input, output) {
        const result = this.engine.setAudioVolume(input, output);
        this.enqueueNativeEvents();
        return result;
    }

    changeVideoDevice(id) {
        this.engine.changeVideoDevice(id);
        this.enqueueNativeEvents();
    }

    setAgc(auto) {
        this.engine.setAgc(!!auto);
        this.enqueueNativeEvents();
    }

    startDesktopCapture() {
        this.engine.startDesktopCapture();
        if (this.engine.currentCall && !this.engine.isVideoCall(this.engine.currentCall)) {
            this.enqueueResponses(this.engine.upgradeToVideoCall(this.config));
            return;
        }
        this.enqueueNativeEvents();
    }

    stopDesktopCapture() {
        this.engine.stopDesktopCapture();
        this.enqueueNativeEvents();
    }

    upgradeToVideoCall(options = {}) {
        this.enqueueResponses(this.engine.upgradeToVideoCall(Object.assign({}, this.config, options || {})));
    }

    switchToVideoCall(options = {}) {
        this.upgradeToVideoCall(options);
    }

    changeMinMaxMobileBitrate(minBitrate, maxBitrate) {
        this.engine.changeMinMaxMobileBitrate(minBitrate, maxBitrate);
        this.enqueueNativeEvents();
    }

    getExtendData() {
        const extendData = this.engine.getExtendData() || this.config.extendData || {};
        return typeof extendData === 'string' ? extendData : JSON.stringify(extendData);
    }

    getActiveAudioCodecs() {
        return safeJsonParse(this.engine.getAudioCodec(), DEFAULT_AUDIO_CODEC);
    }

    bindGetPeerId(callback) {
        this.getPeerIdCallback = typeof callback === 'function' ? callback : null;
    }

    authenication() {
        return Promise.resolve({
            _session: this.config.authSession || '',
            _genPeerId: this.config.genPeerId || 0,
            _config: JSON.stringify(this.config.zrtc_config || {})
        });
    }

    buildMakeCallPayload() {
        const config = this.config || {};
        const callId = this.ensureOutgoingCallId(config);
        const partner = {
            id: this.getFirstValue(config.toId, config.partnerId, config.calleeId),
            avatar: this.getFirstValue(config.partnerAvatar, config.avatar),
            name: this.getFirstValue(config.partnerName, config.toName, config.calleeName)
        };

        return {
            partner: [partner],
            type: this.getCallType(config),
            fromId: config.fromId,
            userId: config.userId,
            protocol: config.protocol,
            callId,
            sessId: config.sessId || config.session,
            settings: config.settings,
            zrtc_config: config.zrtc_config,
            changeZRTP: config.changeZRTP,
            groupInfo: config.groupInfo || null,
            isFirstCall: config.isFirstCall
        };
    }

    buildIncomingControl() {
        const config = this.config || {};

        return {
            act_type: 'voip',
            act: 'request',
            data: {
                uidFrom: this.getFirstValue(config.fromId, config.callerId),
                uidTo: this.getFirstValue(config.toId, config.calleeId),
                uidN: this.getFirstValue(config.fromNoisedId, config.uidN),
                callId: this.getFirstValue(config.callId, config.id),
                status: '0',
                codec: this.getCodecJson(config),
                session: this.getFirstValue(config.sessId, config.session),
                rtpAddress: this.getFirstValue(config.rtpIP, config.rtpAddress),
                rtcpAddress: this.getFirstValue(config.rtcpIP, config.rtcpAddress),
                params: JSON.stringify(config),
                audioConfig: config.audioConfig || this.mediaConfig.audioConfig || '',
                extendData: config.extendData || this.mediaConfig.extendData || '',
                video: { enable: this.getCallType(config) === 3 ? 1 : 0 }
            }
        };
    }

    getCodecJson(config) {
        return this.getFirstValue(
            config && config.codec,
            config && config.audioConfig,
            JSON.stringify(DEFAULT_AUDIO_CODEC)
        );
    }

    getCallType(config) {
        if (config && config.callType) {
            return Number(config.callType);
        }

        return config && config.isVideoCall ? 3 : 1;
    }

    buildPopup(header, content) {
        return {
            type: 'request',
            command: 'popup',
            data: { header, content }
        };
    }

    getFirstValue(...values) {
        for (const value of values) {
            if (value !== undefined && value !== null && value !== '') {
                return value;
            }
        }

        return null;
    }

    ensureOutgoingCallId(config) {
        const callId = this.getFirstValue(config.callId, config.id);
        if (callId && String(callId) !== '0') {
            return callId;
        }

        const generatedCallId = this.generateCallId();
        config.callId = generatedCallId;
        return generatedCallId;
    }

    generateCallId() {
        try {
            const value = crypto.randomBytes(4).readUInt32BE(0);
            return String(100000000 + (value % 900000000));
        } catch (_) {
            return String(100000000 + (Date.now() % 900000000));
        }
    }
}

module.exports = {
    MainApp: () => new LinuxZCallBinding()
};
