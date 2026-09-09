/* Sortable day preview. Nothing is saved until pointerup; Escape restores the DOM. */
export function pairOrder(slots, fromN, toN) {
  const ordered = slots.slice().sort((a, b) => a.n - b.n);
  const result = ordered.map(slot => slot.n);
  const from = ordered.findIndex(slot => slot.n === fromN), to = ordered.findIndex(slot => slot.n === toN);
  if (from < 0 || to < 0 || from === to || ordered[from].window || ordered[from].cancelled) return result;
  if (ordered[to].window || ordered[to].cancelled) {
    [result[from], result[to]] = [result[to], result[from]];
  } else {
    const occupied = ordered.filter(slot => !slot.window && !slot.cancelled).map(slot => slot.n);
    const a = occupied.indexOf(fromN), b = occupied.indexOf(toN);
    const [moved] = occupied.splice(a, 1);
    occupied.splice(b, 0, moved);
    let i = 0;
    ordered.forEach((slot, index) => { if (!slot.window && !slot.cancelled) result[index] = occupied[i++]; });
  }
  return result;
}

export function bindPairDrag({ scene, slotsForDate, renderRow, onSwap, onReorder, onActiveChange, onFinish }) {
  let pending = null, drag = null, timer = null, frame = null, suppressUntil = 0;
  const reduced = () => document.documentElement.hasAttribute('data-perf') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clearPending = () => { clearTimeout(timer); timer = null; pending = null; };
  const scrollerFor = node => {
    for (let el = node.parentElement; el && el !== document.body; el = el.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight) return el;
    }
    return document.scrollingElement;
  };
  const removeListeners = () => {
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('pointercancel', onCancel, true);
    document.removeEventListener('touchmove', onTouchMove, true);
    document.removeEventListener('touchend', onTouchEnd, true);
    document.removeEventListener('touchcancel', onTouchCancel, true);
  };
  const announce = text => { if (drag && drag.status.textContent !== text) drag.status.textContent = text; };
  const applyOrder = targetN => {
    const d = drag;
    if (!d || d.previewN === targetN) return;
    d.previewN = targetN;
    const before = new Map([...d.items.values()].map(row => [row, row.getBoundingClientRect().top]));
    const order = pairOrder(d.slots, d.fromN, targetN);
    const fragment = document.createDocumentFragment();
    order.forEach((originN, i) => {
      const row = d.items.get(originN), slot = d.slots[i];
      row.getAnimations().forEach(a => a.cancel());
      row.dataset.dropN = slot.n;
      if (row.dataset.rowN) row.dataset.rowN = slot.n;
      if (row.dataset.n) row.dataset.n = slot.n;
      row.querySelector('.agenda-row-num').textContent = slot.n;
      row.querySelector('.agenda-row-time time').innerHTML = `${slot.from}<span>${slot.to}</span>`;
      row.classList.toggle('is-drop-target', originN === d.fromN && targetN !== d.fromN);
      fragment.appendChild(row);
    });
    d.board.appendChild(fragment);
    for (const row of d.items.values()) {
      const delta = before.get(row) - row.getBoundingClientRect().top;
      // Only real neighbours move on hover. Windows and the source are static targets.
      if (delta && !reduced() && !row.classList.contains('is-drag-ghost') && !row.classList.contains('is-drag-src')) row.animate([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
        { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  };
  const followPointer = () => {
    const d = drag;
    if (!d) return;
    d.clone.classList.remove('is-magnetized');
    d.clone.style.left = Math.max(0, Math.min(innerWidth - d.clone.offsetWidth, d.x - d.grabX)) + 'px';
    d.clone.style.top = d.y - d.grabY + 'px';
  };
  const centerCloneOnPlaceholder = () => {
    const d = drag, placeholder = d?.items.get(d.fromN);
    if (!placeholder?.isConnected) return;
    const targetRect = placeholder.getBoundingClientRect();
    d.clone.style.left = targetRect.left + (targetRect.width - d.clone.offsetWidth) / 2 + 'px';
    d.clone.style.top = targetRect.top + (targetRect.height - d.clone.offsetHeight) / 2 + 'px';
  };
  const updateTarget = () => {
    const d = drag;
    if (!d || !d.moved) return false;
    const boardRect = d.board.getBoundingClientRect();
    const inside = d.x >= boardRect.left - 16 && d.x <= boardRect.right + 16 &&
      d.y >= boardRect.top - 20 && d.y <= boardRect.bottom + 20;
    if (!inside) {
      d.targetN = null;
      d.clone.classList.remove('is-magnetized');
      announce('в пределах этого дня · Esc — отмена');
      return false;
    }
    // Layout coordinates exclude FLIP transforms, so an animating neighbour cannot flicker the target.
    const row = [...d.board.children].find(row => {
      const top = boardRect.top + row.offsetTop;
      return d.y >= top - 4 && d.y <= top + row.offsetHeight + 4;
    });
    if (!row) {
      d.targetN = null;
      d.clone.classList.remove('is-magnetized');
      return false;
    }
    const targetN = Number(row.dataset.dropN);
    d.targetN = targetN;
    applyOrder(targetN);
    if (!d.clone.classList.contains('is-magnetized')) {
      d.clone.classList.add('is-magnetized');
      void d.clone.offsetWidth;
    }
    centerCloneOnPlaceholder();
    announce(targetN === d.fromN ? 'исходное место · Esc — отмена' : `отпусти на ${targetN}-ю пару · Esc — отмена`);
    return true;
  };
  const animate = () => {
    if (!drag) return;
    const d = drag;
    if (!d.scope.isConnected) { finish(false); return; }
    const viewport = d.scroller === document.scrollingElement ? { top: 0, bottom: innerHeight } : d.scroller.getBoundingClientRect();
    const edge = 64;
    const speed = !d.moved ? 0 : d.y < viewport.top + edge ? -Math.min(13, (viewport.top + edge - d.y) / 5)
      : d.y > viewport.bottom - edge ? Math.min(13, (d.y - viewport.bottom + edge) / 5) : 0;
    if (speed) {
      d.scroller.scrollTop += speed;
      if (!updateTarget()) followPointer();
    }
    frame = requestAnimationFrame(animate);
  };
  const start = () => {
    if (!pending?.row.isConnected) { clearPending(); removeListeners(); return; }
    const p = pending;
    clearPending();
    const scope = p.row.closest('.sched-day-block[data-day]');
    if (!scope) return;
    const slots = slotsForDate(p.date).slice().sort((a, b) => a.n - b.n);
    if (!slots.some(slot => slot.n === p.n && !slot.window && !slot.cancelled)) return;
    const rect = p.row.getBoundingClientRect(), scroller = scrollerFor(scope);
    const clone = p.row.cloneNode(true);
    clone.classList.add('is-drag-float');
    clone.removeAttribute('id'); clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    clone.setAttribute('aria-hidden', 'true'); clone.inert = true;
    Object.assign(clone.style, { width: rect.width + 'px', height: rect.height + 'px', left: rect.left + 'px', top: rect.top + 'px' });
    document.body.appendChild(clone);
    const status = document.createElement('div');
    status.className = 'sched-drag-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    status.textContent = 'перетащи пару · Esc — отмена'; document.body.appendChild(status);
    const original = [...scope.children].filter(el => !el.classList.contains('sched-day-heading'));
    const hidden = original.map(el => [el, el.hidden]);
    const board = document.createElement('div'); board.className = 'agenda-list sched-drag-board';
    const items = new Map();
    slots.forEach(slot => {
      const temp = document.createElement('div');
      temp.innerHTML = renderRow({ ...slot, window: Boolean(slot.window || slot.cancelled) }, p.date);
      const row = temp.firstElementChild;
      row.dataset.dragOrigin = slot.n; row.dataset.dropN = slot.n;
      row.removeAttribute('tabindex'); row.removeAttribute('role'); row.inert = true;
      if (slot.window || slot.cancelled) row.classList.add('is-drag-ghost');
      if (slot.n === p.n) { row.classList.add('is-drag-src'); row.style.minHeight = rect.height + 'px'; }
      board.appendChild(row); items.set(slot.n, row);
    });
    drag = { ...p, fromN: p.n, scope, slots, clone, status, board, items, hidden, scroller, originalScroll: scroller.scrollTop,
      oldScrollBehavior: scroller.style.scrollBehavior, grabX: p.x - rect.left, grabY: p.y - rect.top,
      x: p.x, y: p.y, moved: false, previewN: p.n, targetN: null };
    onActiveChange(true);
    scroller.style.scrollBehavior = 'auto';
    document.body.classList.add('is-dragging-pair'); scope.classList.add('is-pair-dragging');
    hidden.forEach(([el]) => { el.hidden = true; el.classList.add('sched-drag-original'); });
    scope.appendChild(board);
    // Reveal windows above the source without moving the grabbed card under the finger.
    const delta = items.get(p.n).getBoundingClientRect().top - rect.top;
    scroller.scrollTop += delta;
    const residual = items.get(p.n).getBoundingClientRect().top - rect.top;
    if (residual < -1) board.style.marginTop = -residual + 'px';
    if (residual > 1) {
      const spacer = document.createElement('div');
      spacer.className = 'sched-drag-scroll-space'; spacer.setAttribute('aria-hidden', 'true');
      spacer.style.cssText = `height:${innerHeight + residual}px;min-height:${innerHeight + residual}px;flex:none;pointer-events:none`;
      (scroller === document.scrollingElement ? document.body : scroller).appendChild(spacer);
      drag.scrollSpacer = spacer;
      scroller.scrollTop += items.get(p.n).getBoundingClientRect().top - rect.top;
    }
    /* The drag board can be wider or shift after windows are revealed. Recenter
       the scaled card against the actual dashed source placeholder, not the old row. */
    centerCloneOnPlaceholder();
    if (!p.touchBody) { try { scene.setPointerCapture(p.pointerId); } catch (_) {} }
    try { navigator.vibrate?.(10); } catch (_) {}
    frame = requestAnimationFrame(animate);
  };
  const finish = commit => {
    clearPending(); removeListeners(); cancelAnimationFrame(frame); frame = null;
    if (!drag) return;
    const d = drag;
    if (commit && d.moved) updateTarget();
    const target = d.targetN;
    drag = null;
    try { if (scene.hasPointerCapture(d.pointerId)) scene.releasePointerCapture(d.pointerId); } catch (_) {}
    d.clone.remove(); d.status.remove(); d.board.remove(); d.scrollSpacer?.remove();
    d.hidden.forEach(([el, hidden]) => { el.hidden = hidden; el.classList.remove('sched-drag-original'); });
    d.scope.classList.remove('is-pair-dragging'); document.body.classList.remove('is-dragging-pair');
    d.scroller.scrollTop = d.originalScroll;
    d.scroller.style.scrollBehavior = d.oldScrollBehavior;
    suppressUntil = Date.now() + 450;
    onActiveChange(false);
    if (commit && d.moved && target !== null && target !== d.fromN) {
      const to = d.slots.find(slot => slot.n === target);
      if (to.window || to.cancelled) onSwap(d.date, d.fromN, target);
      else onReorder(d.date, d.fromN, target);
    }
    onFinish?.();
  };
  const move = (x, y, event) => {
    if (drag) {
      event?.preventDefault();
      const d = drag;
      d.moved ||= Math.hypot(x - d.x, y - d.y) > 3;
      d.x = x; d.y = y;
      if (!updateTarget()) followPointer();
    } else if (pending && Math.hypot(x - pending.x, y - pending.y) > 7) {
      if (pending.handle) { start(); if (drag) move(x, y, event); }
      else { clearPending(); removeListeners(); } // A swipe on the card scrolls normally before the hold.
    }
  };
  const onMove = e => { if ((drag || pending)?.pointerId === e.pointerId) move(e.clientX, e.clientY, e); };
  const onUp = e => { if ((drag || pending)?.pointerId === e.pointerId) { if (drag) e.preventDefault(); finish(true); } };
  const onCancel = e => { if ((drag || pending)?.pointerId === e.pointerId) finish(false); };
  const onTouchMove = e => {
    const active = drag || pending, touch = [...e.touches].find(t => t.identifier === active?.pointerId);
    if (e.touches.length > 1) { finish(false); return; }
    if (touch) move(touch.clientX, touch.clientY, e);
  };
  const onTouchEnd = e => { if ([...e.changedTouches].some(t => t.identifier === (drag || pending)?.pointerId)) { if (drag) e.preventDefault(); finish(true); } };
  const onTouchCancel = () => finish(false);
  const sourceFor = target => {
    if (document.documentElement.dataset.editorMode !== 'true') return null;
    const row = target.closest('.agenda-row[data-row-n], .live-lesson-card[data-row-n]');
    if (!row || row.classList.contains('is-cancelled')) return null;
    const handle = target.closest('.lesson-swap-btn[data-act="swap"]');
    if (!handle && target.closest('button, a, input, textarea, select')) return null;
    const button = row.querySelector('.lesson-swap-btn[data-act="swap"]');
    return button ? { row, handle: Boolean(handle), date: button.dataset.date, n: Number(button.dataset.n) } : null;
  };
  scene.addEventListener('pointerdown', e => {
    if (!e.isPrimary || e.button !== 0 || drag) return;
    const source = sourceFor(e.target);
    if (!source || (e.pointerType === 'touch' && !source.handle)) return;
    pending = { ...source, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    timer = setTimeout(start, source.handle ? 220 : 320);
    document.addEventListener('pointermove', onMove, { capture: true, passive: false });
    document.addEventListener('pointerup', onUp, true); document.addEventListener('pointercancel', onCancel, true);
  });
  scene.addEventListener('touchstart', e => {
    if (drag || pending || e.touches.length !== 1) return;
    const source = sourceFor(e.target); if (!source || source.handle) return;
    const touch = e.touches[0];
    pending = { ...source, touchBody: true, x: touch.clientX, y: touch.clientY, pointerId: touch.identifier };
    timer = setTimeout(start, 320);
    document.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    document.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
    document.addEventListener('touchcancel', onTouchCancel, true);
  }, { passive: true });
  scene.addEventListener('click', e => { if (Date.now() < suppressUntil) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  scene.addEventListener('contextmenu', e => { if (drag || pending || e.target.closest('.lesson-swap-btn')) e.preventDefault(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && (drag || pending)) { e.preventDefault(); finish(false); } });
  window.addEventListener('blur', () => finish(false));
  window.addEventListener('resize', () => finish(false));
  document.addEventListener('visibilitychange', () => { if (document.hidden) finish(false); });
  return { cancel: () => finish(false) };
}
