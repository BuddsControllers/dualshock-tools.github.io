'use strict';

import {
  sleep,
  float_to_str,
  dec2hex,
  dec2hex32,
  lerp_color,
  initAnalyticsApi,
  la,
  createCookie,
  readCookie
} from './utils.js';

import { initControllerManager } from './controller-manager.js';
import ControllerFactory from './controllers/controller-factory.js';
import { lang_init, l } from './translations.js';
import { loadAllTemplates } from './template-loader.js';
import { draw_stick_position, CIRCULARITY_DATA_SIZE } from './stick-renderer.js';
import {
  ds5_finetune,
  isFinetuneVisible,
  finetune_handle_controller_input
} from './modals/finetune-modal.js';
import { calibrate_stick_centers, auto_calibrate_stick_centers } from './modals/calib-center-modal.js';
import { calibrate_range } from './modals/calib-range-modal.js';
import {
  show_quick_test_modal,
  isQuickTestVisible,
  quicktest_handle_controller_input
} from './modals/quick-test-modal.js';

// Expose ControllerFactory globally so xp-input.js can read supported models
window.ControllerFactory = ControllerFactory;

// -----------------------------------------------------------------------------
// Application State
// -----------------------------------------------------------------------------
const app = {
  // Button disable state management
  disable_btn: 0,
  last_disable_btn: 0,

  shownRangeCalibrationWarning: false,

  // Language and UI state
  lang_orig_text: {},
  lang_cur: {},
  lang_disabled: true,
  lang_cur_direction: 'ltr',

  // Session tracking
  gj: 0,
  gu: 0
};

const ll_data = new Array(CIRCULARITY_DATA_SIZE);
const rr_data = new Array(CIRCULARITY_DATA_SIZE);

let controller = null;

// -----------------------------------------------------------------------------
// Bootstrapping
// -----------------------------------------------------------------------------
function gboot() {
  app.gu = crypto.randomUUID();

  async function initializeApp() {
    // Global error handler
    window.addEventListener('error', (event) => {
      console.error(event.error?.stack || event.message);
      show_popup(event.error?.message || event.message);
    });

    // Global unhandled promise rejection handler
    window.addEventListener('unhandledrejection', async (event) => {
      console.error('Unhandled rejection:', event.reason?.stack || event.reason);
      close_all_modals();

      let errorMessage = 'An unexpected error occurred';
      if (event.reason) {
        if (event.reason.message) {
          errorMessage = `<strong>Error:</strong> ${event.reason.message}`;
        } else if (typeof event.reason === 'string') {
          errorMessage = `<strong>Error:</strong> ${event.reason}</strong>`;
        }

        let allStackTraces = '';
        if (event.reason.stack) {
          const stackTrace = event.reason.stack.replace(/\n/g, '<br>').replace(/ /g, '&nbsp;');
          allStackTraces += `<strong>Main Error Stack:</strong><br>${stackTrace}`;
        }

        let currentError = event.reason;
        let chainLevel = 0;
        while (currentError?.cause && chainLevel < 5) {
          chainLevel++;
          currentError = currentError.cause;
          if (currentError.stack) {
            const causeStackTrace = currentError.stack.replace(/\n/g, '<br>').replace(/ /g, '&nbsp;');
            if (allStackTraces) allStackTraces += '<br><br>';
            allStackTraces += `<strong>Cause ${chainLevel} Stack:</strong><br>${causeStackTrace}`;
          }
        }

        if (allStackTraces) {
          errorMessage += `
            <br>
            <details style="margin-top: 0px;">
              <summary style="cursor: pointer; color: #666;">Details</summary>
              <div style="font-family: monospace; font-size: 0.85em; margin-top: 8px; padding: 8px; background-color: #f8f9fa; border-radius: 4px; overflow-x: auto;">
                ${allStackTraces}
              </div>
            </details>
          `;
        }
      }

      errorAlert(errorMessage);
      event.preventDefault();
    });

    await loadAllTemplates();

    initAnalyticsApi(app); // init just with gu for now
    lang_init(app, handleLanguageChange, show_welcome_modal);
    show_welcome_modal();

    $("input[name='displayMode']").on('change', on_stick_mode_change);

    // Edge modal "Don't show again"
    $('#edgeModalDontShowAgain').on('change', function () {
      localStorage.setItem('edgeModalDontShowAgain', this.checked.toString());
    });

    // Try to auto-connect to any previously authorised controller
    autoConnectIfAllowed();
  }

  // Since modules are deferred, DOM might already be loaded
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', initializeApp);
  } else {
    initializeApp();
  }

  if (!('hid' in navigator)) {
    $('#offlinebar').hide();
    $('#onlinebar').hide();
    $('#missinghid').show();
    return;
  }

  $('#offlinebar').show();
  navigator.hid.addEventListener('disconnect', handleDisconnectedDevice);
}

