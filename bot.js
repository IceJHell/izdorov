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

// ─── МОТИВАЦИЯ ────────────────────────────────────────────────────────────────
const MOTIVATIONS = ['Огонь! 🔥','Красавчик! 💪','Так держать!','Зачтено! 🎯','Машина! 🤖','Жги! 🚀','Молодец!','Лучший! 🏆'];
const randomMotivation = () => MOTIVATIONS[Math.floor(Math.random() * MOTIVATIONS.length)];

// ─── УПРАЖНЕНИЯ ПО УМОЛЧАНИЮ ─────────────────────────────────────────────────
const DEFAULT_EXERCISES = [
  { id: 'squats',    name: 'Приседания', emoji: '🦵', reps: 10  },
  { id: 'dumbbells', name: 'Гантели',    emoji: '💪', reps: 40  },
];

// ─── ДАННЫЕ ───────────────────────────────────────────────────────────────────
function emptyDay(date) {
  return {
    date:      date || '',
    done:      0,
    missed:    0,
    paused:    false,
    busyRanges: [],      // [{from: '12:00', to: '14:00', label: 'зал'}]
    reps:      {},       // { squats: 0, dumbbells: 0, ... }
  };
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
    allTime:     { done: 0, reps: {} },
    lastMsgId:   null,
    waitingFor:  null,   // состояние диалога: 'busy_time' | null
    exercises:   DEFAULT_EXERCISES,  // кастомный список упражнений
  };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function todayKey() { return new Date().toLocaleDateString('ru-RU', { timeZone: TZ }); }
function weekKey() {
  const now = new Date(), jan1 = new Date(now.getFullYear(), 0, 1);
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
  const wk = weekKey(), mk = monthKey();
  if (!data.weekStats[wk])  data.weekStats[wk]  = { done: 0, missed: 0, reps: {} };
  if (!data.monthStats[mk]) data.monthStats[mk] = { done: 0, missed: 0, reps: {} };
  for (const s of [data.weekStats[wk], data.monthStats[mk]]) {
    s.done   += prev.done;
    s.missed += prev.missed;
    for (const [k, v] of Object.entries(prev.reps || {})) {
      s.reps[k] = (s.reps[k] || 0) + v;
    }
  }
  if (!data.allTime) data.allTime = { done: 0, reps: {} };
  data.allTime.done += prev.done;
  for (const [k, v] of Object.entries(prev.reps || {})) {
    data.allTime.reps[k] = (data.allTime.reps[k] || 0) + v;
  }
  data.streak.current = prev.done > 0 ? data.streak.current + 1 : 0;
  data.streak.best = Math.max(data.streak.best, data.streak.current);
}

function ensureToday(data) {
  const key = todayKey();
  if (data.today.date !== key) {
    archiveDay(data);
    data.today       = emptyDay(key);
    data.inRowStreak = 0;
    data.waitingFor  = null;
  }
  return data;
}

function addReps(data, exerciseId, count) {
  if (!data.today.reps) data.today.reps = {};
  data.today.reps[exerciseId] = (data.today.reps[exerciseId] || 0) + count;
  data.today.done += 1;
  data.inRowStreak += 1;
}

// ─── ВРЕМЯ: ПАРСИНГ И ПРОВЕРКА ────────────────────────────────────────────────

// Преобразуем "12", "12:30", "12.30" → минуты от полуночи
function parseTime(str) {
  str = str.trim().replace('.', ':').replace('ч', '').replace('h', '');
  const parts = str.split(':');
  const h = parseInt(parts[0], 10);
  const m = parts[1] ? parseInt(parts[1], 10) : 0;
  if (isNaN(h)) return null;
  return h * 60 + m;
}

