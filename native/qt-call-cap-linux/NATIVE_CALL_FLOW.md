# Native ZCall Flow

This document is intentionally limited to behavior that is visible in the two
Ghidra decompile outputs:

- `native/nativelibs/zcall/zcall_mac/all_functions.c`
- `native/nativelibs/zcall/zcall_ia32/all_functions.c`

When Linux protocol command names are mentioned, they are listed as the Linux
adapter mapping, not as direct native symbol names, because the decompiled files
do not expose clear `401`/`402`/`407`/`408`/`416` wrapper names at the JS event
surface.

## Direct Native Evidence

### Outgoing entry

macOS:

- `MainApp::makeCall()` is at `zcall_mac/all_functions.c:856`.
- It logs `native::make Call`.
- It gets the peer with `AppModel::peer(...)`.
- It calls `AppModel::start(...)`.
- It copies the JSON/server/config string from `this + 0x1e68`.
- It calls `zrtc::Peer::makeCall(pPVar4, this + 0x1d18, this, local_48)` at
  `zcall_mac/all_functions.c:887`.

macOS peer implementation:

- `zrtc::Peer::makeCall(...)` is at `zcall_mac/all_functions.c:658457`.
- It refuses to proceed if `CallController::isInCall(...)` is true.
- It refuses to proceed if the config pointer or config string is empty.
- It calls `_initCallConfig(this, param_1, true, callback)`.
- It calls `CallController::parseJsonServer(...)`.
- It calls `_initZrtcConfig(...)`.
- It calls `startNoAudio(this)`.
- If `_inModeCall(this)` returns true, it calls
  `CallController::setCallState(..., 1)`.
- It returns success as `1`.

Linux rule:

- `makeCall` must create an outgoing call only when not already in a call.
- `makeCall` must parse/preserve the server/config JSON before starting media.
- `makeCall` may enter native calling state `1`; it must not emit connected
  state from the click alone.

### JS event queue shape

Both native modules push JSON strings into an internal queue protected by a
critical section.

Confirmed event payloads:

| Event | macOS evidence | Windows evidence | JSON |
| --- | --- | --- | --- |
| `onCallVideoState` | `zcall_mac/all_functions.c:2629` | `zcall_ia32/all_functions.c:48434` | `{"type":"onCallVideoState","state":"%d"}` |
| `onCallState` | `zcall_mac/all_functions.c:2749` | `zcall_ia32/all_functions.c:48477` | `{"type":"onCallState","state":"%d"}` |
| `onIncomingCall` | `zcall_mac/all_functions.c:2795` | `zcall_ia32/all_functions.c:48524` | `{"type":"onIncomingCall"}` |
| `onMakeCall` | `zcall_mac/all_functions.c:2838` | `zcall_ia32/all_functions.c:48569` | `{"type":"onMakeCall"}` |
| `onCallAutoHangup` | `zcall_mac/all_functions.c:2880` | `zcall_ia32/all_functions.c:48612` | `{"type":"onCallAutoHangup"}` |
| `onCallQualityChanged` | `zcall_mac/all_functions.c:2923` | `zcall_ia32/all_functions.c:48660` | `{"type":"onCallQualityChanged","quality":"%d"}` |
| `onInitZrtpRequestFailed` | `zcall_mac/all_functions.c:3037` | `zcall_ia32/all_functions.c:48703` | `{"type":"onInitZrtpRequestFailed","retCode":"%d"}` |
| `onInitZrtpWithServer` | `zcall_mac/all_functions.c:3082` | `zcall_ia32/all_functions.c:48760` | `{"type":"onInitZrtpWithServer","rtcp":"%s","rtp":"%s"}` |
| `onCallAudioState` | `zcall_mac/all_functions.c:3140` | `zcall_ia32/all_functions.c:48812` | `{"type":"onCallAudioState","state":"%d"}` |
| `onCallChangeZRTP` | `zcall_mac/all_functions.c:3185` | `zcall_ia32/all_functions.c:48878` | `{"type":"onCallChangeZRTP","retCode":"%d","rtpAddr":"%s","rtcpAddr":"%s","sessionId":"%s"}` |

Linux rule:

- Emit the same event names and the same string-valued fields.
- Do not invent extra connected events outside native state transitions.

### Call state semantics

macOS:

- `AppModel::onCallState(int)` formats and queues
  `{"type":"onCallState","state":"%d"}` at
  `zcall_mac/all_functions.c:2777`.
- If `param_1 == 4`, it calls `zrtc::Peer::setCallState(..., 5)` at
  `zcall_mac/all_functions.c:2784-2785`.

Windows:

- The Windows callback formats and queues
  `{"type":"onCallState","state":"%d"}` at
  `zcall_ia32/all_functions.c:48477`.
- If `param_2 == 4`, it calls `FUN_10038570(5)` at
  `zcall_ia32/all_functions.c:48486-48487`.

Linux rule:

- JS-visible connected state is native `onCallState(4)`.
- Native/internal state `5` follows visible connected state `4`.
- A protocol/control value equal to `5` must not be treated as JS-visible
  connected state by name alone.

