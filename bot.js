const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '379009688';
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const DATA_FILE = path.join(DATA_DIR, 'stats.json');
const TZ = 'Europe/Moscow';

if (!TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN не задан'); process.exit(1); }
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── EXERCISES ───────────────────────────────────────────────────────────────
const EXERCISES = [
  { name: '🦵 Приседания', reps: '10 раз', emoji: '🦵' },
  { name: '💪 Гантели', reps: '20 раз каждой рукой', emoji: '💪' },
];

function randomExercise() {
  return EXERCISES[Math.floor(Math.random() * EXERCISES.length)];
}

// ─── DATA ────────────────────────────────────────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) { console.error('Ошибка чтения данных:', e); }
  return {
    today: { date: '', done: 0, missed: 0, paused: false, slots: [] },
    streak: { current: 0, best: 0 },        // стрик дней подряд (все выполнены)
    inRowStreak: 0,                           // стрик подряд в рамках сессии
    weekStats: {},                            // { 'YYYY-WW': { done, missed, total } }
    lastMsgId: null,                          // id последнего напоминания
    currentExercise: null,
  };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function todayKey() {
  return new Date().toLocaleDateString('ru-RU', { timeZone: TZ });
}

function weekKey() {
  const now = new Date();
  const jan1 = new Date(now.getFullYear(), 0, 1);
  const week = Math.ceil(((now - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${now.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function ensureToday(data) {
  const key = todayKey();
  if (data.today.date !== key) {
    // Новый день — финализируем предыдущий в недельную стату
    if (data.today.date) {
      const wk = weekKey();
      if (!data.weekStats[wk]) data.weekStats[wk] = { done: 0, missed: 0, total: 0 };
      data.weekStats[wk].done += data.today.done;
      data.weekStats[wk].missed += data.today.missed;
      data.weekStats[wk].total += data.today.done + data.today.missed;

      // Стрик по дням: если вчера хоть что-то выполнено — стрик продолжается
      if (data.today.done > 0) {
        data.streak.current += 1;
        data.streak.best = Math.max(data.streak.best, data.streak.current);
      } else {
        data.streak.current = 0;
      }
    }
    data.today = { date: key, done: 0, missed: 0, paused: false, slots: [] };
    data.inRowStreak = 0;
  }
  return data;
}

// ─── BOT ─────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });

// ─── SEND REMINDER ───────────────────────────────────────────────────────────
async function sendReminder() {
  let data = loadData();
  data = ensureToday(data);

  if (data.today.paused) {
    console.log('⏸ Сегодня пауза, напоминание пропускается');
    saveData(data);
    return;
  }

  const ex = randomExercise();
  data.currentExercise = ex;

  const hour = new Date().toLocaleTimeString('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const streakLine = data.inRowStreak > 0
    ? `🔥 Стрик: ${data.inRowStreak} подряд`
    : '💤 Стрик сброшен — начнём заново!';

  const text =
    `⏰ *${hour} — Время размяться!*\n\n` +
    `${ex.emoji} *${ex.name}*\n` +
    `📊 ${ex.reps}\n\n` +
    `${streakLine}\n` +
    `Сегодня: ✅ ${data.today.done} | ❌ ${data.today.missed}`;

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Сделал!', callback_data: 'done' },
      { text: '❌ Не сделал', callback_data: 'missed' },
      { text: '⏸ Пауза', callback_data: 'pause' },
    ]]
  };

  try {
    // Удаляем предыдущее сообщение с кнопками (чтобы не мусорить)
    if (data.lastMsgId) {
      await bot.deleteMessage(CHAT_ID, data.lastMsgId).catch(() => {});
    }
    const msg = await bot.sendMessage(CHAT_ID, text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
    data.lastMsgId = msg.message_id;
    data.today.slots.push({ hour, status: 'pending' });
    saveData(data);
  } catch (e) {
    console.error('Ошибка отправки напоминания:', e.message);
  }
}

// ─── SEND DAILY SUMMARY ──────────────────────────────────────────────────────
async function sendDailySummary() {
  let data = loadData();
  data = ensureToday(data);

  const total = data.today.done + data.today.missed;
  const percent = total > 0 ? Math.round((data.today.done / total) * 100) : 0;

  let medal = '😴';
  if (percent === 100) medal = '🏆';
  else if (percent >= 70) medal = '💪';
  else if (percent >= 40) medal = '👍';

  const streakDays = data.streak.current;
  const streakBest = data.streak.best;

  const text =
    `${medal} *Итог дня — ${data.today.date}*\n\n` +
    `✅ Выполнено: *${data.today.done}* из *${total}*\n` +
    `❌ Пропущено: *${data.today.missed}*\n` +
    `📊 Процент: *${percent}%*\n\n` +
    `🔥 Стрик дней подряд: *${streakDays}*\n` +
    `🏅 Рекорд: *${streakBest}* дней\n\n` +
    (percent === 100 ? '🎯 Отличный день — все упражнения выполнены!' :
      percent >= 70 ? '👏 Хороший результат! Завтра — ещё лучше.' :
      '💡 Завтра попробуем сделать больше.');

  await bot.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown' }).catch(e => {
    console.error('Ошибка отправки итога дня:', e.message);
  });
}

// ─── SEND WEEKLY DIGEST ──────────────────────────────────────────────────────
async function sendWeeklyDigest() {
  let data = loadData();
  const wk = weekKey();
  const ws = data.weekStats[wk] || { done: 0, missed: 0, total: 0 };

  const percent = ws.total > 0 ? Math.round((ws.done / ws.total) * 100) : 0;

  const text =
    `📅 *Итог недели ${wk}*\n\n` +
    `✅ Выполнено: *${ws.done}* упражнений\n` +
    `❌ Пропущено: *${ws.missed}*\n` +
    `📊 Процент выполнения: *${percent}%*\n` +
    `🔥 Текущий стрик дней: *${data.streak.current}*\n` +
    `🏅 Рекорд: *${data.streak.best}* дней\n\n` +
    (percent >= 80 ? '🏆 Продуктивная неделя! Так держать.' :
      percent >= 50 ? '💪 Неплохо, но есть куда расти.' :
      '📈 Следующая неделя будет лучше. Не останавливайся!');

  await bot.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown' }).catch(e => {
    console.error('Ошибка отправки дайджеста:', e.message);
  });
}

// ─── CALLBACKS ───────────────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  if (String(query.message.chat.id) !== String(CHAT_ID)) return;

  let data = loadData();
  data = ensureToday(data);
  const action = query.data;

  if (action === 'done') {
    data.today.done += 1;
    data.inRowStreak += 1;

    const fireEmoji = data.inRowStreak >= 5 ? '🔥🔥🔥' : data.inRowStreak >= 3 ? '🔥🔥' : '🔥';
    const text = `✅ *Отлично!* ${data.currentExercise?.name || ''}\n\n${fireEmoji} Стрик: *${data.inRowStreak} подряд*\nСегодня выполнено: *${data.today.done}*`;
    await bot.editMessageText(text, {
      chat_id: CHAT_ID,
      message_id: query.message.message_id,
      parse_mode: 'Markdown',
    }).catch(() => {});

  } else if (action === 'missed') {
    data.today.missed += 1;
    data.inRowStreak = 0;

    const text = `❌ Записал. Стрик сброшен.\nСегодня: ✅ ${data.today.done} | ❌ ${data.today.missed}\n\nВ следующий раз — обязательно! 💪`;
    await bot.editMessageText(text, {
      chat_id: CHAT_ID,
      message_id: query.message.message_id,
      parse_mode: 'Markdown',
    }).catch(() => {});

  } else if (action === 'pause') {
    data.today.paused = true;

    const text = `⏸ *Пауза на сегодня.*\nОстальные напоминания отменены.\nСтрик дней не пострадает — просто пропуск.\n\nОтдыхай, завтра продолжим! 🙌`;
    await bot.editMessageText(text, {
      chat_id: CHAT_ID,
      message_id: query.message.message_id,
      parse_mode: 'Markdown',
    }).catch(() => {});
  }

  data.lastMsgId = null; // после ответа кнопки убираем ref
  saveData(data);
  await bot.answerCallbackQuery(query.id).catch(() => {});
});

