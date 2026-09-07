/* ---------------------------------------------------------------------------
   weeqo: ручной конфиг — страховка на случай, если Actions не подставил
   значения в js/config.js (не тот фолдер workflow, секрет не создан и т.п.).

   Заполняет ТОЛЬКО пустые значения: если config.js уже пришёл с данными,
   этот файл ничего не меняет. Никакой workflow его не перезаписывает.

   Про безопасность: Firebase Web API key — НЕ секрет. По задумке Google он
   всегда виден в коде любого веб-приложения; данные защищают правила базы,
   а не сокрытие ключа. А вот токен бота сюда НИКОГДА не вставляй — он секретный.
   --------------------------------------------------------------------------- */

/* Web API key: Firebase Console → ⚙️ Project settings → General → Web API key.
   Проверь, что совпадает посимвольно — копируй, не набирай руками. */
if (!window.FIREBASE_API_KEY)
  window.FIREBASE_API_KEY = "AIzaSyBXLCEbC3fsHNnaHg0TJaNIiWVHpsCycb0";

/* Адрес базы (Realtime Database → ссылка вверху, без слеша на конце). */
if (!window.SHARED_SWAPS_URL)
  window.SHARED_SWAPS_URL = "https://weeqo-8c533-default-rtdb.firebaseio.com";

/* Telegram: имя бота без @, его числовой id (цифры до двоеточия в токене). */
if (!window.TELEGRAM_BOT_NAME) window.TELEGRAM_BOT_NAME = "weeqobot";
if (!window.TELEGRAM_BOT_ID) window.TELEGRAM_BOT_ID = "";

/* Твой Telegram id — владелец расписания. */
if (!window.TELEGRAM_OWNER_ID) window.TELEGRAM_OWNER_ID = "5142202213";
if (!window.TELEGRAM_ADMIN_IDS) window.TELEGRAM_ADMIN_IDS = "";
