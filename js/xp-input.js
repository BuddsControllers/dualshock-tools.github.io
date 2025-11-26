// xp-input.js
// Extra input layer for XP Controllers calibration page.
// - Press X to call window.connect() when the offline bar is visible
// - Read dpad + left stick and maintain a "selected controller index"
//   (for your own UI, NOT the Chrome WebHID chooser)

(function () {
  const POLL_INTERVAL_MS = 80;
  const CONNECT_COOLDOWN_MS = 1500;

  let lastXPressed = false;
  let lastDpadState = { up: false, down: false, left: false, right: false };
  let lastConnectAt = 0;

  // Index into the list of *browser gamepads*, NOT HID popup list
  let selectedGamepadIndex = 0;

  function isOfflineScreenVisible() {
    const el = document.getElementById('offlinebar');
    return !!(el && el.offsetParent !== null);
  }

  function ensureHintText() {
    const bar = document.getElementById('offlinebar');
    if (!bar) return;

    let hint = document.getElementById('xp-connect-hint');
    if (!hint) {
      hint = document.createElement('p');
      hint.id = 'xp-connect-hint';
      hint.style.marginTop = '8px';
      hint.style.fontSize = '0.9rem';
      hint.style.color = '#aaa';
      bar.appendChild(hint);
    }
    return hint;
  }

  function getConnectedGamepads() {
    if (!navigator.getGamepads) return [];
    const pads = navigator.getGamepads();
    if (!pads) return [];
    return Array.from(pads).filter(p => p && p.connected);
  }

  function isXButtonPressed(pad) {
    if (!pad || !pad.buttons) return false;
    // Cross / X is usually 0 (DS4/DS5), but we check 0 and 1 just in case
    const candidates = [0, 1];
    return candidates.some(i => pad.buttons[i] && pad.buttons[i].pressed);
  }

  function readDpadState(pad) {
    const b = pad.buttons || [];
    // Standard mapping: 12 = up, 13 = down, 14 = left, 15 = right
    return {
      up: !!(b[12] && b[12].pressed),
      down: !!(b[13] && b[13].pressed),
      left: !!(b[14] && b[14].pressed),
      right: !!(b[15] && b[15].pressed),
    };
  }

  function readStickState(pad) {
    const axes = pad.axes || [];
    const x = axes[0] || 0;
    const y = axes[1] || 0;
    const DEADZONE = 0.4;

    return {
      left: x < -DEADZONE,
      right: x > DEADZONE,
      up: y < -DEADZONE,
      down: y > DEADZONE,
    };
  }

  function combineDirections(dpad, stick) {
    return {
      up: dpad.up || stick.up,
      down: dpad.down || stick.down,
      left: dpad.left || stick.left,
      right: dpad.right || stick.right,
    };
  }

  function edge(dir, last, cur) {
    // rising edge: not-pressed -> pressed
    return !last[dir] && cur[dir];
  }

  function updateSelectedIndex(count, dirState) {
    if (count <= 1) {
      selectedGamepadIndex = 0;
      return;
    }

    let changed = false;
    if (edge('left', lastDpadState, dirState) || edge('up', lastDpadState, dirState)) {
      selectedGamepadIndex = (selectedGamepadIndex - 1 + count) % count;
      changed = true;
    }
    if (edge('right', lastDpadState, dirState) || edge('down', lastDpadState, dirState)) {
      selectedGamepadIndex = (selectedGamepadIndex + 1) % count;
      changed = true;
    }

    if (changed) {
      console.log('[xp-input] selected gamepad index:', selectedGamepadIndex);
    }

    lastDpadState = dirState;
  }

  function updateHint(pads) {
    const hint = ensureHintText();
    if (!hint) return;

    if (!isOfflineScreenVisible()) {
      hint.textContent = '';
      return;
    }

    if (pads.length === 0) {
      hint.textContent = 'Press the controller PS button to wake it, then press X to connect.';
      return;
    }

    if (pads.length === 1) {
      hint.textContent = 'Press X on your controller to Connect.';
      return;
    }

    const idx = selectedGamepadIndex % pads.length;
    const pad = pads[idx];
    const name = pad.id || 'Gamepad ' + (idx + 1);

    hint.textContent =
      `Use D-Pad or left stick to choose a controller, then press X to Connect. ` +
      `(Selected: ${idx + 1}/${pads.length} – ${name})`;
  }

  function maybeTriggerConnect(pads, activePad) {
    if (!isOfflineScreenVisible()) return;
    if (!activePad) return;
    if (typeof window.connect !== 'function') return;

    const now = Date.now();
    if (now - lastConnectAt < CONNECT_COOLDOWN_MS) return;

    console.log('[xp-input] X pressed – invoking connect()');
    lastConnectAt = now;
    window.connect();
  }

  function poll() {
    try {
      const pads = getConnectedGamepads();

      // Choose the pad we treat as "active" for X detection:
      // if multiple pads, use currently selected index
      const activePad =
        pads.length > 0 ? pads[Math.min(selectedGamepadIndex, pads.length - 1)] : null;

      // Read inputs
      let curDpad = { up: false, down: false, left: false, right: false };
      let curStick = { up: false, down: false, left: false, right: false };

      if (activePad) {
        curDpad = readDpadState(activePad);
        curStick = readStickState(activePad);
      }
      const dirState = combineDirections(curDpad, curStick);

      // Update selection index based on dpad/stick
      updateSelectedIndex(pads.length, dirState);

      // Update help text
      updateHint(pads);

      // X button to connect
      const xPressed = activePad ? isXButtonPressed(activePad) : false;
      if (xPressed && !lastXPressed) {
        maybeTriggerConnect(pads, activePad);
      }
      lastXPressed = xPressed;
    } catch (e) {
      console.error('[xp-input] poll error', e);
    }
  }

  function start() {
    setInterval(poll, POLL_INTERVAL_MS);
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
