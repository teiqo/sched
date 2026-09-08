/* Pure movement plans: bell times/slot numbers never travel with lesson content. */
export function packLesson(slot) {
  return {
    subject: slot.subject || "", teacher: slot.teacher || "", room: slot.room || "",
    self: Boolean(slot.self),
  };
}

function movedLesson(slot) {
  return { ...packLesson(slot), moved: true, movedFrom: slot.movedFrom || slot.n };
}

export function planPairSwap(slots, fromN, toN) {
  const from = slots.find(slot => slot.n === fromN);
  const to = slots.find(slot => slot.n === toN);
  if (fromN === toN || !from || !to || from.window || from.cancelled) return {};
  return {
    [fromN]: to.window || to.cancelled ? { makeWindow: true, self: false, moved: true } : movedLesson(to),
    [toN]: movedLesson(from),
  };
}

export function planPairInsert(slots, fromN, toN, after = false) {
  const pairs = slots.filter(slot => !slot.window && !slot.cancelled).sort((a, b) => a.n - b.n);
  const fromIndex = pairs.findIndex(slot => slot.n === fromN);
  const targetIndex = pairs.findIndex(slot => slot.n === toN);
  if (fromIndex < 0 || targetIndex < 0 || fromN === toN) return {};
  const ordered = pairs.slice();
  const [moved] = ordered.splice(fromIndex, 1);
  const insertAt = ordered.findIndex(slot => slot.n === toN) + (after ? 1 : 0);
  ordered.splice(insertAt, 0, moved);
  const changes = {};
  pairs.forEach((slot, index) => {
    if (slot !== ordered[index]) changes[slot.n] = movedLesson(ordered[index]);
  });
  return changes;
}
