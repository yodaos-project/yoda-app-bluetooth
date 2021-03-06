'use strict'

var Service = require('@yodaos/application').Service
var logger = require('logger')('bluetooth-service')
var bluetooth = require('@yoda/bluetooth')
var protocol = bluetooth.protocol
var util = require('util')
var _ = require('@yoda/util')._
var system = require('@yoda/system')
var rt = global[Symbol.for('yoda#api')]
var strings = require('./strings.json')
var config = require('./config.json')
var res = require('./resources.json')
var Agent = require('@yoda/flora').Agent

var agent = null
var deviceName = null
var a2dp = null
var hfp = null
var lastUrl = '/derived_from_phone'
var timer = null

function speak (label) {
  var fmt = strings[label]
  var altVoice = null
  if (Array.isArray(fmt)) {
    altVoice = fmt[1]
    fmt = fmt[0]
  }
  var args = Array.prototype.slice.call(arguments, 1)
  var text = util.format.apply(util, [fmt].concat(args))
  logger.debug(`speak: ${text}, altVoice: ${altVoice}`)
  service.openUrl(`yoda-app://system/speak?text=${text}&alt=${altVoice}`)
}

function setTimer (callback, timeout) {
  if (timer != null) {
    clearTimeout(timer)
  }
  timer = setTimeout(callback, timeout)
}

function cancelTimer () {
  if (timer != null) {
    clearTimeout(timer)
    timer = null
  }
}

function resetLastUrl () {
  lastUrl = '/derived_from_phone'
}

function uploadStatus (mode, state, data) {
  var stateCode = {
    [protocol.RADIO_STATE.OFF]: 0,
    [protocol.RADIO_STATE.ON]: 1,
    [protocol.CONNECTION_STATE.DISCONNECTED]: 2,
    [protocol.CONNECTION_STATE.CONNECTED]: 3
  }
  var code = stateCode[state]
  logger.debug(`upload bluetooth ${state}(${code})`)
  if (code != null) {
    agent.post('yodaos.apps.bluetooth.status', [ code ])
  }
}

var urlHandlers = {
  // ask for how to use bluetooth
  '/usage': () => {
    speak('ASK')
  },
  // open bluetooth
  '/open': (url) => {
    if (a2dp.isConnected()) {
      lastUrl = '/reopen'
    }
    if (url.query != null && url.query.mode != null) {
      a2dp.open(url.query.mode)
    } else {
      a2dp.open()
    }
  },
  // open bluetooth then connect to remote device (phone or speaker)
  '/open_and_connect': (url) => {
    if (url.query != null && url.query.mode != null) {
      a2dp.open(url.query.mode)
    } else {
      a2dp.open()
    }
  },
  // open bluetooth then connect to phone then start play music (always sink mode)
  '/open_and_play': () => {
    if (a2dp.isConnected()) {
      a2dp.play()
    } else {
      a2dp.open(protocol.A2DP_MODE.SINK, {autoplay: true})
    }
  },
  // close bluetooth
  '/close': () => {
    if (!a2dp.isPlaying()) {
      service.openUrl(res.URL.BLUETOOTH_MUSIC + 'event/stopped')
    }
    a2dp.close()
  },
  // disconnect from remote device whatever in sink or source mode
  '/disconnect': () => {
    if (!a2dp.isPlaying()) {
      service.openUrl(res.URL.BLUETOOTH_MUSIC + 'event/stopped')
    }
    a2dp.disconnect()
  },
  // implied close bluetooth
  '/implied_close': () => {
    if (!a2dp.isPlaying()) {
      service.openUrl(res.URL.BLUETOOTH_MUSIC + 'event/stopped')
    }
    a2dp.close()
  }
}

function handleSinkRadioOn (autoConn) {
  switch (lastUrl) {
    case '/open':
      if (autoConn) {
        speak('SINK_OPENED')
      } else {
        speak('SINK_FIRST_OPENED_ARG1S', deviceName)
      }
      resetLastUrl()
      break
    case '/open_and_connect':
    case '/open_and_play':
      if (autoConn) {
        setTimer(() => {
          if (!a2dp.isConnected()) {
            speak('SINK_OPENED_BY_ACTION_TIMEOUT_ARG1S', deviceName)
          }
        }, config.TIMER.DELAY_BEFORE_AUTOCONNECT_FAILED)
      } else {
        speak('SINK_FIRST_OPENED_BY_CONNECT_ARG1S', deviceName)
      }
      break
    default:
      break
  }
}

function handleSourceRadioOn (autoConn) {
  if (autoConn) {
    speak('SOURCE_OPENED')
  } else {
    speak('SOURCE_FIRST_OPENED')
  }
  resetLastUrl()
}

function onRadioStateChangedListener (mode, state, extra) {
  logger.debug(`${mode} onRadioStateChanged(${state}, ${JSON.stringify(extra)})`)
  cancelTimer()
  uploadStatus(mode, state)
  if (mode !== a2dp.getMode()) {
    logger.warn('Suppress old mode event to avoid confusing users.')
    return
  }
  switch (state) {
    case protocol.RADIO_STATE.ON:
      var autoConn = _.get(extra, 'autoConn', false)
      if (mode === protocol.A2DP_MODE.SINK) {
        handleSinkRadioOn(autoConn)
      } else {
        handleSourceRadioOn(autoConn)
      }
      break
    case protocol.RADIO_STATE.ON_FAILED:
      if (mode === protocol.A2DP_MODE.SINK) {
        speak('SINK_OPEN_FAILED')
      } else {
        speak('SOURCE_OPEN_FAILED')
      }
      break
    case protocol.RADIO_STATE.OFF:
      if (lastUrl === '/close') {
        speak('CLOSED')
      }
      break
    default:
      break
  }
}