// ─── COMMANDS ────────────────────────────────────────────────────────────────
bot.onText(/\/today/, async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  let data = loadData();
  data = ensureToday(data);
  const total = data.today.done + data.today.missed;
  const percent = total > 0 ? Math.round((data.today.done / total) * 100) : 0;
  const text =
    `📊 *Сегодня, ${data.today.date}*\n\n` +
    `✅ Выполнено: *${data.today.done}* из *${total}*\n` +
    `❌ Пропущено: *${data.today.missed}*\n` +
    `📈 Процент: *${percent}%*\n` +
    `🔥 Стрик подряд сегодня: *${data.inRowStreak}*\n` +
    `📅 Стрик дней подряд: *${data.streak.current}*\n` +
    (data.today.paused ? '\n⏸ Сегодня пауза' : '');
  await bot.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/stats/, async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  let data = loadData();
  data = ensureToday(data);
  const wk = weekKey();
  const ws = data.weekStats[wk] || { done: 0, missed: 0, total: 0 };
  const percent = ws.total > 0 ? Math.round((ws.done / ws.total) * 100) : 0;
  const text =
    `📈 *Общая статистика*\n\n` +
    `🔥 Стрик дней: *${data.streak.current}*\n` +
    `🏅 Рекорд: *${data.streak.best}* дней\n\n` +
    `*Эта неделя:*\n` +
    `✅ ${ws.done} выполнено | ❌ ${ws.missed} пропущено\n` +
    `📊 ${percent}% выполнения`;
  await bot.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/pause/, async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  let data = loadData();
  data = ensureToday(data);
  data.today.paused = !data.today.paused;
  saveData(data);
  const text = data.today.paused
    ? '⏸ Пауза включена. Напоминания сегодня не придут.'
    : '▶️ Пауза снята. Напоминания возобновлены.';
  await bot.sendMessage(CHAT_ID, text);
});

