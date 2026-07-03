'use strict';

const crypto = require('crypto');
const LinuxCallEngine = require('./linux-call-engine');

class LinuxPeerJNI {
    constructor(options = {}) {
        this.engine = new LinuxCallEngine(options);
        this.latestCallConfig = {};
    }

    init(data) {
        this.latestCallConfig = Object.assign({}, this.latestCallConfig, data || {});
        return this.engine.init(data);
    }

    updateLocal(data) {
        return this.init(data);
    }

    listDevice() {
        return this.engine.getDeviceList();
    }

    getNativeDeviceList() {
        return this.engine.getNativeDeviceList();
    }

    getCallInfo() {
        return this.engine.getCallInfo();
    }

    isInCall() {
        return this.engine.isInCall();
    }

    isInVideoCall() {
        return this.engine.isInVideoCall();
    }

    makeCall(data) {
        return this.engine.makeCall(this.buildMakeCallPayload(data));
    }

    incomingCall(data) {
        return this.engine.handleControl({
            act_type: 'voip',
            act: 'request',
            data
        });
    }

    answerIncomingCall(data) {
        return this.engine.handleAnswerIncomingCall(data);
    }

    endCall(details) {
        return this.engine.handleEndCall(details);
    }

    receiveSignal(command, data) {
        return this.engine.handleRecvSignal(command, data);
    }

    receiveControl(data) {
        return this.engine.handleControl(data);
    }

    getCurrentCallId() {
        return this.engine.getCurrentCallId();
    }

    handleCallTimeout(callId) {
        return this.engine.handleCallTimeout(callId);
    }

    shutdown() {
        return this.engine.shutdown();
    }

    switchCamera() {
        return this.engine.switchCamera();
    }

    setPartnerOffCamera(status) {
        return this.engine.setPartnerOffCamera(status);
    }

    muteAudio(muted) {
        return this.engine.muteAudio(muted);
    }

    holdAudio(held) {
        return this.engine.holdAudio(held);
    }

    setSpeakerOn(enabled) {
        return this.engine.setSpeakerOn(enabled);
    }

    changeVideoDevice(id) {
        return this.engine.changeVideoDevice(id);
    }

    startDesktopCapture() {
        return this.engine.startDesktopCapture();
    }

    stopDesktopCapture() {
        return this.engine.stopDesktopCapture();
    }

    setAudioVolume(input, output) {
        return this.engine.setAudioVolume(input, output);
    }

    setAgc(auto) {
        return this.engine.setAgc(auto);
    }

    changeMinMaxMobileBitrate(minBitrate, maxBitrate) {
        return this.engine.changeMinMaxMobileBitrate(minBitrate, maxBitrate);
    }

    setConfiguredTransport(config) {
        return this.engine.setConfiguredTransport(config || {});
    }

    clearConfiguredTransport() {
        return this.engine.clearConfiguredTransport();
    }

    setMediaConfig(audioConfig, extendData) {
        return this.engine.setMediaConfig(audioConfig, extendData);
    }

    updateCallerInfo(audioConfig, extendData) {
        return this.engine.updateCallerInfo(audioConfig, extendData);
    }

    getJsonStats406(startNetworkType, endNetworkType) {
        return this.engine.getJsonStats406(startNetworkType, endNetworkType);
    }

    getExtendData() {
        return this.engine.getExtendData();
    }

    getActiveAudioCodecs() {
        return this.engine.getActiveAudioCodecs();
    }

    getSrtpKey() {
        return this.engine.getSrtpKey();
    }

    buildMakeCallPayload(data) {
        const payload = Object.assign({}, this.latestCallConfig || {}, data || {});
        const callId = this.getFirstValue(payload.callId, payload.id);

        if (!callId || String(callId) === '0') {
            payload.callId = this.generateCallId();
        }

        return payload;
    }

    getFirstValue(...values) {
        for (const value of values) {
            if (value !== undefined && value !== null && value !== '') {
                return value;
            }
        }

        return null;
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

module.exports = LinuxPeerJNI;