function onConnectionStateChangedListener (mode, state, device) {
  logger.debug(`${mode} onConnectionStateChanged(${state})`)
  cancelTimer()
  uploadStatus(mode, state, device)
  if (mode !== a2dp.getMode()) {
    logger.warn('Suppress old mode event to avoid confusing users.')
    return
  }
  switch (state) {
    case protocol.CONNECTION_STATE.CONNECTED:
      if (lastUrl === '/open_and_play') {
        setTimer(() => {
          if (a2dp.isConnected() && !a2dp.isPlaying()) {
            var dev = a2dp.getConnectedDevice()
            if (dev != null) {
              speak('PLAY_FAILED_ARG1S', dev.name)
            }
          }
        }, config.TIMER.DELAY_BEFORE_PLAY_FAILED)
        speak('PLEASE_WAIT')
      } else if (lastUrl === '/reopen') {
        speak('RECONNECTED_ARG2S', device.name, deviceName)
        lastUrl = '/derived_from_phone'
      } else {
        speak('CONNECTED_ARG1S', device.name)
        lastUrl = '/derived_from_phone'
      }
      resetLastUrl()
      break
    case protocol.CONNECTION_STATE.DISCONNECTED:
      if (lastUrl !== '/close' && lastUrl !== '/implied_close') {
        speak('DISCONNECTED')
      } else {
        logger.debug('Suppress "disconnected" prompt while NOT user explicit intent.')
      }
      break
    case protocol.CONNECTION_STATE.CONNECT_FAILED:
      if (mode === protocol.A2DP_MODE.SOURCE) {
        speak('SOURCE_CONNECT_FAILED_ARG1S', device.name)
      }
      break
    case protocol.CONNECTION_STATE.AUTOCONNECT_FAILED:
      if (lastUrl === '/open') {
        // NOP while auto connect failed if user only says 'open bluetooth'.
      } else {
        speak('SOURCE_CONNECT_FAILED_ARG1S', device.name)
      }
      break
    default:
      break
  }
}

function onAudioStateChangedListener (mode, state, extra) {
  logger.debug(`${mode} onAudioStateChanged(${state})`)
  switch (state) {
    case protocol.AUDIO_STATE.PLAYING:
      cancelTimer()
      service.openUrl(res.URL.BLUETOOTH_MUSIC + 'event/playing')
      break
    default:
      break
  }
}

function onDiscoveryStateChangedListener (mode, state, extra) {
  logger.debug(`${mode} onDiscoveryChanged(${state})`)
  if (mode !== a2dp.getMode()) {
    logger.debug('Suppress old mode discovery events to avoid disturbing current event.')
  }
  switch (state) {
    case protocol.DISCOVERY_STATE.ON:
      if (lastUrl !== '/close') {
        rt.effect.play(res.LIGHT.DISCOVERY_ON, {}, { shouldResume: true, zIndex: 2 })
          .catch((err) => {
            logger.error('bluetooth play light error:', err)
          })
      } else {
        logger.debug('Suppress "discovery" light in conditions which is not user explicit intents.')
      }
      break
    case protocol.DISCOVERY_STATE.OFF:
      rt.effect.stop(res.LIGHT.DISCOVERY_ON)
      break
    case protocol.DISCOVERY_STATE.FOUND_DEVICE:
      uploadStatus(mode, state, extra)
      break
    default:
      break
  }
}

function onCallStateChangedListener (state, extra) {
  logger.debug(`onCallStateChanged(${state})`)
  service.openUrl(res.URL.BLUETOOTH_CALL + state)
}

var service = Service({
  created: () => {
    logger.debug('Bluetooth service created')
    a2dp = bluetooth.getAdapter(protocol.PROFILE.A2DP)
    hfp = bluetooth.getAdapter(protocol.PROFILE.HFP)
    a2dp.on('radio_state_changed', onRadioStateChangedListener)
    a2dp.on('connection_state_changed', onConnectionStateChangedListener)
    a2dp.on('audio_state_changed', onAudioStateChangedListener)
    a2dp.on('discovery_state_changed', onDiscoveryStateChangedListener)
    hfp.on('call_state_changed', onCallStateChangedListener)
    deviceName = `<num=tel>${system.getDeviceName()}</num>`
    agent = new Agent('unix:/var/run/flora.sock')
    agent.start()
  },
  destroyed: () => {
    logger.debug('Bluetooth service destroyed')
    if (a2dp !== null) {
      a2dp.close()
      a2dp.destroy()
      a2dp = null
    }
    if (hfp !== null) {
      hfp.destroy()
      hfp = null
    }
    agent.close()
  }
})

service.handleUrl = (url) => {
  logger.debug('handleUrl:', url.pathname)
  cancelTimer()
  var handler = urlHandlers[url.pathname]
  if (typeof handler === 'function') {
    lastUrl = url.pathname
    handler(url)
  } else {
    speak('FALLBACK')
  }
}

module.exports = service
