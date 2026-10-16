// Fake XInput pads (two Logitech F310s in "X" mode, standard mapping) for scripted play-throughs.
// Drive them from tour steps: eval:__pad.btn(0,1)  eval:__pad.axis(0,-0.6)   (player 1's pad, as ever)
//                             eval:__pad2.btn(0,1)                             (a second pad, for split screen)
// Both pads have the SAME id, like two real F310s (a pad is told apart by its index, 0 and 1). Pad 1 starts unplugged, so scripts
// written for one pad see no change; plug it in with __pad2.connect() (set a button first with __pad2.btn(0,1) to play a pad that
// is revealed by a press, as Chrome does), unplug with __pad2.disconnect() (both pads have connect() / disconnect(), and
// window.__pads = [__pad, __pad2]), or start with it plugged in: add pad2=1 to the page's query string.
(() => {
  const ID = 'Logitech Gamepad F310 (STANDARD GAMEPAD Vendor: 046d Product: c21d)';
  const makePad = (index) => ({
    id: ID,
    index,
    connected: true,
    mapping: 'standard',
    timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    vibrationActuator: { playEffect: () => Promise.resolve('complete'), reset: () => Promise.resolve('complete') },
  });
  const pads = [makePad(0), makePad(1)];
  const slots = [pads[0], null, null, null];
  const fire = (type, pad) => {
    const e = new Event(type);
    e.gamepad = pad;
    window.dispatchEvent(e);
  };
  const control = (pad) => ({
    raw: pad,
    btn(i, v = 1) {
      pad.buttons[i].value = v;
      pad.buttons[i].pressed = v > 0.5;
      pad.timestamp++;
      return v;
    },
    axis(i, v) {
      pad.axes[i] = v;
      pad.timestamp++;
      return v;
    },
    /** Plug it in (the slot at its index fills, `gamepadconnected` fires). A button already held down stays held. */
    connect() {
      if (slots[pad.index] === pad) return;
      pad.connected = true;
      slots[pad.index] = pad;
      fire('gamepadconnected', pad);
    },
    /** Unplug it: the slot goes empty, `gamepaddisconnected` fires, every button and stick is released. */
    disconnect() {
      if (slots[pad.index] !== pad) return;
      pad.connected = false;
      slots[pad.index] = null;
      pad.buttons.forEach((b) => {
        b.pressed = false;
        b.touched = false;
        b.value = 0;
      });
      pad.axes.fill(0);
      pad.timestamp++;
      fire('gamepaddisconnected', pad);
    },
  });
  window.__pad = control(pads[0]);
  window.__pad2 = control(pads[1]);
  window.__pads = [window.__pad, window.__pad2];
  const startWithSecond = (() => {
    try {
      const v = new URLSearchParams(location.search).get('pad2');
      return v !== null && v !== '0' && v !== 'false';
    } catch {
      return false;
    }
  })();
  if (startWithSecond) slots[1] = pads[1];
  else pads[1].connected = false;
  navigator.getGamepads = () => [slots[0], slots[1], slots[2], slots[3]];
  window.addEventListener('load', () => {
    fire('gamepadconnected', pads[0]);
    if (slots[1]) fire('gamepadconnected', pads[1]);
  });
})();