// Формат минут → "12:00"
function fmtTime(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

// Текущее время в МСК → минуты от полуночи
function nowMinutes() {
  const now = new Date();
  const msk = new Date(now.toLocaleString('en-US', { timeZone: TZ }));
  return msk.getHours() * 60 + msk.getMinutes();
}

// Ищем паттерн "с X до Y" / "с X по Y" / "X-Y" / "X до Y" в тексте
function extractTimeRange(text) {
  text = text.toLowerCase();
  const patterns = [
    /с\s+(\d{1,2}[:.ч]?\d{0,2})\s+(?:до|по)\s+(\d{1,2}[:.ч]?\d{0,2})/,
    /(\d{1,2}[:.]\d{2})\s*[-–—]\s*(\d{1,2}[:.]\d{2})/,
    /(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*(?:ч|час|:00)?/,
    /с\s+(\d{1,2})\s+(?:до|по)\s+(\d{1,2})/,
    /до\s+(\d{1,2}[:.ч]?\d{0,2})/,   // "занят до 14" — от сейчас до X
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      if (m.length === 2) {
        // "до X" — от текущего момента
        const to = parseTime(m[1]);
        if (to !== null) return { from: nowMinutes(), to };
      } else {
        const from = parseTime(m[1]), to = parseTime(m[2]);
        if (from !== null && to !== null && to > from) return { from, to };
      }
    }
  }
  return null;
}

// Проверяем, попадает ли текущий момент в busy-диапазоны
function isBusyNow(data) {
  const now = nowMinutes();
  return (data.today.busyRanges || []).some(r => now >= r.from && now < r.to);
}

// ─── БОТ ──────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });

// ─── КЛАВИАТУРА НАПОМИНАНИЯ (динамическая по упражнениям) ─────────────────────
function reminderKeyboard(exercises) {
  const exRows = [];
  // Упражнения по 2 в ряд
  for (let i = 0; i < exercises.length; i += 2) {
    const row = [];
    const ex1 = exercises[i];
    row.push({ text: `${ex1.emoji} ${ex1.reps} ${ex1.name}`, callback_data: `ex:${ex1.id}` });
    if (exercises[i + 1]) {
      const ex2 = exercises[i + 1];
      row.push({ text: `${ex2.emoji} ${ex2.reps} ${ex2.name}`, callback_data: `ex:${ex2.id}` });
    }
    exRows.push(row);
  }
  // Кнопка "всё сразу" если упражнений больше одного
  if (exercises.length > 1) {
    exRows.push([{ text: `✅ Всё сразу (${exercises.map(e => e.reps).join('+')} раз)`, callback_data: 'ex:ALL' }]);
  }
  return {
    inline_keyboard: [
      ...exRows,
      [
        { text: '❌ Пропустил',   callback_data: 'missed' },
        { text: '🕐 Занят до...',  callback_data: 'busy'   },
      ],
      [
        { text: '⏸ Пауза на весь день', callback_data: 'pause' },
      ],
    ],
  };
}

// ─── НАПОМИНАНИЕ ──────────────────────────────────────────────────────────────
async function sendReminder() {
  let data = loadData();
  data = ensureToday(data);

  if (data.today.paused) { saveData(data); return; }
  if (isBusyNow(data)) {
    const busy = data.today.busyRanges.find(r => nowMinutes() >= r.from && nowMinutes() < r.to);
    console.log(`⏭ Пропуск напоминания — занят до ${busy ? fmtTime(busy.to) : '?'}`);
    saveData(data);
    return;
  }

  const exercises = data.exercises || DEFAULT_EXERCISES;
  const hour = new Date().toLocaleTimeString('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const streakLine = data.inRowStreak > 0
    ? `🔥 Стрик: ${data.inRowStreak} подряд`
    : '💤 Стрик сброшен — начнём заново!';

  const exList = exercises.map(e => `${e.emoji} ${e.name} — ${e.reps} раз`).join('\n');
  const todayReps = exercises.map(e => `${e.emoji} ${data.today.reps?.[e.id] || 0}`).join(' | ');

  const text =
    `⏰ *${hour} — Время размяться!*\n\n` +
    `${exList}\n\n` +
    `${streakLine}\n` +
    `Сегодня: ${todayReps}`;

  try {
    if (data.lastMsgId) await bot.deleteMessage(CHAT_ID, data.lastMsgId).catch(() => {});
    const msg = await bot.sendMessage(CHAT_ID, text, {
      parse_mode:   'Markdown',
      reply_markup: reminderKeyboard(exercises),
    });
    data.lastMsgId = msg.message_id;
    saveData(data);
  } catch (e) { console.error('Ошибка напоминания:', e.message); }
}

// ─── ИТОГ ДНЯ ─────────────────────────────────────────────────────────────────
async function sendDailySummary() {
  let data = loadData();
  data = ensureToday(data);

  const exercises = data.exercises || DEFAULT_EXERCISES;
  const total   = data.today.done + data.today.missed;
  const percent = total > 0 ? Math.round((data.today.done / total) * 100) : 0;
  let medal = '😴';
  if (percent === 100) medal = '🏆';
  else if (percent >= 70) medal = '💪';
  else if (percent >= 40) medal = '👍';

  const repLines = exercises.map(e =>
    `${e.emoji} ${e.name}: *${data.today.reps?.[e.id] || 0}* раз`
  ).join('\n');

  const text =
    `${medal} *Итог дня — ${data.today.date}*\n\n` +
    `✅ Подходов: *${data.today.done}* из *${total}* (${percent}%)\n\n` +
    `${repLines}\n\n` +
    `🔥 Стрик дней: *${data.streak.current}* | 🏅 Рекорд: *${data.streak.best}*\n\n` +
    (percent === 100 ? '🎯 Все подходы выполнены — день в копилку!' :
      percent >= 70   ? '👏 Хороший результат. Завтра — ещё лучше.' :
                        '💡 Завтра попробуем сделать больше.');

  await bot.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown' })
    .catch(e => console.error('Итог дня:', e.message));
}

// ─── ЕЖЕНЕДЕЛЬНЫЙ ДАЙДЖЕСТ ────────────────────────────────────────────────────
async function sendWeeklyDigest() {
  let data = loadData();
  const exercises = data.exercises || DEFAULT_EXERCISES;
  const wk = weekKey();
  const ws = data.weekStats[wk] || { done: 0, missed: 0, reps: {} };
  const total   = ws.done + ws.missed;
  const percent = total > 0 ? Math.round((ws.done / total) * 100) : 0;

  const repLines = exercises.map(e =>
    `${e.emoji} ${e.name}: *${ws.reps?.[e.id] || 0}* раз`
  ).join('\n');

  const text =
    `📅 *Итог недели ${wk}*\n\n` +
    `✅ Подходов: *${ws.done}* из *${total}* (${percent}%)\n\n` +
    `${repLines}\n\n` +
    `🔥 Стрик дней: *${data.streak.current}* | 🏅 Рекорд: *${data.streak.best}*\n\n` +
    (percent >= 80 ? '🏆 Продуктивная неделя!' :
      percent >= 50 ? '💪 Неплохо, но есть куда расти.' :
                      '📈 Следующая неделя будет лучше.');

  await bot.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown' })
    .catch(e => console.error('Дайджест:', e.message));
}

// ─── CALLBACKS ────────────────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  if (String(query.message.chat.id) !== String(CHAT_ID)) return;
  await bot.answerCallbackQuery(query.id).catch(() => {});

  let data = loadData();
  data = ensureToday(data);
  const action    = query.data;
  const exercises = data.exercises || DEFAULT_EXERCISES;

  // ── Упражнение(я) ──
  if (action.startsWith('ex:')) {
    const exId = action.slice(3);
    let doneList = [];

    if (exId === 'ALL') {
      for (const ex of exercises) {
        addReps(data, ex.id, ex.reps);
        doneList.push(`${ex.emoji} ${ex.reps} ${ex.name}`);
      }
    } else {
      const ex = exercises.find(e => e.id === exId);
      if (ex) { addReps(data, ex.id, ex.reps); doneList.push(`${ex.emoji} ${ex.reps} ${ex.name}`); }
    }

    const fire = data.inRowStreak >= 5 ? '🔥🔥🔥' : data.inRowStreak >= 3 ? '🔥🔥' : '🔥';
    const todayReps = exercises.map(e => `${e.emoji} ${data.today.reps?.[e.id] || 0}`).join(' | ');

    await bot.editMessageText(
      `✅ *${randomMotivation()}* ${doneList.join(', ')}\n\n` +
      `${fire} Стрик: *${data.inRowStreak} подряд*\n\n` +
      `*Сегодня накоплено:*\n${todayReps}`,
      { chat_id: CHAT_ID, message_id: query.message.message_id, parse_mode: 'Markdown' }
    ).catch(() => {});

  // ── Занят до... ──
  } else if (action === 'busy') {
    data.waitingFor = 'busy_time';
    await bot.editMessageText(
      `🕐 *До какого времени занят?*\n\nНапиши время, например:\n• _до 14:00_\n• _с 12 до 14_\n• _зал с 13 до 15_`,
      { chat_id: CHAT_ID, message_id: query.message.message_id, parse_mode: 'Markdown' }
    ).catch(() => {});

  // ── Пропустил ──
  } else if (action === 'missed') {
    data.today.missed += 1;
    data.inRowStreak   = 0;
    await bot.editMessageText(
      `❌ Записал. Стрик сброшен.\nСегодня: ✅ ${data.today.done} | ❌ ${data.today.missed}\n\nВ следующий раз — обязательно! 💪`,
      { chat_id: CHAT_ID, message_id: query.message.message_id, parse_mode: 'Markdown' }
    ).catch(() => {});

  // ── Пауза на весь день ──
  } else if (action === 'pause') {
    data.today.paused = true;
    await bot.editMessageText(
      `⏸ *Пауза на сегодня.*\nОстальные напоминания отменены.\nСтрик дней не пострадает.\n\nОтдыхай, завтра продолжим! 🙌`,
      { chat_id: CHAT_ID, message_id: query.message.message_id, parse_mode: 'Markdown' }
    ).catch(() => {});
  }

  data.lastMsgId = null;
  saveData(data);
});

