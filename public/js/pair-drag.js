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
    /* Временная сетка неподвижна: не переставляем DOM-строки и не меняем
       номера/время во время движения. Двигается только плавающая пара,
       а целевой временной слот подсвечивается. */
    d.items.forEach((row, n) => {
      row.getAnimations().forEach(a => a.cancel());
      row.classList.toggle('is-drop-target', n === targetN && targetN !== d.fromN);
    });
  };
  const CLONE_EDGE = 8;
  const cloneWidth = width => Math.min(width, Math.max(160, innerWidth - CLONE_EDGE * 2));
  const clampLeft = (left, width) => {
    const max = Math.max(CLONE_EDGE, innerWidth - width - CLONE_EDGE);
    return Math.min(Math.max(left, CLONE_EDGE), max);
  };
  const followPointer = () => {
    const d = drag;
    if (!d) return;
    d.clone.classList.remove('is-magnetized');
    d.clone.style.left = clampLeft(d.x - d.grabX, d.clone.offsetWidth) + 'px';
    d.clone.style.top = d.y - d.grabY + 'px';
  };
  const centerCloneOnPlaceholder = () => {
    const d = drag, placeholder = d?.items.get(d.targetN ?? d.fromN);
    if (!placeholder?.isConnected) return;
    const targetRect = placeholder.getBoundingClientRect();
    d.clone.style.left = clampLeft(targetRect.left + (targetRect.width - d.clone.offsetWidth) / 2, d.clone.offsetWidth) + 'px';
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
      d.previewN = null;
      d.items.forEach(row => row.classList.remove('is-drop-target'));
      d.clone.classList.remove('is-magnetized');
      announce('в пределах этого дня');
      return false;
    }
    // Layout coordinates exclude FLIP transforms, so an animating neighbour cannot flicker the target.
    const row = [...d.board.children].filter(row => row.dataset.dropN).find(row => {
      const top = boardRect.top + row.offsetTop;
      return d.y >= top - 4 && d.y <= top + row.offsetHeight + 4;
    });
    if (!row) {
      d.targetN = null;
      d.previewN = null;
      d.items.forEach(item => item.classList.remove('is-drop-target'));
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
    announce(targetN === d.fromN ? 'исходное место' : `отпусти на ${targetN}-ю пару`);
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
    const list = p.row.closest('.agenda-list');
    /* Большая карточка «сейчас/далее» остаётся живой и редактируется тапом,
       но не заменяется доской. Перетаскиваем только пары внутри того списка,
       который пользователь действительно видит. */
    if (!scope || !list) return;
    const allSlots = slotsForDate(p.date).slice().sort((a, b) => a.n - b.n);
    const realElements = new Map();
    list.querySelectorAll('.agenda-row[data-row-n]').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width && r.height) realElements.set(Number(el.dataset.rowN), el);
    });
    const slots = allSlots.filter(slot => realElements.has(slot.n));
    if (!slots.some(slot => slot.n === p.n && !slot.window && !slot.cancelled)) return;
    const rect = p.row.getBoundingClientRect(), scroller = scrollerFor(scope);
    /* Геометрию снимаем до скрытия оригиналов: доска должна повторить высоты
       реальных строк и живой карточки «сейчас/далее», а высота самого дня
       обязана остаться прежней. Иначе на телефоне при зажатии день сжимается
       и всё ниже (перерывы, следующие пары) уезжает под пальцем. */
    const scopeRect = scope.getBoundingClientRect();
    const realRects = new Map();
    realElements.forEach((el, n) => {
      const r = el.getBoundingClientRect();
      realRects.set(n, { top: r.top, height: r.height });
    });
    /* Чипы перерывов переносим в доску такими же: раньше на зажатие они просто
       исчезали, и текст «перерыв · N мин» ломался. */
    const realBreaks = new Map();
    list.querySelectorAll('.agenda-row[data-row-n]').forEach(el => {
      const next = el.nextElementSibling;
      if (next && next.classList.contains('agenda-break')) realBreaks.set(Number(el.dataset.rowN), next);
    });
    const clone = p.row.cloneNode(true);
    clone.classList.add('is-drag-float');
    clone.removeAttribute('id'); clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    clone.setAttribute('aria-hidden', 'true'); clone.inert = true;
    const cloneW = cloneWidth(rect.width);
    Object.assign(clone.style, { width: cloneW + 'px', height: rect.height + 'px', left: clampLeft(rect.left, cloneW) + 'px', top: rect.top + 'px' });
    document.body.appendChild(clone);
    const status = document.createElement('div');
    status.className = 'sched-drag-status is-sr-only'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    status.textContent = 'перетащи пару'; document.body.appendChild(status);
    const hidden = [[list, list.hidden]];
    const board = document.createElement('div'); board.className = 'agenda-list sched-drag-board';
    const items = new Map();
    slots.forEach(slot => {
      const source = realElements.get(slot.n);
      const temp = document.createElement('div');
      if (!source) {
        temp.innerHTML = renderRow({
          ...slot,
          window: Boolean(slot.window || slot.cancelled),
          cancelled: false,
          swapped: slot.cancelled ? false : slot.swapped,
        }, p.date);
      }
      /* Клонируем именно видимую строку: время, переносы текста и метки
         остаются теми же, что были за мгновение до удержания. */
      const row = source ? source.cloneNode(true) : temp.firstElementChild;
      row.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
      if (slot.cancelled) row.classList.remove('is-cancelled');
      row.dataset.dragOrigin = slot.n; row.dataset.dropN = slot.n;
      row.removeAttribute('tabindex'); row.removeAttribute('role'); row.inert = true;
      if (slot.window || slot.cancelled) row.classList.add('is-drag-ghost');
      const real = realRects.get(slot.n);
      if (real) { row.style.height = real.height + 'px'; row.style.minHeight = real.height + 'px'; }
      if (slot.n === p.n) { row.classList.add('is-drag-src'); row.style.minHeight = rect.height + 'px'; }
      board.appendChild(row); items.set(slot.n, row);
    });
    /* Повторяем исходные отступы между парами (чипы перерывов занимают место),
       чтобы во время удержания ни одна строка не сдвинулась ни на пиксель. */
    board.style.gap = '0px';
    const spacers = [];
    for (let i = 0; i < slots.length - 1; i += 1) {
      const row = items.get(slots[i].n);
      if (!row) { spacers.push(null); continue; }
      row.style.marginBottom = '0px';
      const cur = realRects.get(slots[i].n), nxt = realRects.get(slots[i + 1].n);
      const space = cur && nxt ? Math.max(0, nxt.top - (cur.top + cur.height)) : 0;
      const brk = realBreaks.get(slots[i].n);
      let spacer = null;
      if (brk && space > 2) {
        spacer = brk.cloneNode(true);
        spacer.classList.add('is-drag-break');
        spacer.style.margin = '0px';
        spacer.style.height = space + 'px';
        spacer.style.minHeight = space + 'px';
        spacer.style.flex = 'none';
      } else if (space > 0) {
        spacer = document.createElement('div');
        spacer.className = 'sched-drag-gap';
        spacer.style.height = space + 'px';
      }
      spacers.push(spacer);
    }
    const initial = document.createDocumentFragment();
    slots.forEach((slot, i) => {
      initial.appendChild(items.get(slot.n));
      if (spacers[i]) initial.appendChild(spacers[i]);
    });
    board.replaceChildren(initial);
    drag = { ...p, fromN: p.n, scope, list, slots, clone, status, board, items, spacers, hidden, scroller, originalScroll: scroller.scrollTop,
      scopeMinHeight: scope.style.minHeight,
      oldScrollBehavior: scroller.style.scrollBehavior, grabX: p.x - rect.left, grabY: p.y - rect.top,
      x: p.x, y: p.y, moved: false, previewN: p.n, targetN: null };
    onActiveChange(true);
    scroller.style.scrollBehavior = 'auto';
    document.body.classList.add('is-dragging-pair'); scope.classList.add('is-pair-dragging');
    hidden.forEach(([el]) => { el.hidden = true; el.classList.add('sched-drag-original'); });
    scope.style.minHeight = scopeRect.height + 'px';
    list.insertAdjacentElement('afterend', board);
    /* Доска обязана начаться там же, где начинался список пар. */
    const firstSlot = slots.find(slot => realRects.has(slot.n));
    const firstItem = firstSlot ? items.get(firstSlot.n) : null;
    if (firstItem) {
      const shift = realRects.get(firstSlot.n).top - firstItem.getBoundingClientRect().top;
      if (Math.abs(shift) > 0.5) board.style.marginTop = shift + 'px';
    }
    /* Ничего не скроллим и не сдвигаем страницу: окна раскрываются на месте,
       а сама карточка под пальцем остаётся точно там, где её взяли. */
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
    d.clone.remove(); d.status.remove(); d.board.remove();
    d.hidden.forEach(([el, hidden]) => { el.hidden = hidden; el.classList.remove('sched-drag-original'); });
    d.scope.style.minHeight = d.scopeMinHeight || '';
    d.scope.classList.remove('is-pair-dragging'); document.body.classList.remove('is-dragging-pair');
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
    /* Большая живая карточка редактируется обычным тапом по кнопке. Не ставим
       на неё таймер перетаскивания — сама карточка и отсчёт должны жить дальше. */
    if (row.classList.contains('live-lesson-card')) return null;
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
  document.addEventListener('click', e => {
    if (drag || pending || Date.now() < suppressUntil) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  scene.addEventListener('contextmenu', e => { if (drag || pending || e.target.closest('.lesson-swap-btn')) e.preventDefault(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && (drag || pending)) { e.preventDefault(); finish(false); } });
  window.addEventListener('blur', () => finish(false));
  let lastWidth = innerWidth;
  window.addEventListener('resize', () => {
    /* Клавиатура и адресная строка меняют только высоту — из-за этого
       перенос срывался прямо во время удержания пары. */
    if (innerWidth === lastWidth) return;
    lastWidth = innerWidth;
    finish(false);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) finish(false); });
  return { cancel: () => finish(false) };
}