// -----------------------------------------------------------------------------
// Auto-connect logic (WebHID)
// -----------------------------------------------------------------------------
async function autoConnectIfAllowed() {
  if (!('hid' in navigator)) {
    return;
  }

  if (controller && typeof controller.isConnected === 'function' && controller.isConnected()) {
    return;
  }

  try {
    const supportedModels = ControllerFactory.getSupportedModels();

    let devices = await navigator.hid.getDevices();

    devices = devices.filter((d) =>
      supportedModels.some((f) => f.vendorId === d.vendorId && f.productId === d.productId)
    );

    if (devices.length === 0) {
      return; // nothing pre-authorised – normal on first visit
    }

    app.gj = crypto.randomUUID();
    initAnalyticsApi(app); // init with gu and gj

    controller = initControllerManager({ handleNvStatusUpdate });
    controller.setInputHandler(handleControllerInput);

    la('begin');
    reset_circularity_mode();
    clearAllAlerts();
    await sleep(200);

    if (devices.length > 1) {
      console.log('Multiple pre-authorised controllers found, using the first one.');
    }

    const [device] = devices;

    if (device.opened) {
      console.log('Auto-connect: device already opened, closing before re-opening.');
      await device.close();
      await sleep(500);
    }

    await device.open();
    la('connect', { p: device.productId, v: device.vendorId });

    device.oninputreport = continue_connection;
  } catch (error) {
    console.error('Auto-connect failed:', error);
    await disconnect();
  }
}

// -----------------------------------------------------------------------------
// Manual connect (called from button and from xp-input.js)
// -----------------------------------------------------------------------------
async function connect() {
  // If we're already connected, don't attempt another connection
  if (controller && typeof controller.isConnected === 'function' && controller.isConnected()) {
    return;
  }

  app.gj = crypto.randomUUID();
  initAnalyticsApi(app); // init with gu and gj

  controller = initControllerManager({ handleNvStatusUpdate });
  controller.setInputHandler(handleControllerInput);

  la('begin');
  reset_circularity_mode();
  clearAllAlerts();
  await sleep(200);

  try {
    $('#btnconnect').prop('disabled', true);
    $('#connectspinner').show();
    await sleep(100);

    const supportedModels = ControllerFactory.getSupportedModels();

    const isSupportedId = (d) =>
      supportedModels.some((f) => f.vendorId === d.vendorId && f.productId === d.productId);

    // Treat devices that look like generic gamepads as acceptable fallback
    const hasGamepadUsage = (d) =>
      Array.isArray(d.collections) &&
      d.collections.some(
        (c) => c.usagePage === 0x01 && (c.usage === 0x05 /* gamepad */ || c.usage === 0x04 /* joystick */)
      );

    const filterToGamepads = (list) => list.filter((d) => isSupportedId(d) || hasGamepadUsage(d));

    const requestParams = { filters: supportedModels };

    // Try already-authorised devices first
    let devices = await navigator.hid.getDevices();
    devices = filterToGamepads(devices);

    // If none, show chooser dialog
    if (devices.length === 0) {
      devices = await navigator.hid.requestDevice(requestParams);
      devices = filterToGamepads(devices);
    }

    if (devices.length === 0) {
      $('#btnconnect').prop('disabled', false);
      $('#connectspinner').hide();
      await disconnect();
      return;
    }

    if (devices.length > 1) {
      infoAlert(l('Please connect only one controller at time.'));
      $('#btnconnect').prop('disabled', false);
      $('#connectspinner').hide();
      await disconnect();
      return;
    }

    const [device] = devices;
    if (device.opened) {
      console.log('Device already opened, closing it before re-opening.');
      await device.close();
      await sleep(500);
    }
    await device.open();

    la('connect', { p: device.productId, v: device.vendorId });
    device.oninputreport = continue_connection;
  } catch (error) {
    $('#btnconnect').prop('disabled', false);
    $('#connectspinner').hide();
    await disconnect();
    throw error;
  }
}

