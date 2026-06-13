function shouldUseLinuxCallBackend() {
    return process.platform === 'linux' &&
        (process.env.ZALO_ENABLE_LINUX_CALL === '1' ||
            process.env.ZALO_ENABLE_CALL_MOCK === '1');
}

// macOS uses the proprietary zcall_mac.node through vcmac.js. Linux gets a
// JS backend with the same public methods and delegates media/signaling to
// native/qt-call-cap-linux/LinuxCallEngine.
var CallBackend = shouldUseLinuxCallBackend() ? require('./vclinux.js') : require('./vcmac.js');
var ZScreenObject = require('./screen-object.js');
var ZScreenCanvasObject = require('./screen-object-canvas.js');

const NO_INSTANCE_ERROR = -100;

class ZCallController {
    constructor() {
        this.localScreen = null;
        this.remoteScreen = null;
        this.backend = CallBackend;
        this.enableCheckEventMessage = false;
        this.doCheckEventMessage = this.doCheckEventMessage.bind(this);
        this.callback = this.callback.bind(this);
        this.bindCanvas = this.bindCanvas.bind(this);
    }
    bindCanvas(localCanvas, remoteCanvas, canvasMode = false, getSizeLocalContainer, getSizeRemoteContainer) {
        let backend = this.backend;
        if (canvasMode) {
            this.localScreen = new ZScreenCanvasObject(localCanvas, {
                width: 640,
                height: 480
            }, "localScreen", getSizeLocalContainer);
            this.remoteScreen = new ZScreenCanvasObject(remoteCanvas, {
                width: 360,
                height: 480
            }, "remoteScreen", getSizeRemoteContainer);
        } else {
            this.localScreen = new ZScreenObject(localCanvas, {
                width: 640,
                height: 480
            }, "localScreen", getSizeLocalContainer);
            this.remoteScreen = new ZScreenObject(remoteCanvas, {
                width: 360,
                height: 480
            }, "remoteScreen", getSizeRemoteContainer);
        }


        this.localScreen.setSourceFrame(backend.getVideoFrameLocal);
        this.remoteScreen.setSourceFrame(backend.getVideoFrame);
    }
    stop() {
        this.enableCheckEventMessage = false;
        if (this.localScreen) {
            this.localScreen.stop();
            delete this.localScreen;
        }
        if (this.remoteScreen) {
            this.remoteScreen.stop();
            delete this.remoteScreen;
        }
        if (this.backend)
            this.backend.stop();
    }

    bindCallbackEventMessage(fn) {
        this.callbackEventMessage = fn;
    }

    checkEventMessage() {
        if (this.enableCheckEventMessage) {
            this.doCheckEventMessage();
        }
    }
    render() {
        if (this.localScreen) this.localScreen.render();
        if (this.remoteScreen) this.remoteScreen.render();
    }

    startRender() {
        if (this.localScreen) this.localScreen.startRender();
        if (this.remoteScreen) this.remoteScreen.startRender();
    }
    getActiveAudioCodecs() {
        return this.backend.getActiveAudioCodecs();
    }

    holdAudio(hold, local) {
        this.backend.holdAudio(hold, local);
    }

    mute(isMute) {
        this.backend.mute(!!isMute);
    }

    stopCapture(isStop) {
        this.backend.stopCapture(!!isStop);
    }

    upgradeToVideoCall(options = {}) {
        if (this.backend && typeof this.backend.upgradeToVideoCall === 'function') {
            this.backend.upgradeToVideoCall(options);
            return;
        }

        this.stopCapture(false);
    }

    switchToVideoCall(options = {}) {
        this.upgradeToVideoCall(options);
    }

    getCallInfo() {
        return this.backend.getCallInfo();
    }

    getJsonStats406(startNetworkType = 0, endNetworkType = 0) {
        return this.backend.getJsonStats406(startNetworkType, endNetworkType);
    }

    changeAudioDevice(inputId, outputId) {
        this.backend.changeAudioDevice(inputId, outputId);
    }

    setAudioVolume(input, output) {
        return this.backend.setAudioVolume(input, output);
    }

    changeVideoDevice(id) {
        this.backend.changeVideoDevice(id);
    }
    setAgc(auto) {
        this.backend.setAgc(auto);
    }
    startDesktopCapture() {
        this.backend.startDesktopCapture();
    }
    stopDesktopCapture() {
        this.backend.stopDesktopCapture();
    }
    changeMinMaxMobileBitrate() {
        this.backend.changeMinMaxMobileBitrate();
    }

    getExtendData() {
        return this.backend.getExtendData();
    }

    callback(data) {
        if (this.callbackEventMessage) this.callbackEventMessage(data);
    }

    getListDevices() {
        return this.backend.getListDevices();
    }

    test() {
        return this.backend.check();
    }

    doCheckEventMessage() {
        let x = this.backend.getEventMessage();
        if (x) {
            if (x == NO_INSTANCE_ERROR) {
                console.error("no instance error, stop getEventMessage");
                return;
            }
            try {
                x = JSON.parse(x);
                this.callback(x);
            } catch (e) {
                console.error(e);
            }
        }
    }



    updateCallerInfo(audioConfig, extendData) {
        this.backend.updateCallerInfo(audioConfig, extendData);
    }

    answerIncomingCall() {
        if (this.backend && typeof this.backend.answerIncomingCall === 'function') {
            this.backend.answerIncomingCall();
        }
    }

    answerCall() {
        this.answerIncomingCall();
    }

    acceptCall() {
        this.answerIncomingCall();
    }

    incomingCall(config, isVideoCall = true) {
        return new Promise((resolve, reject) => {
            if (this.enableCheckEventMessage) {
                // console.error("in another call");
                reject();
                return;
            }
            // this.test();
            this.backend.setConfigData(config, false, isVideoCall)
                .then(() => {
                    this.backend.incomingCall();
                    this.enableCheckEventMessage = true;
                    resolve(true);
                })
                .catch((e) => {
                    console.error(e);
                    reject(e);
                })
        });
    }
    makeCall(config, isVideoCall = true) {
        return new Promise((resolve, reject) => {
            this.backend.setCallback();
            this.backend.setConfigData(config, true, isVideoCall)
                .then(() => {
                    this.backend.makeCall();
                    this.enableCheckEventMessage = true;
                    resolve(true);
                })
                .catch((e) => {
                    console.error(e);
                    reject(e);
                });
        });

    }
}
const instance = new ZCallController();
module.exports = instance;
