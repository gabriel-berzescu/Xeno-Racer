// Builds a championship inside the running game and opens one of its screens, for screenshots and UI work.
// Dev server only: it imports the TypeScript modules through Vite. Set window.__fxCfg first, then run this file.
//
//   node scripts/tour.mjs "?x=1" --out shots/champ --init scripts/fixtures/fake-pad.js --steps \
//     "wait:2500;eval:window.__fxCfg={rounds:2,screen:'standings',via:'results'};evalfile:scripts/fixtures/championship.js;wait:3500;shot:standings"
//
// It only sets what the menus show: the game itself has no such season, so "Next round" does nothing, unless `save`
// is set and the page is reloaded (then the game loads the saved season, and everything works).
//
// window.__fxCfg (all optional)
//   rounds  completed rounds, 0..6 (default 2)         screen  'standings' | 'champion' | 'main' | null (default 'standings')
//   via     'results': enter the screen from the results screen, which plays the standings reveal
//   opp     opponents 1..11 (default 7)                win     the player wins most rounds
//   seed    season seed (default 4242)                 length  'short' | 'standard' | 'long'
//   grid    'standings' | 'reverse'                    start   'back' | 'middle' | 'pole'
//   save    also write the season to localStorage, so a page reload resumes it
(async () => {
  const cfg = Object.assign({ rounds: 2, screen: 'standings', win: false, opp: 7, save: false, seed: 4242, length: 'standard', grid: 'standings', start: 'back' }, window.__fxCfg || {});
  const m = await import('/src/game/championship.ts');
  const { CARS } = await import('/src/cars/index.ts');
  const { TRACKS } = await import('/src/track/index.ts');
  const game = window.__GAME__;
  const car = CARS[0];
  const name = game.settings.playerName;
  let s = m.createChampionship({
    setup: { carId: car.id, livery: { driver: name }, difficulty: 'pro', opponents: cfg.opp, length: cfg.length, startPosition: cfg.start, grid: cfg.grid },
    tracks: TRACKS.map((t) => t.info),
    playerName: name,
    playerLivery: { ...car.defaultLivery, driver: name },
    car,
    seed: cfg.seed,
  });
  // play the rounds with pseudo-random results: the player lands in the top six, or wins when `win` is set
  const rand = m.seededRandom(cfg.seed + 11);
  const ids = s.drivers.map((d) => d.id);
  for (let r = 0; r < Math.min(cfg.rounds, s.calendar.length); r++) {
    const others = ids.filter((id) => id !== 'player').sort(() => rand() - 0.5);
    let mine = Math.floor(rand() * Math.min(6, ids.length));
    if (cfg.win) mine = r === cfg.rounds - 1 || rand() < 0.55 ? 0 : Math.floor(rand() * 3);
    const order = [...others.slice(0, mine), 'player', ...others.slice(mine)];
    const quickest = Math.floor(rand() * Math.min(5, order.length));
    s = m.recordRound(
      s,
      order.map((id, i) => ({ id, position: i + 1, totalTime: 280 + i * 1.7 + r, bestLap: 88.4 + i * 0.12 + (i === quickest ? -1.5 : 0) + rand() * 0.2, laps: s.calendar[r].laps })),
    );
  }
  if (cfg.save) m.saveChampionship(s);
  const view = m.buildView(s, name);
  game.ui.setChampionship(view);
  if (cfg.via) {
    game.ui.show(cfg.via);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  if (cfg.screen) game.ui.show(cfg.screen);
  return { done: view.done, complete: view.complete, player: view.player.position, points: view.player.points, table: view.table.map((r) => r.name).join(', ') };
})();