// -----------------------------------------------------------------------------
// Connection continuation
// -----------------------------------------------------------------------------
async function continue_connection({ data, device }) {
  try {
    if (!controller || controller.isConnected()) {
      device.oninputreport = null; // this function is called repeatedly if not cleared
      return;
    }

    // Detect if the controller is connected via USB
    const reportLen = data.byteLength;
    if (reportLen !== 63) {
      infoAlert(
        l(
          'The device is connected via Bluetooth. Disconnect and reconnect using a USB cable instead.'
        )
      );
      await disconnect();
      return;
    }

    function applyDeviceUI({
      showInfo,
      showFinetune,
      showInfoTab,
      showFourStepCalib,
      showQuickTests,
      showQuickCalib
    }) {
      $('#infoshowall').toggle(!!showInfo);
      $('#ds5finetune').toggle(!!showFinetune);
      $('#info-tab').toggle(!!showInfoTab);
      $('#four-step-center-calib').toggle(!!showFourStepCalib);
      $('#quick-tests-div').css('visibility', showQuickTests ? 'visible' : 'hidden');
      $('#quick-center-calib').toggle(!!showQuickCalib);
    }

    let controllerInstance = null;
    let info = null;

    try {
      controllerInstance = ControllerFactory.createControllerInstance(device);
      controller.setControllerInstance(controllerInstance);

      info = await controllerInstance.getInfo();

      if (controllerInstance.initializeCurrentOutputState) {
        await controllerInstance.initializeCurrentOutputState();
      }
    } catch (error) {
      const contextMessage = device
        ? `${l('Connected invalid device')}: ${dec2hex(device.vendorId)}:${dec2hex(
            device.productId
          )}`
        : l('Failed to connect to device');
      throw new Error(contextMessage, { cause: error });
    }

    if (!info?.ok) {
      if (info) console.error(JSON.stringify(info, null, 2));
      throw new Error(`${l('Connected invalid device')}: ${l('Error')}  1`, { cause: info?.error });
    }

    const ui = ControllerFactory.getUIConfig(device.productId);
    applyDeviceUI(ui);

    console.log('Setting input report handler.');
    device.oninputreport = controller.getInputHandler();

    const deviceName = ControllerFactory.getDeviceName(device.productId);
    $('#devname').text(
      deviceName + ' (' + dec2hex(device.vendorId) + ':' + dec2hex(device.productId) + ')'
    );

    $('#offlinebar').hide();
    $('#onlinebar').show();
    $('#mainmenu').show();
    $('#resetBtn').show();

    $('#d-nvstatus').text = l('Unknown');
    $('#d-bat').text = '';

    $('#controller-tab').tab('show');

    const model = controllerInstance.getModel();

    const numOfSticks = controllerInstance.getNumberOfSticks();
    if (numOfSticks === 2) {
      $('#stick-item-rx').show();
      $('#stick-item-ry').show();
    } else if (numOfSticks === 1) {
      $('#stick-item-rx').hide();
      $('#stick-item-ry').hide();
    } else {
      throw new Error(`Invalid number of sticks: ${numOfSticks}`);
    }

    await init_svg_controller(model);

    if (model === 'DS5_Edge' && info?.pending_reboot) {
      infoAlert(
        l(
          'A reboot is needed to continue using this DualSense Edge. Please disconnect and reconnect your controller.'
        )
      );
      await disconnect();
      return;
    }

    render_info_to_dom(info.infoItems);

    if (info.nv) {
      render_nvstatus_to_dom(info.nv);
      if (info.nv.locked === false) {
        await nvslock();
      }
    }

    if (typeof info.disable_bits === 'number' && info.disable_bits) {
      app.disable_btn |= info.disable_bits;
    }
    if (app.disable_btn !== 0) update_disable_btn();

    if (model === 'DS4' && info?.rare) {
      show_popup(
        'Wow, this is a rare/weird controller! Please write me an email at ds4@the.al or contact me on Discord (the_al)'
      );
    }

    if (model === 'DS5_Edge') {
      show_edge_modal();
    }

    if (model === 'VR2') {
      show_popup(
        l(
          "<p>Support for PS VR2 controllers is <b>minimal and highly experimental</b>.</p><p>I currently don't own these controllers, so I cannot verify the calibration process myself.</p><p>If you'd like to help improve full support, you can contribute with a donation or even send the controllers for testing.</p><p>Feel free to contact me on Discord (the_al) or by email at ds4@the.al .</p><br><p>Thank you for your support!</p>"
        ),
        true
      );
    }
  } catch (err) {
    await disconnect();
    throw err;
  } finally {
    $('#btnconnect').prop('disabled', false);
    $('#connectspinner').hide();
  }
}

// -----------------------------------------------------------------------------
// Disconnect
// -----------------------------------------------------------------------------
async function disconnect() {
  la('disconnect');
  if (!controller?.isConnected()) {
    controller = null;
    return;
  }
  app.gj = 0;
  app.disable_btn = 0;
  update_disable_btn();

  await controller.disconnect();
  controller = null;
  close_all_modals();
  $('#offlinebar').show();
  $('#onlinebar').hide();
  $('#mainmenu').hide();
}

function disconnectSync() {
  disconnect().catch((error) => {
    throw new Error('Failed to disconnect', { cause: error });
  });
}

async function handleDisconnectedDevice(e) {
  la('disconnected');
  console.log('Disconnected: ' + e.device.productName);
  await disconnect();
}