// ─── КОМАНДЫ ──────────────────────────────────────────────────────────────────

// /addexercise Подтягивания 15 🏋️
bot.onText(/\/addexercise (.+)/, async (msg, match) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  const parts = match[1].trim().split(/\s+/);
  // Последний элемент — число (кол-во повторений)
  // Предпоследний может быть эмодзи
  let reps = parseInt(parts[parts.length - 1], 10);
  if (isNaN(reps)) {
    await bot.sendMessage(CHAT_ID, '❌ Формат: `/addexercise Название КоличествоПовторений`\nПример: `/addexercise Подтягивания 10`', { parse_mode: 'Markdown' });
    return;
  }
  parts.pop();

  // Проверяем эмодзи в конце
  const emojiRegex = /\p{Emoji}/u;
  let emoji = '🏋️';
  if (parts.length > 0 && emojiRegex.test(parts[parts.length - 1])) {
    emoji = parts.pop();
  }
  const name = parts.join(' ');
  if (!name) {
    await bot.sendMessage(CHAT_ID, '❌ Укажи название упражнения.'); return;
  }

  const id = name.toLowerCase().replace(/[^a-zа-я0-9]/g, '_') + '_' + Date.now();
  let data = loadData(); data = ensureToday(data);
  if (!data.exercises) data.exercises = [...DEFAULT_EXERCISES];
  data.exercises.push({ id, name, emoji, reps });
  saveData(data);

  await bot.sendMessage(CHAT_ID,
    `✅ Упражнение добавлено!\n${emoji} *${name}* — ${reps} раз\n\n/exercises — список всех упражнений`,
    { parse_mode: 'Markdown' }
  );
});

