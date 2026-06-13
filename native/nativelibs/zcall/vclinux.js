'use strict';

const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const ZCallBinding = require('./binding-linux.js');

const NO_INSTANCE_ERROR = -100;
const LOGIN_URL = 'https://vlogin.zaloapp.com/login';
const GENID_URL = 'http://api.conf.talk.zing.vn/genuid';
const CONFIG_URL = 'http://api.conf.talk.zing.vn/zls?action=call_config';

class VCLinux {
    constructor() {
        this.onEventFire = this.onEventFire.bind(this);
        this.instance = ZCallBinding.MainApp();
        this.authenObject = {
            _session: '',
            _genPeerId: 0,
            _config: ''
        };
        this.render = false;
        this.getVideoFrame = this.getVideoFrame.bind(this);
        this.getVideoFrameLocal = this.getVideoFrameLocal.bind(this);
        this.openRender = () => {
            this.render = false;
        };
        this.openRender = this.openRender.bind(this);
    }

    logEvent() {}

    logStep() {}

    incomingCall() {
        this.logStep('incomingCall');
        this.instance.incomingCall();
    }

    answerIncomingCall() {
        if (typeof this.instance.answerIncomingCall === 'function') {
            this.instance.answerIncomingCall();
        }
    }

    answerCall() {
        this.answerIncomingCall();
    }

    acceptCall() {
        this.answerIncomingCall();
    }

    startDesktopCapture() {
        this.instance.startDesktopCapture();
    }

    stopDesktopCapture() {
        this.instance.stopDesktopCapture();
    }

    holdAudio(hold, local = false) {
        this.instance.holdAudio(hold, local);
    }

    mute(isMute) {
        this.instance.mute(isMute);
    }

    stopCapture(isStop) {
        this.instance.stopCapture(isStop);
    }

    upgradeToVideoCall(options = {}) {
        if (typeof this.instance.upgradeToVideoCall === 'function') {
            this.instance.upgradeToVideoCall(options);
        } else {
            this.instance.stopCapture(false);
        }
    }

    switchToVideoCall(options = {}) {
        this.upgradeToVideoCall(options);
    }

    getOsInfo() {
        const parts = [];
        try {
            if (process && process.platform) parts.push(process.platform);
            if (process && process.arch) parts.push(process.arch);
        } catch (error) {
            this.error(error);
        }

        return parts.join(' ');
    }

    setConfigData(config, caller = true, isVideoCall = true) {
        return new Promise((resolve, reject) => {
            config = config || {};

            const settingsJson = JSON.stringify(config.settings || {});
            const userId = config.fromId;
            const partnerId = config.toId;
            const protocol = config.protocol;
            const callId = config.callId;
            const session = config.sessId;
            const enableChangeZRTP = !!(config.changeZRTP && config.changeZRTP.enable == 1);
            const servers = config.servers;
            const logPath = this.getCallLogPath(config);
            const osInfo = this.getOsInfo();
            const clientVersion = this.parseIntFallback(config.clientVersion, 0);

            const onDone = (zrtcConfig) => {
                // Match vcmac.js: all heavy native-shaped state is pushed into
                // the binding. On Linux, binding.js resolves to binding-linux.js.
                this.instance.setConfig(
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
                );

                if (!caller) {
                    this.instance.setMediaConfig(config.audioConfig || '', config.extendData);
                }

                if (servers && caller) {
                    this.instance.setListServers(JSON.stringify(servers));
                } else {
                    this.instance.setConfigServer(config.rtcpIP, config.rtpIP);
                }

                resolve(true);
            };

            if (config.zrtc_config) {
                onDone(JSON.stringify(config.zrtc_config));
                return;
            }

            this.getConfigState()
                .then(onDone)
                .catch((error) => {
                    this.error(error);
                    reject(error);
                });
        });
    }

    getCallLogPath(config) {
        try {
            const electron = require('electron');
            const app = electron.remote && electron.remote.app;
            const dir = app && app.getPath && app.getPath('userData');

            if (config && config.settings && config.settings.logDebug && dir) {
                return path.join(dir, 'call.log');
            }
        } catch (error) {
            this.error(error);
        }

        return '';
    }

    updateCallerInfo(audioConfig, extendData) {
        this.instance.updateCallerInfo(audioConfig, extendData);
    }

    bindGetPeerId(callback) {
        this.getPeerIdCallback = callback;
    }

    error() {}

    log() {}

    getCallInfo() {
        return this.instance.getCallInfo();
    }

    getJsonStats406(startNetworkType = 0, endNetworkType = 0) {
        return this.instance.getJsonStats406(startNetworkType, endNetworkType);
    }

    getListDevices() {
        return this.instance.getListDevices();
    }

    parseIntFallback(input, fallback) {
        const number = parseInt(input, 10);
        return Number.isFinite(number) ? number : fallback;
    }

    setAudioVolume(input, output) {
        try {
            input = this.parseIntFallback(input, 150);
            output = this.parseIntFallback(output, 150);
            return this.instance.setAudioVolume(input, output);
        } catch (error) {
            this.error(error);
            return false;
        }
    }

    changeAudioDevice(inputId, outputId) {
        try {
            inputId = this.parseIntFallback(inputId, -10);
            outputId = this.parseIntFallback(outputId, -10);
            this.instance.changeAudioDevice(inputId, outputId);
        } catch (error) {
            this.error(error);
        }
    }

    changeVideoDevice(id) {
        if (!id) {
            id = `__id_default__zzzz_${Date.now()}`;
        }

        this.instance.changeVideoDevice(id);
    }

    setAgc(auto) {
        this.instance.setAgc(!!auto);
    }

    getExtendData() {
        return this.instance.getExtendData();
    }

    getActiveAudioCodecs() {
        return this.instance.getActiveAudioCodecs();
    }