// -----------------------------------------------------------------------------
// NVS status / info rendering
// -----------------------------------------------------------------------------
function render_nvstatus_to_dom(nv) {
  if (!nv?.status) {
    throw new Error('Invalid NVS status data', { cause: nv?.error });
  }

  switch (nv.status) {
    case 'locked':
      $('#d-nvstatus').html("<font color='green'>" + l('locked') + '</font>');
      break;
    case 'unlocked':
      $('#d-nvstatus').html("<font color='red'>" + l('unlocked') + '</font>');
      break;
    case 'pending_reboot': {
      const pendingTxt =
        nv.raw !== undefined ? '0x' + dec2hex32(nv.raw) : String(nv.code ?? '');
      $('#d-nvstatus').html("<font color='purple'>unk " + pendingTxt + '</font>');
      break;
    }
    case 'unknown': {
      const unknownTxt =
        nv.device === 'ds5' && nv.raw !== undefined
          ? '0x' + dec2hex32(nv.raw)
          : String(nv.code ?? '');
      $('#d-nvstatus').html("<font color='purple'>unk " + unknownTxt + '</font>');
      break;
    }
    case 'error':
      $('#d-nvstatus').html("<font color='red'>" + l('error') + '</font>');
      break;
  }
}

async function refresh_nvstatus() {
  if (!controller.isConnected()) {
    return null;
  }

  return await controller.queryNvStatus();
}

// -----------------------------------------------------------------------------
// SVG + stick rendering
// -----------------------------------------------------------------------------
function set_edge_progress(score) {
  $('#dsedge-progress').css({ width: score + '%' });
}

function show_welcome_modal() {
  const already_accepted = readCookie('welcome_accepted');
  if (already_accepted === '1') return;

  bootstrap.Modal.getOrCreateInstance('#welcomeModal').show();
}

function welcome_accepted() {
  la('welcome_accepted');
  createCookie('welcome_accepted', '1');
  $('#welcomeModal').modal('hide');
}

async function init_svg_controller(model) {
  const svgContainer = document.getElementById('controller-svg-placeholder');

  let svgFileName;
  if (model === 'DS4') {
    svgFileName = 'dualshock-controller.svg';
  } else if (model === 'DS5' || model === 'DS5_Edge') {
    svgFileName = 'dualsense-controller.svg';
  } else if (model === 'VR2') {
    svgContainer.innerHTML = '';
    return;
  } else {
    throw new Error(`Unknown controller model: ${model}`);
  }

  let svgContent;

  if (window.BUNDLED_ASSETS && window.BUNDLED_ASSETS.svg && window.BUNDLED_ASSETS.svg[svgFileName]) {
    svgContent = window.BUNDLED_ASSETS.svg[svgFileName];
  } else {
    const response = await fetch(`assets/${svgFileName}`);
    if (!response.ok) {
      throw new Error(`Failed to load controller SVG: ${svgFileName}`);
    }
    svgContent = await response.text();
  }

  svgContainer.innerHTML = svgContent;

  const lightBlue = '#7ecbff';
  const midBlue = '#3399cc';
  const dualshock = document.getElementById('Controller');
  set_svg_group_color(dualshock, lightBlue);

  ['Button_outlines', 'Button_outlines_behind', 'L3_outline', 'R3_outline', 'Trackpad_outline'].forEach(
    (id) => {
      const group = document.getElementById(id);
      set_svg_group_color(group, midBlue);
    }
  );

  ['Controller_infills', 'Button_infills', 'L3_infill', 'R3_infill', 'Trackpad_infill'].forEach(
    (id) => {
      const group = document.getElementById(id);
      set_svg_group_color(group, 'white');
    }
  );
}

/**
 * Collects circularity data for both analog sticks during testing mode.
 */
function collectCircularityData(stickStates, leftData, rightData) {
  const { left, right } = stickStates || {};
  const MAX_N = CIRCULARITY_DATA_SIZE;

  for (const [stick, data] of [
    [left, leftData],
    [right, rightData]
  ]) {
    if (!stick) return;

    const { x, y } = stick;
    const distance = Math.sqrt(x * x + y * y);
    const angleIndex =
      (parseInt(Math.round((Math.atan2(y, x) * MAX_N) / 2.0 / Math.PI)) + MAX_N) % MAX_N;
    const oldValue = data[angleIndex] ?? 0;
    data[angleIndex] = Math.max(oldValue, distance);
  }
}

function clear_circularity() {
  ll_data.fill(0);
  rr_data.fill(0);
}

function reset_circularity_mode() {
  clear_circularity();
  $('#normalMode').prop('checked', true);
  refresh_stick_pos();
}