// /removeexercise ID
bot.onText(/\/removeexercise (.+)/, async (msg, match) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  const id = match[1].trim();
  let data = loadData(); data = ensureToday(data);
  const before = (data.exercises || []).length;
  data.exercises = (data.exercises || []).filter(e => e.id !== id);
  if (data.exercises.length === before) {
    await bot.sendMessage(CHAT_ID, `❌ Упражнение с ID \`${id}\` не найдено.\n/exercises — список`, { parse_mode: 'Markdown' });
    return;
  }
  saveData(data);
  await bot.sendMessage(CHAT_ID, `✅ Упражнение удалено.`);
});

// /exercises — список
bot.onText(/\/exercises/, async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  let data = loadData(); data = ensureToday(data);
  const exercises = data.exercises || DEFAULT_EXERCISES;
  const lines = exercises.map(e => `${e.emoji} *${e.name}* — ${e.reps} раз\n  ID: \`${e.id}\``).join('\n\n');
  await bot.sendMessage(CHAT_ID,
    `📋 *Упражнения (${exercises.length}):*\n\n${lines}\n\n` +
    `Добавить: /addexercise Название КолПовторений\n` +
    `Удалить: /removeexercise ID`,
    { parse_mode: 'Markdown' }
  );
});

// /busy — список заблокированных временных окон сегодня
bot.onText(/\/busy/, async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  let data = loadData(); data = ensureToday(data);
  const ranges = data.today.busyRanges || [];
  if (ranges.length === 0) {
    await bot.sendMessage(CHAT_ID, '📅 Занятых промежутков сегодня нет.\n\nНапиши, например: _с 12 до 14 тренажерный зал_', { parse_mode: 'Markdown' });
  } else {
    const lines = ranges.map(r => `• ${fmtTime(r.from)}–${fmtTime(r.to)}${r.label ? ' (' + r.label + ')' : ''}`).join('\n');
    await bot.sendMessage(CHAT_ID, `🕐 *Занят сегодня:*\n${lines}\n\nНапиши новое время чтобы добавить ещё.`, { parse_mode: 'Markdown' });
  }
});