    getEventMessage() {
        if (this.instance) {
            return this.instance.getEventMessage();
        }

        return NO_INSTANCE_ERROR;
    }

    getVideoFrame(buff) {
        if (this.instance) {
            return this.instance.getVideoFrame(buff);
        }

        return null;
    }

    getVideoFrameLocal(buff) {
        if (this.instance) {
            return this.instance.getVideoFrameLocal(buff);
        }

        return null;
    }

    changeMinMaxMobileBitrate() {
        this.instance.changeMinMaxMobileBitrate();
    }

    setStartRender(callback) {
        this.callStart = callback;
    }

    onEventFire() {
        if (this.callStart) {
            this.callStart();
        }
    }

    check() {
        try {
            return this.instance.test(123) == 123;
        } catch (error) {
            this.error(error);
            return false;
        }
    }

    setState() {
        if (!this.authenObject._session || !this.authenObject._config) {
            return;
        }

        if (this.getPeerIdCallback) {
            this.getPeerIdCallback(this.authenObject._genPeerId);
        }

        this.instance.setState(
            this.authenObject._session,
            this.authenObject._genPeerId,
            this.authenObject._config
        );
    }

    stop() {
        if (this.instance) {
            this.instance.stop();
        }
    }

    makeCall() {
        this.logStep('make call');
        this.instance.makeCall();
    }

    setCallback() {
        const callback = this.onEventFire.bind(this);
        this.instance.setCallback(callback);
    }

    authenication() {
        const ans = this.authenObject;

        // Same logical flow as vcmac.js: login -> gen peer id -> call config.
        // Linux keeps the HTTP implementation tolerant because this module can
        // run in either Electron renderer/preload or Node test contexts.
        return this.sendHttp(LOGIN_URL, null, false, 2000)
            .then((res) => {
                const ret = this.parseJsonResponse(res);
                const data = ret && ret.data || {};

                if (ret && ret.err == 0 && data.err == 0) {
                    ans._session = data.session;
                    return this.sendHttp(GENID_URL, null, false, 2000);
                }

                throw new Error(this.getFirstValue(ret && ret.err, data.err, 'login failed'));
            })
            .then((res) => {
                const ret = this.parseJsonResponse(res);
                const data = ret && ret.data || {};

                if (ret && ret.err == 0 && data.id) {
                    ans._genPeerId = data.id;
                    return this.getConfigState();
                }

                throw new Error(this.getFirstValue(ret && ret.err, data.err, 'gen peer id failed'));
            })
            .then((configState) => {
                ans._config = configState;
                return ans;
            })
            .catch((error) => {
                this.error(error);
                throw error;
            });
    }

    getConfigState() {
        return this.sendHttp(CONFIG_URL, null, false, 2000)
            .then((res) => {
                const ret = this.parseJsonResponse(res);
                return JSON.stringify(ret && ret.config || {});
            })
            .catch((error) => {
                this.error(error);
                throw error;
            });
    }

    addParamsToUrl(url, params) {
        if (!params || typeof params !== 'object') {
            return url;
        }

        const target = new URL(url);
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) {
                target.searchParams.set(key, value);
            }
        }

        return target.toString();
    }

    sendHttp(url, query = null, post = false, timeout = null) {
        const requestUrl = this.addParamsToUrl(url, post ? null : query);

        if (typeof XMLHttpRequest !== 'undefined') {
            return this.sendHttpByXhr(requestUrl, query, post, timeout);
        }

        return this.sendHttpByNode(requestUrl, query, post, timeout);
    }

    sendHttpByXhr(url, query = null, post = false, timeout = null) {
        return new Promise((resolve, reject) => {
            const request = new XMLHttpRequest();

            if (timeout) {
                request.timeout = timeout;
            }

            request.open(post ? 'POST' : 'GET', url, true);
            request.setRequestHeader('Accept', 'application/json, text/plain, */*');
            request.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
            request.onerror = reject;
            request.onabort = reject;
            request.ontimeout = reject;
            request.onreadystatechange = () => {
                if (request.readyState !== 4) {
                    return;
                }

                if (request.status === 200) {
                    resolve(request.responseText);
                } else {
                    reject(request.responseText);
                }
            };
            request.send(post ? this.encodeParams(query) : null);
        });
    }

    sendHttpByNode(url, query = null, post = false, timeout = null) {
        return new Promise((resolve, reject) => {
            const target = new URL(url);
            const client = target.protocol === 'https:' ? https : http;
            const body = post ? this.encodeParams(query) : null;
            const request = client.request({
                method: post ? 'POST' : 'GET',
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port,
                path: `${target.pathname}${target.search}`,
                headers: {
                    Accept: 'application/json, text/plain, */*',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': body ? Buffer.byteLength(body) : 0
                },
                timeout
            }, (response) => {
                let data = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => {
                    data += chunk;
                });
                response.on('end', () => {
                    if (response.statusCode >= 200 && response.statusCode < 300) {
                        resolve(data);
                    } else {
                        reject(data);
                    }
                });
            });

            request.on('error', reject);
            request.on('timeout', () => {
                request.destroy(new Error(`Request timeout: ${url}`));
            });

            if (body) {
                request.write(body);
            }

            request.end();
        });
    }

    encodeParams(params) {
        if (!params || typeof params !== 'object') {
            return '';
        }

        return new URLSearchParams(params).toString();
    }

    parseJsonResponse(responseText) {
        try {
            return JSON.parse(responseText);
        } catch (error) {
            this.error(error);
            throw error;
        }
    }

    getFirstValue(...values) {
        for (const value of values) {
            if (value !== undefined && value !== null && value !== '') {
                return value;
            }
        }

        return null;
    }
}

const instance = new VCLinux();
module.exports = instance;
