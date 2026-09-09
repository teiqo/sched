/* One gesture owns the scene until it settles. Only transforms are animated.
   Per-frame work is batched into a single rAF write pass: no layout reads and
   no custom-property writes while the finger is down, so a slow drag stays at
   display frame rate. */
export function bindDaySwipe({
  scene, stage, strip, selection, canStart, getDate, minDate, addDays,
  renderDay, onCommit, onActiveChange, onFinish,
}) {
  let gesture = null, peek = null, settling = null, timer = null, active = false;
  let viewportWidth = innerWidth;
  let stageWidth = 0;
  // On iOS, moving #stage is expensive because it also contains every future
  // day in week mode. Move only the currently visible day instead.
  let mover = stage;
  let frame = null, frameHandle = null;
  let warm = null, warmHandle = null;
  const idle = globalThis.requestIdleCallback || (fn => setTimeout(() => fn(), 1));
  const unidle = globalThis.cancelIdleCallback || clearTimeout;
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Measured once per gesture: reading offsetWidth inside touchmove forces a
  // synchronous layout on every finger move.
  const measure = () => { stageWidth = stage.offsetWidth || innerWidth; return stageWidth; };
  const width = () => stageWidth || measure();
  const setActive = value => {
    if (active === value) return;
    active = value;
    // Paint-heavy chrome (sticky blur, shadows, particles) is switched off for
    // the duration of the gesture through a single root-level class.
    document.documentElement.classList.toggle("is-day-swiping", value);
    strip.classList.toggle("is-day-swiping", value);
    onActiveChange?.(value);
  };
  // Inline transforms beat the CSS var rules and avoid invalidating the style
  // of the whole subtree that inherits --swipe-x on every frame.
  // Keep sub-pixel precision, like the smooth date roulette. Rounding to whole
  // CSS pixels is visibly stair-stepped on a 3x iPhone display.
  const shiftStage = x => { mover.style.transform = `translate3d(${x.toFixed(2)}px, 0, 0)`; };
  const selectionOffset = progress => {
    const index = Number(strip.dataset.selectedIndex) || 0;
    return Math.max(0, Math.min(6, index + progress)) * 100;
  };
  const shiftSelection = progress => {
    selection.style.transform = `translate3d(${selectionOffset(progress).toFixed(2)}%, 0, 0)`;
  };
  const cancelFrame = () => {
    if (frameHandle !== null) cancelAnimationFrame(frameHandle);
    frameHandle = null;
    frame = null;
  };
  const paint = now => {
    frameHandle = null;
    const f = frame;
    const g = gesture;
    if (!f || !g || g.axis !== "x") return;

    /* iOS Safari dispatches touchmove much less often than the display refresh
       rate (especially on ProMotion). Applying the last event directly makes a
       slow swipe advance in visible steps. The roulette is smooth because it
       runs an interpolation loop on every animation frame; do the same here. */
    const previousTime = g.paintTime || now - 16.7;
    const dt = Math.min(0.05, Math.max(0.001, (now - previousTime) / 1000));
    g.paintTime = now;
    const target = f.shift;
    const current = Number.isFinite(g.visualShift) ? g.visualShift : 0;
    const alpha = reduced() ? 1 : 1 - Math.exp(-58 * dt);
    let visual = current + (target - current) * alpha;
    if (Math.abs(target - visual) < 0.12) visual = target;
    g.visualShift = visual;

    shiftStage(visual);
    f.preview.style.transform = `translate3d(${(f.direction * f.width + visual).toFixed(2)}px, 0, 0)`;
    if (f.blocked) {
      f.preview.style.setProperty("--easter-egg-width", `${Math.round(Math.max(1, Math.abs(visual)))}px`);
      f.preview.style.setProperty("--easter-egg-opacity", String(Math.min(1, Math.max(0, (Math.abs(visual) - 20) / 64))));
    }
    selection.style.transform = `translate3d(${selectionOffset(f.blocked ? 0 : -visual / f.width).toFixed(2)}%, 0, 0)`;

    // Keep drawing between sparse touch events until the visual catches up.
    if (Math.abs(target - visual) >= 0.12) frameHandle = requestAnimationFrame(paint);
  };
  const schedule = next => {
    frame = next;
    if (frameHandle === null) frameHandle = requestAnimationFrame(paint);
  };
  const dropWarm = () => {
    if (warmHandle !== null) unidle(warmHandle);
    warmHandle = null;
    if (warm) {
      for (const direction of [1, -1]) {
        const node = warm[direction];
        if (node && node !== peek) node.remove();
      }
    }
    warm = null;
  };
  const buildPeek = (date, direction, blocked) => {
    const node = document.createElement("div");
    node.className = "sched-swipe-peek";
    node.dataset.direction = String(direction);
    node.setAttribute("aria-hidden", "true");
    node.inert = true;
    if (blocked) {
      node.classList.add("is-easter-egg");
      node.innerHTML = '<div class="sched-easter-egg-wrap"><span class="sched-easter-egg-msg">привет=)</span></div>';
      node.style.setProperty("--easter-egg-scale", "1");
    } else {
      node.innerHTML = renderDay(addDays(date, direction));
      // The preview is inert and must not duplicate live clock / button IDs.
      node.querySelectorAll("[id]").forEach(el => el.removeAttribute("id"));
    }
    return node;
  };
  // Rendering a whole day inside the first move frame is the one heavy step of
  // the gesture. Build BOTH neighbours while the finger is still resting and
  // mount them off-screen, so WebKit lays them out, paints them and promotes
  // the compositor layers before anything starts moving.
  const prewarm = date => {
    dropWarm();
    const w = width();
    warmHandle = idle(() => {
      warmHandle = null;
      if (!gesture) return;
      const forwardBlocked = addDays(date, 1) < minDate();
      const backBlocked = addDays(date, -1) < minDate();
      const forward = buildPeek(date, 1, forwardBlocked);
      const back = buildPeek(date, -1, backBlocked);
      forward.style.transform = `translate3d(${w}px, 0, 0)`;
      back.style.transform = `translate3d(${-w}px, 0, 0)`;
      forward.classList.add("is-warming");
      back.classList.add("is-warming");
      scene.appendChild(forward);
      scene.appendChild(back);
      warm = {
        date,
        1: forward,
        "-1": back,
        blocked: { 1: forwardBlocked, "-1": backBlocked },
      };
    });
  };
  const clearVisuals = () => {
    clearTimeout(timer);
    timer = null;
    cancelFrame();
    dropWarm();
    gesture = null;
    settling = null;
    peek?.remove();
    peek = null;
    scene.classList.remove("is-swiping", "is-swipe-commit", "is-swipe-return");
    scene.style.removeProperty("--swipe-anim-dur");
    mover.style.removeProperty("transform");
    mover.classList.remove("is-swipe-mover");
    mover = stage;
    stage.style.removeProperty("transform");
    stage.style.removeProperty("--swipe-x");
    strip.classList.remove("is-swipe-linked", "is-swipe-settling");
    strip.style.removeProperty("--strip-swipe-duration");
    selection.style.removeProperty("transform");
    setActive(false);
  };
  const complete = (allowCommit = true) => {
    if (!gesture && !settling && !active && !peek) return;
    const pending = settling;
    const target = allowCommit && pending?.target &&
      getDate().getTime() === pending.date.getTime() ? pending.target : null;
    clearVisuals();
    if (target) onCommit(target);
    onFinish?.();
  };
  const ensurePeek = (direction, blocked) => {
    if (peek?.dataset.direction === String(direction)) return peek;
    if (peek && peek !== warm?.[direction]) peek.remove();
    const cached = warm && warm.date.getTime() === gesture.date.getTime() &&
      warm.blocked[direction] === blocked ? warm[direction] : null;
    if (cached) {
      // Already mounted and rasterised: only drop the parked state.
      cached.classList.remove("is-warming");
      peek = cached;
    } else {
      peek = buildPeek(gesture.date, direction, blocked);
      scene.appendChild(peek);
    }
    // The opposite preview must not keep a live layer during the gesture.
    const other = warm?.[direction === 1 ? -1 : 1];
    if (other && other !== peek) other.remove();
    return peek;
  };

  scene.addEventListener("touchstart", event => {
    if (!canStart() || event.touches.length !== 1) { complete(false); return; }
    const touch = event.touches[0];
    if (touch.target.closest("button, a, input, textarea, select, [role=dialog]")) {
      complete(false);
      return;
    }
    // Finish an earlier committed swipe before taking the next starting date.
    complete(true);
    const date = new Date(getDate());
    gesture = {
      x: touch.clientX, y: touch.clientY, shift: 0, visualShift: 0,
      paintTime: 0, direction: 0, axis: null, date, blocked: false,
    };
    mover = stage.querySelector("#day-scene > .sched-day-block:first-child") || stage;
    mover.classList.add("is-swipe-mover");
    measure();
    prewarm(date);
  }, { passive: true });

  scene.addEventListener("touchmove", event => {
    if (!gesture) return;
    if (!canStart() || event.touches.length !== 1) { complete(false); return; }
    const touch = event.touches[0];
    const dx = touch.clientX - gesture.x, dy = touch.clientY - gesture.y;
    if (!gesture.axis) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
      gesture.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (gesture.axis === "x") {
        setActive(true);
        scene.classList.add("is-swiping");
        strip.classList.add("is-swipe-linked");
        strip.classList.remove("is-hop", "is-releasing");
        selection.classList.remove("is-hop");
      } else {
        dropWarm();
      }
    }
    if (gesture.axis !== "x") return;
    if (event.cancelable) event.preventDefault();
    const w = width(), direction = dx < 0 ? 1 : -1;
    if (gesture.direction && gesture.direction !== direction) {
      // Direction changes cross zero; don't drag a preview from the other edge.
      gesture.visualShift = 0;
      gesture.paintTime = 0;
    }
    gesture.direction = direction;
    gesture.blocked = addDays(gesture.date, direction) < minDate();
    const limited = Math.sign(dx) * Math.min(Math.abs(dx), w);
    gesture.shift = gesture.blocked ? limited * 0.55 : limited;
    const preview = ensurePeek(direction, gesture.blocked);
    schedule({
      preview,
      shift: gesture.shift,
      direction,
      width: w,
      blocked: gesture.blocked,
    });
  }, { passive: false });

  const end = allowCommit => {
    if (!gesture) return;
    if (gesture.axis !== "x") { complete(false); return; }
    const g = gesture, w = width(), direction = g.shift < 0 ? 1 : -1;
    // Write the last finger position synchronously so the settle transition
    // starts from where the finger actually left the screen.
    cancelFrame();
    dropWarm();
    // Settle from the last actually painted position, not from a newer sparse
    // touch event; otherwise Safari shows a jump exactly at finger release.
    const visibleShift = Number.isFinite(g.visualShift) ? g.visualShift : g.shift;
    shiftStage(visibleShift);
    if (peek) peek.style.transform = `translate3d(${(direction * w + visibleShift).toFixed(2)}px, 0, 0)`;
    shiftSelection(g.blocked ? 0 : -visibleShift / w);
    const commit = allowCommit && !g.blocked && Math.abs(g.shift) >= Math.max(64, Math.min(110, w * 0.22));
    const distance = commit ? w - Math.abs(visibleShift) : Math.abs(visibleShift);
    const duration = reduced() ? 0 : Math.round(Math.min(320, Math.max(170, 140 + distance * 0.45)));
    // Flush the last finger position before enabling the settle transition.
    mover.getBoundingClientRect();
    peek?.getBoundingClientRect();
    scene.style.setProperty("--swipe-anim-dur", `${duration}ms`);
    strip.style.setProperty("--strip-swipe-duration", `${duration}ms`);
    scene.classList.remove("is-swiping");
    scene.classList.add(commit ? "is-swipe-commit" : "is-swipe-return");
    strip.classList.remove("is-swipe-linked");
    strip.classList.add("is-swipe-settling");
    shiftStage(commit ? -direction * w : 0);
    if (peek) {
      if (!commit) peek.classList.add("is-returning");
      peek.style.transform = `translate3d(${commit ? 0 : direction * w}px, 0, 0)`;
    }
    shiftSelection(commit ? direction : 0);
    gesture = null;
    settling = { date: g.date, target: commit ? addDays(g.date, direction) : null };
    if (duration === 0) complete(true);
    else timer = setTimeout(() => complete(true), duration + 34);
  };
  scene.addEventListener("touchend", () => end(true), { passive: true });
  scene.addEventListener("touchcancel", () => end(false), { passive: true });
  document.addEventListener("pointerdown", event => {
    if (active && !scene.contains(event.target)) complete(false);
  }, true);
  window.addEventListener("blur", () => complete(false));
  document.addEventListener("visibilitychange", () => { if (document.hidden) complete(false); });
  window.addEventListener("resize", () => {
    // iPhone browser chrome can change height in the middle of a gesture.
    if (innerWidth !== viewportWidth) { viewportWidth = innerWidth; stageWidth = 0; complete(false); }
  });
  return { cancel: () => { if (gesture || settling || active) complete(false); } };
}
