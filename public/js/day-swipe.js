/* One gesture owns the scene until it settles. Only transforms are animated. */
export function bindDaySwipe({
  scene, stage, strip, selection, canStart, getDate, minDate, addDays,
  renderDay, onCommit, onActiveChange, onFinish,
}) {
  let gesture = null, peek = null, settling = null, timer = null, active = false;
  let viewportWidth = innerWidth;
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const width = () => stage.offsetWidth || innerWidth;
  const setActive = value => {
    if (active === value) return;
    active = value;
    strip.classList.toggle("is-day-swiping", value);
    onActiveChange?.(value);
  };
  const shiftStage = x => stage.style.setProperty("--swipe-x", `${x.toFixed(2)}px`);
  const shiftSelection = progress => {
    const index = Number(strip.dataset.selectedIndex) || 0;
    selection.style.transform = `translate3d(${Math.max(0, Math.min(6, index + progress)) * 100}%, 0, 0)`;
  };
  const clearVisuals = () => {
    clearTimeout(timer);
    timer = null;
    gesture = null;
    settling = null;
    peek?.remove();
    peek = null;
    scene.classList.remove("is-swiping", "is-swipe-commit", "is-swipe-return");
    scene.style.removeProperty("--swipe-anim-dur");
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
    peek?.remove();
    peek = document.createElement("div");
    peek.className = "sched-swipe-peek";
    peek.dataset.direction = direction;
    peek.setAttribute("aria-hidden", "true");
    peek.inert = true;
    if (blocked) {
      peek.classList.add("is-easter-egg");
      peek.innerHTML = '<div class="sched-easter-egg-wrap"><span class="sched-easter-egg-msg">привет=)</span></div>';
    } else {
      peek.innerHTML = renderDay(addDays(gesture.date, direction));
      // The preview is inert and must not duplicate live clock / button IDs.
      peek.querySelectorAll("[id]").forEach(el => el.removeAttribute("id"));
    }
    scene.appendChild(peek);
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
    gesture = { x: touch.clientX, y: touch.clientY, shift: 0, axis: null, date: new Date(getDate()), blocked: false };
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
      }
    }
    if (gesture.axis !== "x") return;
    if (event.cancelable) event.preventDefault();
    const w = width(), direction = dx < 0 ? 1 : -1;
    gesture.blocked = addDays(gesture.date, direction) < minDate();
    const limited = Math.sign(dx) * Math.min(Math.abs(dx), w);
    gesture.shift = gesture.blocked ? limited * 0.55 : limited;
    const preview = ensurePeek(direction, gesture.blocked);
    shiftStage(gesture.shift);
    preview.style.transform = `translate3d(${direction * w + gesture.shift}px, 0, 0)`;
    if (gesture.blocked) {
      preview.style.setProperty("--easter-egg-width", `${Math.max(1, Math.abs(gesture.shift))}px`);
      preview.style.setProperty("--easter-egg-opacity", String(Math.min(1, Math.max(0, (Math.abs(gesture.shift) - 20) / 64))));
      preview.style.setProperty("--easter-egg-scale", "1");
    }
    shiftSelection(gesture.blocked ? 0 : -gesture.shift / w);
  }, { passive: false });

  const end = allowCommit => {
    if (!gesture) return;
    if (gesture.axis !== "x") { complete(false); return; }
    const g = gesture, w = width(), direction = g.shift < 0 ? 1 : -1;
    const commit = allowCommit && !g.blocked && Math.abs(g.shift) >= Math.max(64, Math.min(110, w * 0.22));
    const distance = commit ? w - Math.abs(g.shift) : Math.abs(g.shift);
    const duration = reduced() ? 0 : Math.round(Math.min(320, Math.max(170, 140 + distance * 0.45)));
    // Flush the last finger position before enabling the settle transition.
    stage.getBoundingClientRect();
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
    if (innerWidth !== viewportWidth) { viewportWidth = innerWidth; complete(false); }
  });
  return { cancel: () => { if (gesture || settling || active) complete(false); } };
}