// /clearbуsy — сбросить все временные блоки
bot.onText(/\/clearbusy/, async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  let data = loadData(); data = ensureToday(data);
  data.today.busyRanges = [];
  saveData(data);
  await bot.sendMessage(CHAT_ID, '✅ Все временные блоки сброшены. Напоминания снова приходят.');
});

bot.onText(/\/today/, async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  let data = loadData(); data = ensureToday(data);
  const exercises = data.exercises || DEFAULT_EXERCISES;
  const total   = data.today.done + data.today.missed;
  const percent = total > 0 ? Math.round((data.today.done / total) * 100) : 0;
  const repLines = exercises.map(e => `${e.emoji} ${e.name}: *${data.today.reps?.[e.id] || 0}* раз`).join('\n');
  const busyLines = (data.today.busyRanges || []).map(r => `• ${fmtTime(r.from)}–${fmtTime(r.to)}${r.label ? ' (' + r.label + ')' : ''}`).join('\n');

  await bot.sendMessage(CHAT_ID,
    `📊 *Сегодня, ${data.today.date}*\n\n` +
    `✅ Подходов: *${data.today.done}* из *${total}* (${percent}%)\n` +
    `❌ Пропущено: *${data.today.missed}*\n\n` +
    `${repLines}\n\n` +
    `🔥 Стрик подряд: *${data.inRowStreak}* | Дней: *${data.streak.current}*` +
    (data.today.paused ? '\n\n⏸ Сегодня пауза' : '') +
    (busyLines ? `\n\n🕐 Занят:\n${busyLines}` : ''),
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/stats/, async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  let data = loadData(); data = ensureToday(data);
  const exercises = data.exercises || DEFAULT_EXERCISES;
  const wk = weekKey(), mk = monthKey();
  const ws = data.weekStats[wk]  || { done: 0, reps: {} };
  const ms = data.monthStats[mk] || { done: 0, reps: {} };
  const at = data.allTime        || { done: 0, reps: {} };

  const fmt = (statsObj) => exercises.map(e => `${e.emoji} ${statsObj.reps?.[e.id] || 0}`).join(' | ');

  await bot.sendMessage(CHAT_ID,
    `📈 *Статистика*\n\n` +
    `*За неделю:* ✅ ${ws.done} подходов\n${fmt(ws)}\n\n` +
    `*За месяц:* ✅ ${ms.done} подходов\n${fmt(ms)}\n\n` +
    `*За всё время:* ✅ ${at.done} подходов\n${fmt(at)}\n\n` +
    `🔥 Стрик дней: *${data.streak.current}* | 🏅 Рекорд: *${data.streak.best}*`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/pause/, async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  let data = loadData(); data = ensureToday(data);
  data.today.paused = !data.today.paused;
  saveData(data);
  await bot.sendMessage(CHAT_ID,
    data.today.paused ? '⏸ Пауза включена. Напоминания сегодня не придут.' : '▶️ Пауза снята. Напоминания возобновлены.'
  );
});

bot.onText(/\/start/, async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  await bot.sendMessage(CHAT_ID,
    `👋 *Fitness Bot*\n\n` +
    `Напоминания каждый час с 9:00 до 18:00 МСК (пн–пт).\n\n` +
    `*Команды:*\n` +
    `/today — статистика за сегодня\n` +
    `/stats — неделя / месяц / всё время\n` +
    `/pause — пауза на весь день\n` +
    `/busy — занятые промежутки сегодня\n` +
    `/clearbusy — сбросить занятые промежутки\n` +
    `/exercises — список упражнений\n` +
    `/addexercise Подтягивания 10 🏋️ — добавить упражнение\n` +
    `/removeexercise ID — удалить упражнение\n\n` +
    `*Умная пауза по времени:*\nПросто напиши _зал с 12 до 14_ или _занят до 15:30_ — бот сам пропустит напоминания в это время.\n\n` +
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

  let data = loadData();
  data = ensureToday(data);
  const text = msg.text.toLowerCase().trim();

  // ── Ждём ответа на "Занят до..." ──
  if (data.waitingFor === 'busy_time') {
    const range = extractTimeRange(msg.text);
    if (!range) {
      await bot.sendMessage(CHAT_ID,
        '🤔 Не смог распознать время.\n\nПопробуй: _с 12 до 14_, _до 15:30_, _13:00-15:00_',
        { parse_mode: 'Markdown' }
      );
      return;
    }
    // Ищем подпись (всё кроме времени)
    const label = msg.text.replace(/\d{1,2}[:.ч]?\d{0,2}/g, '').replace(/[сСдоДпо\-–—]/g, '').trim().slice(0, 30) || '';
    if (!data.today.busyRanges) data.today.busyRanges = [];
    data.today.busyRanges.push({ ...range, label });
    data.waitingFor = null;
    saveData(data);

    await bot.sendMessage(CHAT_ID,
      `⏸ *Понял!* Буду молчать с *${fmtTime(range.from)}* до *${fmtTime(range.to)}*.\n` +
      (label ? `_(${label})_\n` : '') +
      `\nНапоминания в это время пропущу — стрик не пострадает.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // ── Умная пауза: ищем время в любом сообщении ──
  const range = extractTimeRange(text);
  if (range) {
    const label = msg.text.replace(/\d{1,2}[:.ч]?\d{0,2}/g, '').replace(/[сСдоДпо\-–—]/g, '').trim().slice(0, 30) || '';
    if (!data.today.busyRanges) data.today.busyRanges = [];
    data.today.busyRanges.push({ ...range, label });
    saveData(data);
    await bot.sendMessage(CHAT_ID,
      `✅ Записал: буду молчать с *${fmtTime(range.from)}* до *${fmtTime(range.to)}*.\n` +
      (label ? `_(${label})_\n` : '') +
      `\nНапоминания пропущу, стрик не пострадает. /busy — посмотреть все блоки.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // ── Сделал / не сделал текстом ──
  const isDone = DONE_WORDS.some(w => text.includes(w));
  const isMiss = MISS_WORDS.some(w => text.includes(w));

  if (!isDone && !isMiss) {
    await bot.sendMessage(CHAT_ID,
      'Не понял 🤔\n\n' +
      'Нажми кнопку в напоминании, напиши *сделал* / *не сделал*, или укажи время занятости (_зал с 12 до 14_).',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const exercises = data.exercises || DEFAULT_EXERCISES;
  if (isDone) {
    for (const ex of exercises) addReps(data, ex.id, ex.reps);
    const fire = data.inRowStreak >= 5 ? '🔥🔥🔥' : data.inRowStreak >= 3 ? '🔥🔥' : '🔥';
    const todayReps = exercises.map(e => `${e.emoji} ${data.today.reps?.[e.id] || 0}`).join(' | ');
    await bot.sendMessage(CHAT_ID,
      `✅ *Засчитал всё!*\n\n${fire} Стрик: *${data.inRowStreak} подряд*\n${todayReps}`,
      { parse_mode: 'Markdown' }
    );
  } else {
    data.today.missed += 1; data.inRowStreak = 0;
    await bot.sendMessage(CHAT_ID,
      `❌ Пропуск записан.\nСегодня: ✅ ${data.today.done} | ❌ ${data.today.missed}`,
      { parse_mode: 'Markdown' }
    );
  }
  saveData(data);
});

// ─── CRON ─────────────────────────────────────────────────────────────────────
cron.schedule('0 6,7,8,9,10,11,12,13,14,15 * * 1-5', sendReminder,    { timezone: 'UTC' });
cron.schedule('0 18 * * 1-5',                         sendDailySummary, { timezone: 'UTC' });
cron.schedule('0 17 * * 0',                           sendWeeklyDigest, { timezone: 'UTC' });

// ─── СТАРТ ────────────────────────────────────────────────────────────────────
console.log('✅ Fitness Bot v3 | пн–пт 9:00–18:00 МСК | умная пауза | кастомные упражнения');
bot.sendMessage(CHAT_ID,
  '🤖 *Fitness Bot обновлён!*\n\n' +
  '• Три кнопки + «Занят до...» в каждом напоминании\n' +
  '• Умная пауза: просто напиши _зал с 12 до 14_\n' +
  '• Кастомные упражнения: /addexercise\n\n' +
  '/start — полная справка',
  { parse_mode: 'Markdown' }
).catch(e => console.error('Стартовое:', e.message));
