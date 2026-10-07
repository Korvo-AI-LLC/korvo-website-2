/* Simulated call. Characters occupy their final positions; reveal changes opacity only. */
(function () {
  'use strict';
  var demo = document.getElementById('callDemo');
  if (!demo) return;
  var timer = document.getElementById('callTimer');
  var pause = document.getElementById('callPause');
  var motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var characters = [];
  var labels = [];
  var starts = [0, 6500, 11000];
  var duration = 24000;
  var task = null;
  var started = 0;
  var elapsed = 0;
  var revealed = 0;
  var userPaused = false;

  document.querySelectorAll('#callLines p').forEach(function (line, row) {
    labels.push({ node: line.querySelector('strong'), at: starts[row] });
    var text = line.querySelector('span');
    var fragment = document.createDocumentFragment();
    Array.from(text.textContent).forEach(function (letter, index) {
      var character = document.createElement('span');
      character.className = 'call-char';
      character.setAttribute('aria-hidden', 'true');
      character.textContent = letter;
      fragment.appendChild(character);
      characters.push({ node: character, at: starts[row] + index * 55 });
    });
    text.replaceChildren(fragment);
  });

  function stop() {
    clearTimeout(task);
    task = null;
    demo.classList.remove('demo-running');
  }
  function reset() {
    elapsed = 0;
    revealed = 0;
    characters.forEach(function (c) { c.node.style.opacity = '0'; });
    labels.forEach(function (label) { label.node.style.opacity = '0'; });
    timer.textContent = '00:00';
  }
  function tick() {
    elapsed = performance.now() - started;
    if (elapsed >= duration) { reset(); started = performance.now(); }
    while (revealed < characters.length && characters[revealed].at <= elapsed) {
      characters[revealed++].node.style.opacity = '1';
    }
    labels.forEach(function (label) { label.node.style.opacity = elapsed >= label.at ? '1' : '0'; });
    var time = '00:' + String(Math.floor(elapsed / 1000)).padStart(2, '0');
    if (timer.textContent !== time) timer.textContent = time;
    task = setTimeout(tick, 55);
  }
  function resume() {
    if (motion.matches || document.hidden || userPaused) return;
    started = performance.now() - elapsed;
    demo.classList.add('demo-running');
    tick();
  }
  function configure() {
    stop();
    pause.hidden = motion.matches;
    if (motion.matches) {
      characters.forEach(function (c) { c.node.style.opacity = '1'; });
      labels.forEach(function (label) { label.node.style.opacity = '1'; });
      timer.textContent = '00:24';
    } else { reset(); resume(); }
  }
  pause.addEventListener('click', function () {
    userPaused = !userPaused;
    pause.textContent = userPaused ? 'Resume demo' : 'Pause demo';
    if (userPaused) stop(); else resume();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop(); else resume();
  });
  motion.addEventListener('change', configure);
  configure();
})();