### Incoming event semantics

macOS:

- `AppModel::onIncomingCall()` queues `{"type":"onIncomingCall"}` at
  `zcall_mac/all_functions.c:2822`.
- It then calls `zrtc::Peer::setCallState(..., 5)` at
  `zcall_mac/all_functions.c:2829`.

Windows:

- The Windows incoming callback queues `{"type":"onIncomingCall"}` at
  `zcall_ia32/all_functions.c:48524`.
- It then calls `FUN_10038570(5)` at
  `zcall_ia32/all_functions.c:48533`.

Linux rule:

- On an incoming request, emit `onIncomingCall`.
- Keep an active incoming call context so the UI can ring and later answer.
- Do not create a second call if follow-up controls belong to the same peer/call.

### ZRTP/server payload fields

macOS JSON construction:

- `callType` is written at `zcall_mac/all_functions.c:628501`.
- `newZrtc` is written at `zcall_mac/all_functions.c:628505`.
- `serverAddr` is written at `zcall_mac/all_functions.c:628601`.
- `supportCallBusy` is written at `zcall_mac/all_functions.c:628611`.
- `serverAddr` entries contain `rtp` and `rtcp` values from
  `ZRTPServerInfo::getRtpAddress()` and `ZRTPServerInfo::getRtcpAddress()`.

Windows JSON construction:

- `callType` is written at `zcall_ia32/all_functions.c:97829`.
- `newZrtc` is written at `zcall_ia32/all_functions.c:97842`.
- `rtp` and `rtcp` are written inside server address objects around
  `zcall_ia32/all_functions.c:97880-98010`.
- `serverAddr` is written at `zcall_ia32/all_functions.c:98019`.
- `supportCallBusy` is written at `zcall_ia32/all_functions.c:98039`.

Linux rule:

- Preserve `callType`.
- Preserve `newZrtc`.
- Preserve server address objects with `rtp` and `rtcp`.
- Preserve `supportCallBusy`.
- Preserve compatible transport fields already present in Linux
  `extendData`, including `packetMode` and `srtpMode`, when the current
  server/config provides them.

## Linux Adapter Mapping

This section maps native behavior to the Linux signaling adapter. It is not a
claim that the decompiled files expose these command constants directly.

### Outgoing

1. User clicks call.
2. Emit `onMakeCall`.
3. Create one active outgoing call if no call is active.
4. Send Linux request-call (`401`) with the current call config.
5. Parse server RTP/RTCP/session/ZRTP data from the response.
6. Send Linux request-transport (`416`) with native-style `extendData`.
7. Start local media only as transport setup, not as connected UI state.
8. Emit `onCallState(4)` only after a real connected condition.

Connected conditions accepted by the Linux adapter:

- explicit connected answer from the peer, or
- real remote media activity after a pending answer path.

### Incoming

1. Receive an incoming request control.
2. Build one active incoming call context.
3. Emit `onIncomingCall`.
4. Send Linux ringing (`407`).
5. On user answer, send Linux answer (`402`) with codec, RTP/RTCP, session, and
   answer `extendData`.
6. Start media and emit `onCallState(4)` when the call is actually answered.

### `status=5`

The decompiled native files prove that visible connected state is `4`, and that
internal/native state `5` is set after `onCallState(4)` or after incoming call
setup. Therefore the Linux adapter must not interpret an arbitrary remote
`status=5` value as visible connected state.

Linux default behavior:

- Do not send answer-ack (`408`) only because remote status is `5`.
- Send answer-ack (`408`) when status `5` carries native media progress, such
  as active media, previous remote ringing, or answer `extendData` with ZRTP/SRTP
  media mode fields.
- Do not emit `onCallState(4)` only because remote status is `5`.
- Emit `onCallState(4)` after the local `408` answer-ack is acknowledged or
  after remote media packets arrive.
- Do not start the UI timer only because remote status is `5`.
- Keep the call pending until a real connected condition occurs.
- If pending status `5` times out with no native progress, cancel/free the call.

Debug-only overrides exist for protocol experiments, but they are not native
parity defaults:

- `ZALO_CALL_STATUS_5_ACK=1`
- `ZALO_CALL_STATUS_5_CONNECT_ON_ACK=1`
- `ZALO_CALL_STATUS_5_CONNECT_ON_CONTROL=1`
- `ZALO_CALL_STATUS_5_TIMEOUT_CANCEL=0`
- `ZALO_CALL_STATUS_5_AUTO_REDIAL=1`

## Implementation Checklist

- `makeCall` emits `onMakeCall` and does not mark connected on click.
- Incoming request emits `onIncomingCall`.
- Connected UI state emits `onCallState(4)`.
- Linux never treats a raw remote `status=5` as connected by default.
- ZRTP server events use native event payload names:
  `onInitZrtpWithServer`, `onInitZrtpRequestFailed`, and `onCallChangeZRTP`.
- Transport/extend data preserves native-visible fields:
  `callType`, `newZrtc`, `serverAddr[].rtp`, `serverAddr[].rtcp`,
  `supportCallBusy`, plus compatible Linux fields already supplied by config.