function refresh_stick_pos() {
  if (!controller) return;

  const hasSingleStick = controller.currentController?.getNumberOfSticks() === 1;

  const c = document.getElementById('stickCanvas');
  const ctx = c.getContext('2d');
  const sz = 60;
  const yb = 15 + sz;
  const w = c.width;
  const hb = hasSingleStick ? w / 2 : 20 + sz;
  ctx.clearRect(0, 0, c.width, c.height);

  const {
    left: { x: plx, y: ply },
    right: { x: prx, y: pry }
  } = controller.button_states.sticks;

  const enable_zoom_center = center_zoom_checked();
  const enable_circ_test = circ_checked();

  draw_stick_position(ctx, hb, yb, sz, plx, ply, {
    circularity_data: enable_circ_test ? ll_data : null,
    enable_zoom_center
  });

  if (!hasSingleStick) {
    draw_stick_position(ctx, w - hb, yb, sz, prx, pry, {
      circularity_data: enable_circ_test ? rr_data : null,
      enable_zoom_center
    });
  }

  const precision = enable_zoom_center ? 3 : 2;
  $('#lx-lbl').text(float_to_str(plx, precision));
  $('#ly-lbl').text(float_to_str(ply, precision));
  if (!hasSingleStick) {
    $('#rx-lbl').text(float_to_str(prx, precision));
    $('#ry-lbl').text(float_to_str(pry, precision));
  }

  try {
    switch (controller.getModel()) {
      case 'DS4': {
        const max_off = 25;
        const l3_cx = 295.63,
          l3_cy = 461.03;
        const r3_cx = 662.06,
          r3_cy = 419.78;

        const l3_x = l3_cx + plx * max_off;
        const l3_y = l3_cy + ply * max_off;
        const l3_group = document.querySelector('g#L3');
        l3_group?.setAttribute(
          'transform',
          `translate(${l3_x - l3_cx},${l3_y - l3_cy})`
        );

        const r3_x = r3_cx + prx * max_off;
        const r3_y = r3_cy + pry * max_off;
        const r3_group = document.querySelector('g#R3');
        r3_group?.setAttribute(
          'transform',
          `translate(${r3_x - r3_cx},${r3_y - r3_cy})`
        );
        break;
      }
      case 'DS5':
      case 'DS5_Edge': {
        const max_off = 25;
        const l3_cx = 295.63,
          l3_cy = 461.03;
        const r3_cx = 662.06,
          r3_cy = 419.78;

        const l3_x = l3_cx + plx * max_off;
        const l3_y = l3_cy + ply * max_off;
        const l3_group = document.querySelector('g#L3');
        l3_group?.setAttribute(
          'transform',
          `translate(${l3_x - l3_cx},${l3_y - l3_cy}) scale(0.70)`
        );

        const r3_x = r3_cx + prx * max_off;
        const r3_y = r3_cy + pry * max_off;
        const r3_group = document.querySelector('g#R3');
        r3_group?.setAttribute(
          'transform',
          `translate(${r3_x - r3_cx},${r3_y - r3_cy}) scale(0.70)`
        );
        break;
      }
      default:
        return;
    }
  } catch (e) {
    // ignore SVG failures
  }
}

const circ_checked = () => $('#checkCircularityMode').is(':checked');
const center_zoom_checked = () => $('#centerZoomMode').is(':checked');

function resetStickDiagrams() {
  clear_circularity();
  refresh_stick_pos();
}

function switchTo10xZoomMode() {
  $('#centerZoomMode').prop('checked', true);
  resetStickDiagrams();
}

function switchToRangeMode() {
  $('#checkCircularityMode').prop('checked', true);
  resetStickDiagrams();
}

const on_stick_mode_change = () => resetStickDiagrams();

const throttled_refresh_sticks = (() => {
  let delay = null;
  return function (changes) {
    if (!changes.sticks) return;
    if (delay) return;

    refresh_stick_pos();
    delay = setTimeout(() => {
      delay = null;
      refresh_stick_pos();
    }, 20);
  };
})();

const update_stick_graphics = (changes) => throttled_refresh_sticks(changes);

function update_battery_status({ bat_txt, changed }) {
  if (changed) {
    $('#d-bat').html(bat_txt);
  }
}

// -----------------------------------------------------------------------------
// SVG buttons / touchpad
// -----------------------------------------------------------------------------
function update_ds_button_svg(changes, BUTTON_MAP) {
  if (!changes || Object.keys(changes).length === 0) return;

  const pressedColor = '#1a237e';

  for (const trigger of ['l2', 'r2']) {
    const key = trigger + '_analog';
    if (Object.prototype.hasOwnProperty.call(changes, key)) {
      const val = changes[key];
      const t = val / 255;
      const color = lerp_color('#ffffff', pressedColor, t);
      const svg = trigger.toUpperCase() + '_infill';
      const infill = document.getElementById(svg);
      set_svg_group_color(infill, color);

      const percentage = Math.round((val / 255) * 100);
      const txt = document.getElementById(trigger.toUpperCase() + '_percentage');
      if (txt) {
        txt.textContent = `${percentage} %`;
        txt.setAttribute('opacity', percentage > 0 ? '1' : '0');
        txt.setAttribute('fill', percentage < 35 ? pressedColor : 'white');
      }
    }
  }

  for (const dir of ['up', 'right', 'down', 'left']) {
    if (Object.prototype.hasOwnProperty.call(changes, dir)) {
      const pressed = changes[dir];
      const group = document.getElementById(
        dir.charAt(0).toUpperCase() + dir.slice(1) + '_infill'
      );
      set_svg_group_color(group, pressed ? pressedColor : 'white');
    }
  }

  for (const btn of BUTTON_MAP) {
    if (['up', 'right', 'down', 'left'].includes(btn.name)) continue;
    if (Object.prototype.hasOwnProperty.call(changes, btn.name) && btn.svg) {
      const pressed = changes[btn.name];
      const group = document.getElementById(btn.svg + '_infill');
      set_svg_group_color(group, pressed ? pressedColor : 'white');
    }
  }
}

