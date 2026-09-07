/* ---------- конфиг weeqo ----------
   Значения в репозитории НЕ хранятся. Их подставляет GitHub Action при деплое
   из окружения репозитория (Settings → Environments → github-pages):

     Environment variables:  SHARED_SWAPS_URL, TELEGRAM_BOT_NAME, TELEGRAM_BOT_ID,
                               TELEGRAM_OWNER_ID, TELEGRAM_ADMIN_IDS
                               (айдишники телеграма: владелец — один, редакторы — через запятую)
                               (TELEGRAM_BOT_ID — Client ID из @BotFather → Bot Settings →
                                Web Login; там же домен сайта добавляется в Allowed URLs)
     Environment secrets:    FIREBASE_API_KEY, TELEGRAM_BOT_TOKEN_SHA256

   Для локальной проверки можно временно вписать значения сюда —
   только не коммить их. */

var SHARED_SWAPS_URL = "";
var FIREBASE_API_KEY = "";
var TELEGRAM_BOT_NAME = "";
var TELEGRAM_BOT_ID = "";
var TELEGRAM_BOT_TOKEN_SHA256 = "";
var TELEGRAM_OWNER_ID = "";
var TELEGRAM_ADMIN_IDS = "";
