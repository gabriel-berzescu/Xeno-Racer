import { Game } from './game/game';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;

const game = new Game(canvas, ui);
game.boot().catch((err: unknown) => {
  console.error(err);
  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;inset:24px;color:#ff2e63;font:14px/1.5 monospace;white-space:pre-wrap;z-index:99';
  pre.textContent = `Xeno-Racer failed to start:\n\n${err instanceof Error ? err.stack ?? err.message : String(err)}`;
  document.body.appendChild(pre);
});