function set_svg_group_color(group, color) {
  if (group) {
    const elements = group.querySelectorAll('path,rect,circle,ellipse,line,polyline,polygon');
    elements.forEach((el) => {
      if (!el.style.transition) {
        el.style.transition = 'fill 0.10s, stroke 0.10s';
      }
      el.setAttribute('fill', color);
      el.setAttribute('stroke', color);
    });
  }
}

let hasActiveTouchPoints = false;
let trackpadBbox = undefined;

function update_touchpad_circles(points) {
  const hasActivePointsNow = points.some((pt) => pt.active);
  if (!hasActivePointsNow && !hasActiveTouchPoints) return;

  const svg = document.getElementById('controller-svg');
  const trackpad = svg?.querySelector('g#Trackpad_infill');
  if (!trackpad) return;

  trackpad.querySelectorAll('circle.ds-touch').forEach((c) => c.remove());
  hasActiveTouchPoints = hasActivePointsNow;
  trackpadBbox = trackpadBbox ?? trackpad.querySelector('path')?.getBBox();

  points.forEach((pt, idx) => {
    if (!pt.active) return;

    const RAW_W = 1920,
      RAW_H = 943;
    const pointRadius = trackpadBbox.width * 0.05;
    const cx =
      trackpadBbox.x +
      pointRadius +
      (pt.x / RAW_W) * (trackpadBbox.width - pointRadius * 2);
    const cy =
      trackpadBbox.y +
      pointRadius +
      (pt.y / RAW_H) * (trackpadBbox.height - pointRadius * 2);
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('class', 'ds-touch');
    circle.setAttribute('cx', cx);
    circle.setAttribute('cy', cy);
    circle.setAttribute('r', pointRadius);
    circle.setAttribute('fill', idx === 0 ? '#2196f3' : '#e91e63');
    circle.setAttribute('fill-opacity', '0.5');
    circle.setAttribute('stroke', '#3399cc');
    circle.setAttribute('stroke-width', '4');
    trackpad.appendChild(circle);
  });
}

// -----------------------------------------------------------------------------
// Tab helpers
// -----------------------------------------------------------------------------
function get_current_main_tab() {
  const mainTabs = document.getElementById('mainTabs');
  const activeBtn = mainTabs?.querySelector('.nav-link.active');
  return activeBtn?.id || 'controller-tab';
}

function get_current_test_tab() {
  const testsList = document.getElementById('tests-list');
  const activeBtn = testsList?.querySelector('.list-group-item.active');
  return activeBtn?.id || 'haptic-test-tab';
}

// -----------------------------------------------------------------------------
// Calibration helpers
// -----------------------------------------------------------------------------
function detectFailedRangeCalibration(changes) {
  if (!changes.sticks || app.shownRangeCalibrationWarning) return;

  const { left, right } = changes.sticks;
  const failedCalibration = [left, right].some(({ x, y }) => Math.abs(x) + Math.abs(y) === 2);
  const hasOpenModals = document.querySelectorAll('.modal.show').length > 0;

  if (failedCalibration && !app.shownRangeCalibrationWarning && !hasOpenModals) {
    app.shownRangeCalibrationWarning = true;
    show_popup(
      l(
        'Range calibration appears to have failed. Please try again and make sure you rotate the sticks.'
      )
    );
  }
}

// -----------------------------------------------------------------------------
// Controller input handler
// -----------------------------------------------------------------------------
function handleControllerInput({ changes, inputConfig, touchPoints, batteryStatus }) {
  const { buttonMap } = inputConfig;

  if (isQuickTestVisible()) {
    quicktest_handle_controller_input(changes);
    return;
  }

  const current_active_tab = get_current_main_tab();
  switch (current_active_tab) {
    case 'controller-tab':
      collectCircularityData(changes.sticks, ll_data, rr_data);
      if (isFinetuneVisible()) {
        finetune_handle_controller_input(changes);
      } else {
        update_stick_graphics(changes);
        update_ds_button_svg(changes, buttonMap);
        update_touchpad_circles(touchPoints);
        detectFailedRangeCalibration(changes);
      }
      break;

    case 'tests-tab':
      handle_test_input(changes);
      break;
  }

  update_battery_status(batteryStatus);
}

function handle_test_input(/* changes */) {
  const current_test_tab = get_current_test_tab();

  switch (current_test_tab) {
    case 'haptic-test-tab': {
      const l2 = controller.button_states.l2_analog || 0;
      const r2 = controller.button_states.r2_analog || 0;
      if (l2 || r2) {
        // trigger_haptic_motors(l2, r2);
      }
      break;
    }
    default:
      console.log('Unknown test tab:', current_test_tab);
      break;
  }
}