bot.onText(/\/start/, async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  const text =
    `👋 *Fitness Bot запущен!*\n\n` +
    `Буду напоминать каждый час с 9:00 до 18:00 (МСК).\n\n` +
    `*Команды:*\n` +
    `/today — статистика за сегодня\n` +
    `/stats — общая статистика и стрики\n` +
    `/pause — включить/выключить паузу на сегодня\n\n` +
    `*Упражнения:*\n` +
    `🦵 Приседания × 10\n` +
    `💪 Гантели × 20 каждой рукой\n\n` +
    `Погнали! 💪`;
  await bot.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown' });
});

// ─── CRON SCHEDULE (Moscow = UTC+3) ─────────────────────────────────────────
// node-cron использует серверное время — Railway работает в UTC
// Поэтому 9:00 МСК = 6:00 UTC, 18:00 МСК = 15:00 UTC, 21:00 МСК = 18:00 UTC

// Каждый час с 9:00 до 18:00 МСК (6:00–15:00 UTC)
cron.schedule('0 6,7,8,9,10,11,12,13,14,15 * * 1-5', sendReminder, {
  timezone: 'UTC',
});

// Итог дня в 18:00 МСК (15:00 UTC)
cron.schedule('5 15 * * 1-5', sendDailySummary, {
  timezone: 'UTC',
});

// Дневная сводка в 21:00 МСК (18:00 UTC)
cron.schedule('0 18 * * 1-5', sendDailySummary, {
  timezone: 'UTC',
});

// Еженедельный дайджест — воскресенье 20:00 МСК (17:00 UTC)
cron.schedule('0 17 * * 0', sendWeeklyDigest, {
  timezone: 'UTC',
});

// ─── START ───────────────────────────────────────────────────────────────────
console.log('✅ Fitness Bot запущен');
console.log(`📅 Напоминания: пн–пт, 9:00–18:00 МСК`);
console.log(`📊 Итог дня: 21:00 МСК | Дайджест: воскресенье 20:00 МСК`);
console.log(`👤 CHAT_ID: ${CHAT_ID}`);

// Проверка — сразу написать в чат при запуске
bot.sendMessage(CHAT_ID,
  `🤖 Fitness Bot запущен!\n` +
  `Напоминания: пн–пт, каждый час с 9:00 до 18:00 МСК.\n` +
  `Используй /start для справки.`
).catch(e => console.error('Ошибка стартового сообщения:', e.message));
