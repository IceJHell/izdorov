const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const fs   = require('fs');
const path = require('path');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID  = process.env.TELEGRAM_CHAT_ID || '379009688';
const DATA_DIR  = process.env.DATA_DIR || '/app/data';
const DATA_FILE = path.join(DATA_DIR, 'stats.json');
const TZ = 'Europe/Moscow';

if (!TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN не задан'); process.exit(1); }
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── УПРАЖНЕНИЯ ───────────────────────────────────────────────────────────────
const SQUATS_REPS    = 10;  // приседания за подход
const DUMBBELLS_REPS = 40;  // гантели за подход (20 × 2 руки)

const MOTIVATIONS = [
  'Огонь! 🔥', 'Красавчик! 💪', 'Так держать!', 'Зачтено! 🎯',
  'Машина! 🤖', 'Жги! 🚀', 'Молодец!', 'Лучший! 🏆',
];
function randomMotivation() {
  return MOTIVATIONS[Math.floor(Math.random() * MOTIVATIONS.length)];
}

// ─── ДАННЫЕ ───────────────────────────────────────────────────────────────────
function emptyDay(date) {
  return { date: date || '', done: 0, missed: 0, paused: false, squats: 0, dumbbells: 0 };
}

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { console.error('Ошибка чтения данных:', e); }
  return {
    today:       emptyDay(),
    streak:      { current: 0, best: 0 },
    inRowStreak: 0,
    weekStats:   {},
    monthStats:  {},
    allTime:     { squats: 0, dumbbells: 0, done: 0 },
    lastMsgId:   null,
  };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function todayKey() {
  return new Date().toLocaleDateString('ru-RU', { timeZone: TZ });
}
function weekKey() {
  const now  = new Date();
  const jan1 = new Date(now.getFullYear(), 0, 1);
  const week = Math.ceil(((now - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${now.getFullYear()}-W${String(week).padStart(2, '0')}`;
}
function monthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function archiveDay(data) {
  const prev = data.today;
  if (!prev.date) return;

  const wk = weekKey();
  if (!data.weekStats[wk]) data.weekStats[wk] = { done: 0, missed: 0, squats: 0, dumbbells: 0 };
  data.weekStats[wk].done      += prev.done;
  data.weekStats[wk].missed    += prev.missed;
  data.weekStats[wk].squats    += prev.squats;
  data.weekStats[wk].dumbbells += prev.dumbbells;

  const mk = monthKey();
  if (!data.monthStats[mk]) data.monthStats[mk] = { done: 0, missed: 0, squats: 0, dumbbells: 0 };
  data.monthStats[mk].done      += prev.done;
  data.monthStats[mk].missed    += prev.missed;
  data.monthStats[mk].squats    += prev.squats;
  data.monthStats[mk].dumbbells += prev.dumbbells;

  if (prev.done > 0) {
    data.streak.current += 1;
    data.streak.best = Math.max(data.streak.best, data.streak.current);
  } else {
    data.streak.current = 0;
  }
}

function ensureToday(data) {
  const key = todayKey();
  if (data.today.date !== key) {
    archiveDay(data);
    data.today       = emptyDay(key);
    data.inRowStreak = 0;
  }
  return data;
}

function addReps(data, squats, dumbbells) {
  data.today.squats    += squats;
  data.today.dumbbells += dumbbells;
  data.today.done      += 1;
  data.inRowStreak     += 1;
  if (!data.allTime) data.allTime = { squats: 0, dumbbells: 0, done: 0 };
  data.allTime.squats    += squats;
  data.allTime.dumbbells += dumbbells;
  data.allTime.done      += 1;
}

// ─── БОТ ──────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });

function reminderKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: `🦵 ${SQUATS_REPS} приседаний`,   callback_data: 'squats'    },
        { text: `💪 ${DUMBBELLS_REPS} гантелей`,   callback_data: 'dumbbells' },
      ],
      [
        { text: `✅ И то, и то (+${SQUATS_REPS} +${DUMBBELLS_REPS})`, callback_data: 'both' },
      ],
      [
        { text: '❌ Пропустил',        callback_data: 'missed' },
        { text: '⏸ Пауза на сегодня', callback_data: 'pause'  },
      ],
    ],
  };
}

// ─── НАПОМИНАНИЕ ──────────────────────────────────────────────────────────────
async function sendReminder() {
  let data = loadData();
  data = ensureToday(data);
  if (data.today.paused) { saveData(data); return; }

  const hour       = new Date().toLocaleTimeString('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const streakLine = data.inRowStreak > 0
    ? `🔥 Стрик: ${data.inRowStreak} подряд`
    : '💤 Стрик сброшен — начнём заново!';

  const text =
    `⏰ *${hour} — Время размяться!*\n\n` +
    `Выбери что сделал:\n` +
    `🦵 Приседания — ${SQUATS_REPS} раз\n` +
    `💪 Гантели — ${DUMBBELLS_REPS} раз (20 × каждой рукой)\n\n` +
    `${streakLine}\n` +
    `Сегодня: 🦵 ${data.today.squats} | 💪 ${data.today.dumbbells}`;

  try {
    if (data.lastMsgId) await bot.deleteMessage(CHAT_ID, data.lastMsgId).catch(() => {});
    const msg = await bot.sendMessage(CHAT_ID, text, {
      parse_mode:   'Markdown',
      reply_markup: reminderKeyboard(),
    });
    data.lastMsgId = msg.message_id;
    saveData(data);
  } catch (e) { console.error('Ошибка напоминания:', e.message); }
}

// ─── ИТОГ ДНЯ ─────────────────────────────────────────────────────────────────
async function sendDailySummary() {
  let data = loadData();
  data = ensureToday(data);

  const total   = data.today.done + data.today.missed;
  const percent = total > 0 ? Math.round((data.today.done / total) * 100) : 0;
  let medal = '😴';
  if (percent === 100) medal = '🏆';
  else if (percent >= 70) medal = '💪';
  else if (percent >= 40) medal = '👍';

  const text =
    `${medal} *Итог дня — ${data.today.date}*\n\n` +
    `✅ Подходов: *${data.today.done}* из *${total}* (${percent}%)\n` +
    `🦵 Приседания: *${data.today.squats}* раз\n` +
    `💪 Гантели: *${data.today.dumbbells}* раз\n\n` +
    `🔥 Стрик дней подряд: *${data.streak.current}*\n` +
    `🏅 Рекорд: *${data.streak.best}* дней\n\n` +
    (percent === 100
      ? '🎯 Все подходы выполнены — день в копилку!'
      : percent >= 70
        ? '👏 Хороший результат. Завтра — ещё лучше.'
        : '💡 Завтра попробуем сделать больше.');

  await bot.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown' })
    .catch(e => console.error('Ошибка итога дня:', e.message));
}

// ─── ЕЖЕНЕДЕЛЬНЫЙ ДАЙДЖЕСТ ────────────────────────────────────────────────────
async function sendWeeklyDigest() {
  let data = loadData();
  const wk = weekKey();
  const ws = data.weekStats[wk] || { done: 0, missed: 0, squats: 0, dumbbells: 0 };
  const total   = ws.done + ws.missed;
  const percent = total > 0 ? Math.round((ws.done / total) * 100) : 0;

  const text =
    `📅 *Итог недели ${wk}*\n\n` +
    `✅ Подходов: *${ws.done}* из *${total}* (${percent}%)\n` +
    `🦵 Приседания: *${ws.squats}* раз\n` +
    `💪 Гантели: *${ws.dumbbells}* раз\n\n` +
    `🔥 Стрик дней: *${data.streak.current}*\n` +
    `🏅 Рекорд: *${data.streak.best}* дней\n\n` +
    (percent >= 80 ? '🏆 Продуктивная неделя! Так держать.' :
      percent >= 50 ? '💪 Неплохо, но есть куда расти.' :
                      '📈 Следующая неделя будет лучше. Не останавливайся!');

  await bot.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown' })
    .catch(e => console.error('Ошибка дайджеста:', e.message));
}

// ─── CALLBACKS ────────────────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  if (String(query.message.chat.id) !== String(CHAT_ID)) return;

  let data = loadData();
  data = ensureToday(data);
  const action = query.data;
  const motiv  = randomMotivation();

  if (action === 'squats' || action === 'dumbbells' || action === 'both') {
    const sq = (action === 'squats'    || action === 'both') ? SQUATS_REPS    : 0;
    const db = (action === 'dumbbells' || action === 'both') ? DUMBBELLS_REPS : 0;
    addReps(data, sq, db);

    const fire = data.inRowStreak >= 5 ? '🔥🔥🔥' : data.inRowStreak >= 3 ? '🔥🔥' : '🔥';
    const what = action === 'both'
      ? `🦵 ${sq} + 💪 ${db}`
      : action === 'squats'
        ? `🦵 ${sq} приседаний`
        : `💪 ${db} гантелей`;

    const text =
      `✅ *${motiv}* ${what}\n\n` +
      `${fire} Стрик: *${data.inRowStreak} подряд*\n\n` +
      `*Сегодня накоплено:*\n` +
      `🦵 Приседания: *${data.today.squats}* раз\n` +
      `💪 Гантели: *${data.today.dumbbells}* раз`;

    await bot.editMessageText(text, {
      chat_id: CHAT_ID, message_id: query.message.message_id, parse_mode: 'Markdown',
    }).catch(() => {});

  } else if (action === 'missed') {
    data.today.missed += 1;
    data.inRowStreak = 0;

    await bot.editMessageText(
      `❌ Записал. Стрик сброшен.\nСегодня: ✅ ${data.today.done} подходов | ❌ ${data.today.missed} пропусков\n\nВ следующий раз — обязательно! 💪`,
      { chat_id: CHAT_ID, message_id: query.message.message_id, parse_mode: 'Markdown' }
    ).catch(() => {});

  } else if (action === 'pause') {
    data.today.paused = true;

    await bot.editMessageText(
      `⏸ *Пауза на сегодня.*\nОстальные напоминания отменены.\nСтрик дней не пострадает.\n\nОтдыхай, завтра продолжим! 🙌`,
      { chat_id: CHAT_ID, message_id: query.message.message_id, parse_mode: 'Markdown' }
    ).catch(() => {});
  }

  data.lastMsgId = null;
  saveData(data);
  await bot.answerCallbackQuery(query.id).catch(() => {});
});

// ─── КОМАНДЫ ──────────────────────────────────────────────────────────────────
bot.onText(/\/today/, async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  let data = loadData(); data = ensureToday(data);
  const total   = data.today.done + data.today.missed;
  const percent = total > 0 ? Math.round((data.today.done / total) * 100) : 0;
  await bot.sendMessage(CHAT_ID,
    `📊 *Сегодня, ${data.today.date}*\n\n` +
    `✅ Подходов: *${data.today.done}* из *${total}* (${percent}%)\n` +
    `❌ Пропущено: *${data.today.missed}*\n\n` +
    `🦵 Приседания: *${data.today.squats}* раз\n` +
    `💪 Гантели: *${data.today.dumbbells}* раз\n\n` +
    `🔥 Стрик подряд сегодня: *${data.inRowStreak}*\n` +
    `📅 Стрик дней подряд: *${data.streak.current}*` +
    (data.today.paused ? '\n\n⏸ Сегодня пауза' : ''),
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/stats/, async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  let data = loadData(); data = ensureToday(data);
  const wk = weekKey();
  const mk = monthKey();
  const ws = data.weekStats[wk]  || { done: 0, squats: 0, dumbbells: 0 };
  const ms = data.monthStats[mk] || { done: 0, squats: 0, dumbbells: 0 };
  const at = data.allTime        || { done: 0, squats: 0, dumbbells: 0 };

  await bot.sendMessage(CHAT_ID,
    `📈 *Статистика*\n\n` +
    `*За неделю:*\n` +
    `✅ ${ws.done} подходов | 🦵 ${ws.squats} | 💪 ${ws.dumbbells}\n\n` +
    `*За месяц:*\n` +
    `✅ ${ms.done} подходов | 🦵 ${ms.squats} | 💪 ${ms.dumbbells}\n\n` +
    `*За всё время:*\n` +
    `✅ ${at.done} подходов | 🦵 ${at.squats} | 💪 ${at.dumbbells}\n\n` +
    `🔥 Стрик дней: *${data.streak.current}*\n` +
    `🏅 Рекорд: *${data.streak.best}* дней`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/pause/, async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  let data = loadData(); data = ensureToday(data);
  data.today.paused = !data.today.paused;
  saveData(data);
  await bot.sendMessage(CHAT_ID,
    data.today.paused
      ? '⏸ Пауза включена. Напоминания сегодня не придут.'
      : '▶️ Пауза снята. Напоминания возобновлены.'
  );
});

bot.onText(/\/start/, async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  await bot.sendMessage(CHAT_ID,
    `👋 *Fitness Bot*\n\n` +
    `Напоминания каждый час с 9:00 до 18:00 МСК (пн–пт).\n` +
    `Итог дня — в 21:00. Дайджест — воскресенье 20:00.\n\n` +
    `*Кнопки в каждом напоминании:*\n` +
    `🦵 ${SQUATS_REPS} приседаний\n` +
    `💪 ${DUMBBELLS_REPS} гантелей\n` +
    `✅ И то, и то\n\n` +
    `*Команды:*\n` +
    `/today — статистика за сегодня\n` +
    `/stats — неделя / месяц / всё время\n` +
    `/pause — пауза на сегодня\n\n` +
    `Погнали! 💪`,
    { parse_mode: 'Markdown' }
  );
});

// ─── ТЕКСТОВЫЙ ХЭНДЛЕР ────────────────────────────────────────────────────────
const DONE_WORDS = ['сделал','готово','выполнил','done','ок','ok','выполнено','сделано','готов','✅'];
const MISS_WORDS = ['не сделал','пропустил','не успел','пропуск','miss','не смог'];

bot.on('message', async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  if (!msg.text || msg.text.startsWith('/')) return;
  const text   = msg.text.toLowerCase().trim();
  const isDone = DONE_WORDS.some(w => text.includes(w));
  const isMiss = MISS_WORDS.some(w => text.includes(w));

  if (!isDone && !isMiss) {
    await bot.sendMessage(CHAT_ID,
      'Не понял 🤔\n\nНажми кнопку в напоминании или напиши *сделал* / *не сделал*.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  let data = loadData(); data = ensureToday(data);

  if (isDone) {
    addReps(data, SQUATS_REPS, DUMBBELLS_REPS);
    const fire = data.inRowStreak >= 5 ? '🔥🔥🔥' : data.inRowStreak >= 3 ? '🔥🔥' : '🔥';
    await bot.sendMessage(CHAT_ID,
      `✅ *Засчитал оба!*\n\n${fire} Стрик: *${data.inRowStreak} подряд*\n` +
      `🦵 ${data.today.squats} | 💪 ${data.today.dumbbells} сегодня`,
      { parse_mode: 'Markdown' }
    );
  } else {
    data.today.missed += 1; data.inRowStreak = 0;
    await bot.sendMessage(CHAT_ID,
      `❌ Пропуск записан. Стрик сброшен.\nСегодня: ✅ ${data.today.done} | ❌ ${data.today.missed}`,
      { parse_mode: 'Markdown' }
    );
  }
  saveData(data);
});

// ─── CRON (Railway UTC, МСК = UTC+3) ──────────────────────────────────────────
cron.schedule('0 6,7,8,9,10,11,12,13,14,15 * * 1-5', sendReminder,    { timezone: 'UTC' });
cron.schedule('0 18 * * 1-5',                         sendDailySummary, { timezone: 'UTC' });
cron.schedule('0 17 * * 0',                           sendWeeklyDigest, { timezone: 'UTC' });

// ─── СТАРТ ────────────────────────────────────────────────────────────────────
console.log('✅ Fitness Bot | пн–пт 9:00–18:00 МСК | итог 21:00 МСК');
bot.sendMessage(CHAT_ID,
  '🤖 *Fitness Bot обновлён!*\n\n' +
  'Теперь три кнопки: приседания / гантели / и то, и то.\n' +
  'Считаю повторения за день, неделю, месяц и всё время.\n' +
  '/stats — полная статистика.',
  { parse_mode: 'Markdown' }
).catch(e => console.error('Стартовое сообщение:', e.message));