// -----------------------------------------------------------------------------
// Disable-buttons logic
// -----------------------------------------------------------------------------
function update_disable_btn() {
  const { disable_btn, last_disable_btn } = app;
  if (disable_btn === last_disable_btn) return;

  if (disable_btn === 0) {
    $('.ds-btn').prop('disabled', false);
    app.last_disable_btn = 0;
    return;
  }

  $('.ds-btn').not('#quick-test-btn').prop('disabled', true);

  if (disable_btn & 1 && !(last_disable_btn & 1)) {
    show_popup(
      l('The device appears to be a clone. All calibration functionality is disabled.')
    );
  } else if (disable_btn & 2 && !(last_disable_btn & 2)) {
    show_popup(
      l('This DualSense controller has outdated firmware.') +
        '<br>' +
        l('Please update the firmware and try again.'),
      true
    );
  }
  app.last_disable_btn = disable_btn;
}

// -----------------------------------------------------------------------------
// Language + NV handlers
// -----------------------------------------------------------------------------
async function handleLanguageChange() {
  if (!controller) return;

  const { infoItems } = await controller.getDeviceInfo();
  render_info_to_dom(infoItems);
}

function handleNvStatusUpdate(nv) {
  render_nvstatus_to_dom(nv);
}

// -----------------------------------------------------------------------------
// Flashing / reboot / NVS
// -----------------------------------------------------------------------------
async function flash_all_changes() {
  const isEdge = controller.getModel() === 'DS5_Edge';
  const progressCallback = isEdge ? set_edge_progress : null;
  const edgeProgressModal = isEdge ? bootstrap.Modal.getOrCreateInstance('#edgeProgressModal') : null;
  edgeProgressModal?.show();

  const result = await controller.flash(progressCallback);
  edgeProgressModal?.hide();

  if (result?.success) {
    if (result.isHtml) {
      show_popup(result.message, result.isHtml);
    } else {
      successAlert(result.message);
    }
  }
}

async function reboot_controller() {
  await controller.reset();
}

async function nvsunlock() {
  await controller.nvsUnlock();
}

async function nvslock() {
  return await controller.nvsLock();
}

// -----------------------------------------------------------------------------
// Modals + info rendering
// -----------------------------------------------------------------------------
function close_all_modals() {
  $('.modal.show').modal('hide');
}

function render_info_to_dom(infoItems) {
  $('#fwinfo').html('');
  $('#fwinfoextra-hw').html('');
  $('#fwinfoextra-fw').html('');

  if (!Array.isArray(infoItems)) return;

  infoItems.forEach(({ key, value, addInfoIcon, severity, isExtra, cat }) => {
    if (!key) return;

    let valueHtml = String(value ?? '');
    if (addInfoIcon === 'board') {
      const icon =
        '&nbsp;<a class="link-body-emphasis" href="#" onclick="board_model_info()">' +
        '<svg class="bi" width="1.3em" height="1.3em"><use xlink:href="#info"/></svg></a>';
      valueHtml += icon;
    } else if (addInfoIcon === 'color') {
      const icon =
        '&nbsp;<a class="link-body-emphasis" href="#" onclick="edge_color_info()">' +
        '<svg class="bi" width="1.3em" height="1.3em"><use xlink:href="#info"/></svg></a>';
      valueHtml += icon;
    }

    if (severity) {
      const colors = { danger: 'red', success: 'green' };
      const color = colors[severity] || 'black';
      valueHtml = `<font color='${color}'><b>${valueHtml}</b></font>`;
    }

    if (isExtra) {
      append_info_extra(key, valueHtml, cat || 'hw');
    } else {
      append_info(key, valueHtml, cat || 'hw');
    }
  });
}

function append_info_extra(key, value, cat) {
  const s =
    '<dt class="text-muted col-sm-4 col-md-6 col-xl-5">' +
    key +
    '</dt><dd class="col-sm-8 col-md-6 col-xl-7" style="text-align: right;">' +
    value +
    '</dd>';
  $('#fwinfoextra-' + cat).html($('#fwinfoextra-' + cat).html() + s);
}

function append_info(key, value, cat) {
  const s =
    '<dt class="text-muted col-6">' +
    key +
    '</dt><dd class="col-6" style="text-align: right;">' +
    value +
    '</dd>';
  $('#fwinfo').html($('#fwinfo').html() + s);
  append_info_extra(key, value, cat);
}

// -----------------------------------------------------------------------------
// Simple popup / modal helpers
// -----------------------------------------------------------------------------
function show_popup(text, is_html = false) {
  if (is_html) {
    $('#popupBody').html(text);
  } else {
    $('#popupBody').text(text);
  }
  bootstrap.Modal.getOrCreateInstance('#popupModal').show();
}

