/* Three-panel day carousel.
   The previous implementation moved the live schedule and a separately-created
   preview. On iOS Safari those two layers could be painted on different frames.
   This carousel prepares left/current/right panels ahead of the gesture and
   moves one compositor layer only. */
export function bindDaySwipe({
  scene, stage, strip, selection, canStart, getDate, minDate, addDays,
  renderDay, onCommit, onActiveChange, onFinish, contentKey,
}) {
  let gesture = null;
  let carousel = null;
  let carouselDate = null;
  let carouselKey = null;
  let carouselWidth = 0;
  let settling = null;
  let settleTimer = null;
  let frameHandle = null;
  let warmHandle = null;
  let active = false;
  let viewportWidth = innerWidth;

  const idle = globalThis.requestIdleCallback || (fn => setTimeout(fn, 1));
  const cancelIdle = globalThis.cancelIdleCallback || clearTimeout;
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dateKey = date => date.getTime();
  const selectedIndex = () => Number(strip.dataset.selectedIndex) || 0;
  const selectionOffset = progress =>
    Math.max(0, Math.min(6, selectedIndex() + progress)) * 100;

  const setActive = value => {
    if (active === value) return;
    active = value;
    document.documentElement.classList.toggle("is-day-swiping", value);
    scene.classList.toggle("is-carousel-swiping", value);
    strip.classList.toggle("is-day-swiping", value);
    onActiveChange?.(value);
  };

  /* Копия дня не должна дублировать id живой сцены, но часть оформления
     («через 15 мин», часы, прогресс) привязана именно к id. Переносим имя
     id в класс, иначе в панели текст теряет акцент и становится серым. */
  const sanitize = node => {
    node.querySelectorAll("[id]").forEach(el => {
      const id = el.getAttribute("id");
      if (id) el.classList.add(id);
      el.removeAttribute("id");
    });
    node.querySelectorAll("button, a, input, textarea, select").forEach(el => {
      el.setAttribute("tabindex", "-1");
    });
  };

  const dayPanel = (date, position, blocked = false) => {
    const panel = document.createElement("div");
    // Namespaced state: generic .is-current is used by live-lesson styles and
    // made the whole carousel's centre panel inherit today's green colors.
    panel.className = `sched-swipe-panel is-swipe-${position}`;
    panel.setAttribute("aria-hidden", "true");
    panel.inert = true;
    if (blocked) {
      panel.classList.add("is-blocked");
      panel.innerHTML = '<div class="sched-easter-egg-wrap"><span class="sched-easter-egg-msg">привет=)</span></div>';
    } else {
      panel.innerHTML = renderDay(date);
      sanitize(panel);
    }
    return panel;
  };

  const removeCarousel = () => {
    carousel?.remove();
    carousel = null;
    carouselDate = null;
    carouselKey = null;
    carouselWidth = 0;
  };

  /* Панели готовятся заранее, поэтому они устаревают после любой
     перерисовки (режим редактора, окна, замены). Ключ содержимого
     заставляет пересобрать карусель вместо показа старого дня. */
  const currentKey = () => (contentKey ? String(contentKey()) : "");
  const isStale = date =>
    !carousel || !carousel.isConnected || !carouselDate ||
    dateKey(carouselDate) !== dateKey(date) || carouselKey !== currentKey();

  const buildCarousel = date => {
    removeCarousel();
    const leftDate = addDays(date, -1);
    const leftBlocked = leftDate < minDate();
    const track = document.createElement("div");
    track.className = "sched-swipe-carousel is-warmed";
    track.setAttribute("aria-hidden", "true");
    track.inert = true;
    track.append(
      dayPanel(leftDate, "left", leftBlocked),
      dayPanel(date, "current"),
      dayPanel(addDays(date, 1), "right"),
    );
    scene.appendChild(track);
    carousel = track;
    carouselDate = new Date(date);
    carouselKey = currentKey();
    carouselWidth = stage.offsetWidth || innerWidth;
    track.style.transform = `translate3d(${-carouselWidth}px, 0, 0)`;
    return track;
  };

  const ensureCarousel = date => {
    if (isStale(date)) {
      return buildCarousel(date);
    }
    carouselWidth = stage.offsetWidth || innerWidth;
    carousel.style.transform = `translate3d(${-carouselWidth}px, 0, 0)`;
    return carousel;
  };

  const prewarm = () => {
    if (warmHandle !== null) cancelIdle(warmHandle);
    warmHandle = idle(() => {
      warmHandle = null;
      if (gesture || settling || active) return;
      const date = new Date(getDate());
      if (isStale(date)) buildCarousel(date);
    });
  };

  const paint = now => {
    frameHandle = null;
    const g = gesture;
    if (!g || g.axis !== "x" || !carousel) return;
    const previous = g.paintTime || now - 16.7;
    const dt = Math.min(0.05, Math.max(0.001, (now - previous) / 1000));
    g.paintTime = now;
    const alpha = reduced() ? 1 : 1 - Math.exp(-60 * dt);
    g.visual += (g.target - g.visual) * alpha;
    if (Math.abs(g.target - g.visual) < 0.08) g.visual = g.target;

    carousel.style.transform = `translate3d(${(-g.width + g.visual).toFixed(2)}px, 0, 0)`;
    carousel.style.setProperty("--blocked-reveal", `${g.blocked ? Math.max(0, g.visual).toFixed(2) : 0}px`);
    selection.style.transform = `translate3d(${selectionOffset(g.blocked ? 0 : -g.visual / g.width).toFixed(2)}%, 0, 0)`;

    if (Math.abs(g.target - g.visual) >= 0.08) {
      frameHandle = requestAnimationFrame(paint);
    }
  };

  const requestPaint = () => {
    if (frameHandle === null) frameHandle = requestAnimationFrame(paint);
  };

  const stopFrame = () => {
    if (frameHandle !== null) cancelAnimationFrame(frameHandle);
    frameHandle = null;
  };

  const resetVisuals = () => {
    clearTimeout(settleTimer);
    settleTimer = null;
    stopFrame();
    gesture = null;
    settling = null;
    scene.classList.remove("is-swiping", "is-swipe-commit", "is-swipe-return");
    strip.classList.remove("is-swipe-linked", "is-swipe-settling");
    selection.style.removeProperty("transform");
    if (carousel) {
      carousel.classList.remove("is-active", "is-settling");
      carousel.classList.add("is-warmed");
      carousel.style.removeProperty("transition-duration");
      carousel.style.removeProperty("--blocked-reveal");
      carousel.style.transform = `translate3d(${-carouselWidth}px, 0, 0)`;
    }
    setActive(false);
  };

  const complete = (allowCommit = true) => {
    if (!gesture && !settling && !active) return;
    const pending = settling;
    const target = allowCommit && pending?.target &&
      dateKey(getDate()) === dateKey(pending.date) ? pending.target : null;
    resetVisuals();
    if (target) onCommit(target);
    onFinish?.();
    // The selected date may have changed synchronously in onCommit.
    prewarm();
  };

  scene.addEventListener("touchstart", event => {
    if (!canStart() || event.touches.length !== 1) { complete(false); return; }
    const touch = event.touches[0];
    if (touch.target.closest("button, a, input, textarea, select, [role=dialog]")) {
      complete(false);
      return;
    }
    complete(true);
    const date = new Date(getDate());
    /* Панель только готовится. Показываем её исключительно после того, как
       жест признан горизонтальным: обычное нажатие, скролл или удержание
       пары в редакторе больше не подменяют живой день его копией. */
    const track = ensureCarousel(date);
    track.classList.remove("is-settling");
    track.classList.add("is-warmed");
    gesture = {
      x: touch.clientX,
      y: touch.clientY,
      date,
      width: carouselWidth,
      axis: null,
      target: 0,
      visual: 0,
      paintTime: 0,
      blocked: false,
    };
  }, { passive: true });

  scene.addEventListener("touchmove", event => {
    const g = gesture;
    if (!g) return;
    if (!canStart() || event.touches.length !== 1) { complete(false); return; }
    const touch = event.touches[0];
    const dx = touch.clientX - g.x;
    const dy = touch.clientY - g.y;
    if (!g.axis) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
      g.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (g.axis === "x") {
        const track = ensureCarousel(g.date);
        track.classList.remove("is-warmed", "is-settling");
        track.classList.add("is-active");
        g.width = carouselWidth || g.width;
        setActive(true);
        scene.classList.add("is-swiping");
        strip.classList.add("is-swipe-linked");
        strip.classList.remove("is-hop", "is-releasing");
        selection.classList.remove("is-hop");
      }
    }
    if (g.axis !== "x") return;
    if (event.cancelable) event.preventDefault();

    const direction = dx < 0 ? 1 : -1;
    g.blocked = direction < 0 && addDays(g.date, -1) < minDate();
    const limited = Math.sign(dx) * Math.min(Math.abs(dx), g.width);
    g.target = g.blocked ? limited * 0.42 : limited;
    requestPaint();
  }, { passive: false });

  const end = allowCommit => {
    const g = gesture;
    if (!g) return;
    if (g.axis !== "x") { complete(false); return; }
    stopFrame();

    const direction = g.target < 0 ? 1 : -1;
    const commit = allowCommit && !g.blocked &&
      Math.abs(g.target) >= Math.max(64, Math.min(110, g.width * 0.22));
    const visible = g.visual;
    const destination = commit
      ? (direction > 0 ? -2 * g.width : 0)
      : -g.width;
    const currentTrackX = -g.width + visible;
    const distance = Math.abs(destination - currentTrackX);
    const duration = reduced() ? 0 : Math.round(Math.min(300, Math.max(160, 125 + distance * 0.38)));

    carousel.style.transform = `translate3d(${currentTrackX.toFixed(2)}px, 0, 0)`;
    carousel.getBoundingClientRect();
    carousel.classList.add("is-settling");
    carousel.style.setProperty("transition-duration", `${duration}ms`);
    scene.classList.remove("is-swiping");
    scene.classList.add(commit ? "is-swipe-commit" : "is-swipe-return");
    strip.classList.remove("is-swipe-linked");
    strip.classList.add("is-swipe-settling");
    carousel.style.transform = `translate3d(${destination}px, 0, 0)`;
    selection.style.transform = `translate3d(${selectionOffset(commit ? direction : 0).toFixed(2)}%, 0, 0)`;

    gesture = null;
    settling = { date: g.date, target: commit ? addDays(g.date, direction) : null };
    if (duration === 0) complete(true);
    else settleTimer = setTimeout(() => complete(true), duration + 34);
  };

  scene.addEventListener("touchend", () => end(true), { passive: true });
  scene.addEventListener("touchcancel", () => end(false), { passive: true });
  document.addEventListener("pointerdown", event => {
    if (active && !scene.contains(event.target)) complete(false);
  }, true);
  window.addEventListener("blur", () => complete(false));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) complete(false);
  });
  window.addEventListener("resize", () => {
    if (innerWidth !== viewportWidth) {
      viewportWidth = innerWidth;
      removeCarousel();
      complete(false);
      prewarm();
    }
  });

  prewarm();
  return {
    cancel: () => {
      if (gesture || settling || active) complete(false);
      else removeCarousel();
    },
    /* Вызывается после перерисовки расписания: заранее подготовленные
       панели пересобираются с актуальным содержимым. */
    invalidate: () => {
      if (gesture || settling || active) return;
      removeCarousel();
      prewarm();
    },
  };
}
