/* Display preferences never remove lessons from the source or movement plans. */
export function isVacancy(slot) {
  return String(slot?.teacher || "").trim().toLocaleLowerCase("ru") === "вакансия";
}

export function lessonType(slot) {
  if (isVacancy(slot)) return "vacancy";
  return slot?.self ? "self" : "lesson";
}

export function isSlotVisible(slot, preferences) {
  if (slot.cancelled) return false;
  if (slot.window) return Boolean(preferences.windows);
  if (isVacancy(slot) && !preferences.showVacancies) return false;
  if (slot.self && preferences.showSelfStudy === false) return false;
  return true;
}