function show_faq_modal() {
  la('faq_modal');
  bootstrap.Modal.getOrCreateInstance('#faqModal').show();
}

function show_donate_modal() {
  la('donate_modal');
  bootstrap.Modal.getOrCreateInstance('#donateModal').show();
}

function show_edge_modal() {
  const dontShowAgain = localStorage.getItem('edgeModalDontShowAgain');
  if (dontShowAgain === 'true') {
    return;
  }

  la('edge_modal');
  bootstrap.Modal.getOrCreateInstance('#edgeModal').show();
}

function show_info_tab() {
  la('info_modal');
  $('#info-tab').tab('show');
}

function discord_popup() {
  la('discord_popup');
  show_popup(l('My handle on discord is: the_al'));
}

function edge_color_info() {
  la('cm_info');
  const text = l('Color detection thanks to') + ' romek77 from Poland.';
  show_popup(text, true);
}

function board_model_info() {
  la('bm_info');
  const l1 = l('This feature is experimental.');
  const l2 = l('Please let me know if the board model of your controller is not detected correctly.');
  const l3 =
    l('Board model detection thanks to') +
    ' <a href="https://battlebeavercustoms.com/">Battle Beaver Customs</a>.';
  show_popup(l3 + '<br><br>' + l1 + ' ' + l2, true);
}

// -----------------------------------------------------------------------------
// Alert helpers
// -----------------------------------------------------------------------------
let alertCounter = 0;

function pushAlert(message, type = 'info', duration = 0, dismissible = true) {
  const alertContainer = document.getElementById('alert-container');
  if (!alertContainer) {
    console.error('Alert container not found');
    return null;
  }

  const alertId = `alert-${++alertCounter}`;
  const alertDiv = document.createElement('div');
  alertDiv.id = alertId;
  alertDiv.className = `alert alert-${type} alert-dismissible fade show`;
  alertDiv.setAttribute('role', 'alert');
  alertDiv.innerHTML = `
    ${message}
    ${
      dismissible
        ? '<button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>'
        : ''
    }
  `;

  alertContainer.appendChild(alertDiv);

  if (duration > 0) {
    setTimeout(() => {
      dismissAlert(alertId);
    }, duration);
  }

  return alertId;
}

function dismissAlert(alertId) {
  const alertElement = document.getElementById(alertId);
  if (alertElement) {
    const bsAlert = new bootstrap.Alert(alertElement);
    bsAlert.close();
  }
}

function clearAllAlerts() {
  const alertContainer = document.getElementById('alert-container');
  if (alertContainer) {
    const alerts = alertContainer.querySelectorAll('.alert');
    alerts.forEach((alert) => {
      const bsAlert = new bootstrap.Alert(alert);
      bsAlert.close();
    });
  }
}

function successAlert(message, duration = 1500) {
  return pushAlert(message, 'success', duration, false);
}

function errorAlert(message, duration = 15000) {
  return pushAlert(message, 'danger', duration);
}

function warningAlert(message, duration = 8000) {
  return pushAlert(message, 'warning', duration);
}

function infoAlert(message, duration = 5000) {
  return pushAlert(message, 'info', duration, false);
}

// -----------------------------------------------------------------------------
// Export to global scope for HTML onclick handlers
// -----------------------------------------------------------------------------
window.gboot = gboot;
window.connect = connect;
window.disconnect = disconnectSync;
window.show_faq_modal = show_faq_modal;
window.show_info_tab = show_info_tab;

window.calibrate_range = () =>
  calibrate_range(controller, { ll_data, rr_data }, (success, message) => {
    if (success) {
      resetStickDiagrams();
      successAlert(message);
      switchToRangeMode();
      app.shownRangeCalibrationWarning = false;
    }
  });

window.calibrate_stick_centers = () =>
  calibrate_stick_centers(controller, (success, message) => {
    if (success) {
      resetStickDiagrams();
      successAlert(message);
      switchTo10xZoomMode();
    }
  });

window.auto_calibrate_stick_centers = () =>
  auto_calibrate_stick_centers(controller, (success, message) => {
    if (success) {
      resetStickDiagrams();
      successAlert(message);
      switchTo10xZoomMode();
    }
  });

window.ds5_finetune = () =>
  ds5_finetune(
    controller,
    { ll_data, rr_data, clear_circularity },
    (success) => success && switchToRangeMode()
  );

window.flash_all_changes = flash_all_changes;
window.reboot_controller = reboot_controller;
window.refresh_nvstatus = refresh_nvstatus;
window.nvsunlock = nvsunlock;
window.nvslock = nvslock;
window.welcome_accepted = welcome_accepted;
window.show_donate_modal = show_donate_modal;
window.board_model_info = board_model_info;
window.edge_color_info = edge_color_info;
window.show_quick_test_modal = () => {
  show_quick_test_modal(controller).catch((error) => {
    throw new Error('Failed to show quick test modal', { cause: error });
  });
};

// Kick the whole thing off
gboot();
