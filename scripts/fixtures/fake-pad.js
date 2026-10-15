// Fake XInput pad (Logitech F310 in "X" mode, standard mapping) for scripted play-throughs.
// Drive it from tour steps: eval:__pad.btn(0,1)  eval:__pad.axis(0,-0.6)
(() => {
  const pad = {
    id: 'Logitech Gamepad F310 (STANDARD GAMEPAD Vendor: 046d Product: c21d)',
    index: 0,
    connected: true,
    mapping: 'standard',
    timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    vibrationActuator: { playEffect: () => Promise.resolve('complete'), reset: () => Promise.resolve('complete') },
  };
  window.__pad = {
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
  };
  navigator.getGamepads = () => [pad, null, null, null];
  window.addEventListener('load', () => {
    const e = new Event('gamepadconnected');
    e.gamepad = pad;
    window.dispatchEvent(e);
  });
})();
