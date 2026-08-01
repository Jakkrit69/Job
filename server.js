require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { normalizeThai, parseMonthToken, parseCommand, resolveIndexed, STATUS_LABEL, STATUS_ORDER, THAI_MONTHS_FULL } = require('./commands');

// เพิ่มตัวเลขนี้ทุกครั้งที่แก้ server.js/commands.js — ใช้เช็คว่า deploy โค้ดล่าสุดจริงหรือยัง
// เช็คได้ที่ GET /api/version หรือพิมพ์ "เวอร์ชัน" ใน LINE
const BUILD_VERSION = 'v13-2026-08-01-selfheal-rollover';

let DATA_DIR = process.env.DATA_DIR || '/data';
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  DATA_DIR = __dirname; // ใช้โฟลเดอร์โปรเจกต์แทน ถ้าไม่มี /data (เช่นรันในเครื่องที่ไม่มี volume)
}
const DATA_FILE = path.join(DATA_DIR, 'data.json');

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(lineConfig);
const app = express();

// ---------------- ตรวจสอบเดือนใหม่อัตโนมัติ (self-healing) ----------------
// เดิมพึ่งพา cron ที่รันตอนตี 00:05 วันที่ 1 อย่างเดียว — ถ้าเครื่อง "หลับ" อยู่ตอนนั้น (เช่น Railway
// พักการใช้งานตอนไม่มีคนเข้า) ตัวจับเวลาจะไม่ทำงานเลย งานที่ตั้งเลื่อนเดือน/งานประจำจะไม่ถูกสร้างขึ้น
// จุดนี้เป็นตัวช่วยสำรอง: เช็คทุกครั้งที่มีคำขอเข้ามา (ไม่ว่าจะเปิดเว็บหรือพิมพ์ LINE) ว่าเดือนนี้
// เคยรันไปหรือยัง ถ้ายังไม่เคย จะรันให้ทันทีตอนนั้นเลย ไม่ต้องรอเครื่องตื่นตรงเวลาเป๊ะ
function ensureMonthlyRollover() {
  const data = loadData();
  const curKey = currentMonthKey();
  if (data.lastMonthlyRunKey === curKey) return { moved: 0, created: 0, ranNow: false };
  const moved = runMonthCarryOver();
  const created = runRecurringGeneration();
  const freshData = loadData();
  freshData.lastMonthlyRunKey = curKey;
  saveData(freshData);
  return { moved, created, ranNow: true };
}

app.use((req, res, next) => {
  try {
    const result = ensureMonthlyRollover();
    if (result.ranNow && (result.moved > 0 || result.created > 0)) {
      const data = loadData();
      if (data.lineUserId) {
        const parts = [];
        if (result.moved > 0) parts.push(`เลื่อนงานที่ยังไม่เสร็จมาเดือนนี้ ${result.moved} ชิ้น`);
        if (result.created > 0) parts.push(`สร้างงานประจำใหม่ ${result.created} ชิ้น`);
        client.pushMessage(data.lineUserId, {
          type: 'text',
          text: `🔁 อัปเดตต้นเดือนอัตโนมัติ: ${parts.join(' และ ')}`,
        }).catch((err) => console.error('push rollover notice failed', err));
      }
    }
  } catch (err) {
    console.error('monthly rollover check failed', err);
  }
  next();
});

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { tasks: [], lineUserId: null, lastList: [], notes: [], lastNoteList: [], lastMonthlyRunKey: null };
  }
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!d.lastList) d.lastList = [];
    if (!d.notes) d.notes = [];
    if (!d.lastNoteList) d.lastNoteList = [];
    if (d.lastMonthlyRunKey === undefined) d.lastMonthlyRunKey = null;
    return d;
  } catch (e) {
    return { tasks: [], lineUserId: null, lastList: [], notes: [], lastNoteList: [], lastMonthlyRunKey: null };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function currentMonthKey() {
  const now = new Date();
  return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
}

function monthLabel(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return `${THAI_MONTHS_FULL[m - 1]} ${y + 543}`;
}

function shiftMonthKey(mKey, delta) {
  const [y, m] = mKey.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function formatTaskList(tasks, mKey) {
  if (tasks.length === 0) return `ไม่มีงานในเดือน${monthLabel(mKey)}เลยครับ`;
  const lines = tasks.map((t, i) => `${i + 1}. [${STATUS_LABEL[t.status]}] ${t.text}`).join('\n');
  return (
    `งาน — ${monthLabel(mKey)}\n${lines}\n\n` +
    `พิมพ์ "ทำ เลข" เพื่อขยับสถานะไปข้างหน้า (ค้าง→กำลังทำ→เสร็จแล้ว)\n` +
    `พิมพ์ "ย้อน เลข" เพื่อขยับสถานะย้อนกลับ\n` +
    `พิมพ์ "ลบ เลข" เพื่อลบงานนั้น`
  );
}

function sortNotes(notes) {
  return notes.slice().sort((a, b) => (a.order ?? a.createdAt ?? 0) - (b.order ?? b.createdAt ?? 0));
}

function formatNoteList(notes) {
  if (notes.length === 0) return 'ยังไม่มีบันทึกเลยครับ พิมพ์ "จด ข้อความ" เพื่อเพิ่มบันทึกแรกได้เลย';
  const lines = notes.map((n, i) => `${i + 1}. ${n.text}`).join('\n');
  return `📝 บันทึกทั้งหมด\n${lines}\n\nพิมพ์ "ลบโน้ต เลข" เพื่อลบบันทึกนั้น`;
}

// ---------------- LINE webhook ----------------
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  Promise.all(req.body.events.map(handleLineEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

const WELCOME_MESSAGE =
  'สวัสดีครับ 👋 นี่คือคำสั่งที่ใช้ได้ (พิมพ์ "คำสั่ง" เมื่อไหร่ก็ได้เพื่อดูรายการนี้อีกครั้ง):\n\n' +
  '• พิมพ์ข้อความอะไรก็ได้ → เพิ่มเป็นงาน "ค้าง" ของเดือนนี้\n' +
  '• "เดือน 8 ซื้อของขวัญ" → เพิ่มงานค้างลงเดือนสิงหาคม (ใช้เลข 1-12 หรือชื่อเดือนก็ได้)\n' +
  '• "เดือน 8 กำลังทำ ซื้อของขวัญ" → เพิ่มงานลงเดือนสิงหาคม พร้อมระบุหมวดเลย (ค้าง / กำลังทำ / เสร็จแล้ว)\n' +
  '• "รายการ" → ดูรายการงานของเดือนนี้ พร้อมเลขกำกับ\n' +
  '• "รายการ 8" → ดูรายการงานของเดือนสิงหาคม (ใช้เลข 1-12 หรือชื่อเดือนก็ได้)\n' +
  '• "ทำ 2" → ขยับสถานะงานหมายเลข 2 ไปข้างหน้า\n' +
  '• "ย้อน 2" → ขยับสถานะงานหมายเลข 2 ย้อนกลับ\n' +
  '• "ลบ 2" → ลบงานหมายเลข 2\n' +
  '• "แก้ไข 2 ข้อความใหม่" → แก้ชื่องานหมายเลข 2\n' +
  '• "กำหนด 2 2026-08-15" → ตั้งวันครบกำหนดของงานหมายเลข 2\n' +
  '• "เลื่อน 2" → สลับให้งานหมายเลข 2 เลื่อนไปเดือนหน้าอัตโนมัติถ้ายังไม่เสร็จตอนสิ้นเดือน\n' +
  '• "ประจำ 2" → สลับให้งานหมายเลข 2 เป็นงานประจำ สร้างซ้ำให้ทุกต้นเดือน\n' +
  '• "โน้ตงาน 2 รายละเอียด" → แนบโน้ตไว้ในงานหมายเลข 2\n' +
  '• "ลบโน้ตงาน 2" → ลบโน้ตที่แนบไว้ในงานหมายเลข 2\n\n' +
  '📝 สมุดบันทึกทั่วไป (ไม่ผูกกับงานไหน):\n' +
  '• "จด ข้อความ" → เพิ่มบันทึกใหม่\n' +
  '• "ดูโน้ต" → ดูบันทึกทั้งหมด พร้อมเลขกำกับ\n' +
  '• "ลบโน้ต 2" → ลบบันทึกหมายเลข 2\n' +
  '• "แก้ไขโน้ต 2 ข้อความใหม่" → แก้บันทึกหมายเลข 2\n\n' +
  '(เลขที่ใช้อ้างอิงกับงาน จะยึดตามรายการล่าสุดที่พิมพ์ "รายการ" ดูก่อนเสมอ ส่วนเลขบันทึกยึดตาม "ดูโน้ต" ล่าสุด)';

async function handleLineEvent(event) {
  const data = loadData();

  if (event.source && event.source.userId && !data.lineUserId) {
    data.lineUserId = event.source.userId;
    saveData(data);
  }

  if (event.type === 'follow') {
    return client.replyMessage(event.replyToken, { type: 'text', text: WELCOME_MESSAGE });
  }

  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const curKey = currentMonthKey();
  const action = parseCommand(event.message.text, new Date());

  function findByLastList(idx) {
    const monthTasks = data.tasks
      .filter((t) => t.monthKey === curKey)
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const { item, list } = resolveIndexed(data.lastList, monthTasks, idx);
    data.lastList = list;
    return item;
  }
  function findNoteByLastList(idx) {
    const { item, list } = resolveIndexed(data.lastNoteList, sortNotes(data.notes), idx);
    data.lastNoteList = list;
    return item;
  }
  function notFoundReply() {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'ไม่พบงานหมายเลขนี้ครับ ลองพิมพ์ "รายการ" เพื่อดูเลขล่าสุดก่อนนะครับ',
    });
  }
  function noteNotFoundReply() {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'ไม่พบบันทึกหมายเลขนี้ครับ ลองพิมพ์ "ดูโน้ต" เพื่อดูเลขล่าสุดก่อนนะครับ',
    });
  }

  switch (action.type) {
    case 'help': {
      return client.replyMessage(event.replyToken, { type: 'text', text: WELCOME_MESSAGE });
    }

    case 'version': {
      return client.replyMessage(event.replyToken, { type: 'text', text: `🔧 เวอร์ชันปัจจุบัน: ${BUILD_VERSION}` });
    }

    case 'list': {
      const targetKey = action.monthKey || curKey;
      const monthTasks = data.tasks
        .filter((t) => t.monthKey === targetKey)
        .slice()
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      data.lastList = monthTasks.map((t) => t.id);
      saveData(data);
      return client.replyMessage(event.replyToken, { type: 'text', text: formatTaskList(monthTasks, targetKey) });
    }

    case 'listMonthError': {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'ไม่เข้าใจชื่อเดือนครับ ลองพิมพ์เป็นเลข 1-12 เช่น "รายการ 8" หรือชื่อเดือนเต็ม เช่น "รายการ สิงหาคม"',
      });
    }

    case 'move': {
      const task = findByLastList(action.index);
      if (!task) return notFoundReply();
      const newIdx = STATUS_ORDER.indexOf(task.status) + action.dir;
      if (newIdx < 0 || newIdx > 2) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: `"${task.text}" อยู่ที่สถานะ [${STATUS_LABEL[task.status]}] อยู่แล้ว ขยับต่อไม่ได้ครับ`,
        });
      }
      task.status = STATUS_ORDER[newIdx];
      saveData(data);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `อัปเดตแล้ว: "${task.text}" → [${STATUS_LABEL[task.status]}]`,
      });
    }

    case 'delete': {
      const task = findByLastList(action.index);
      if (!task) return notFoundReply();
      data.tasks = data.tasks.filter((t) => t.id !== task.id);
      saveData(data);
      return client.replyMessage(event.replyToken, { type: 'text', text: `ลบแล้ว: "${task.text}"` });
    }

    case 'edit': {
      const task = findByLastList(action.index);
      if (!task) return notFoundReply();
      const oldText = task.text;
      task.text = action.text;
      saveData(data);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `แก้ไขแล้ว: "${oldText}" → "${task.text}"`,
      });
    }

    case 'deadline': {
      const task = findByLastList(action.index);
      if (!task) return notFoundReply();
      task.deadline = action.date;
      saveData(data);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `ตั้งวันครบกำหนดแล้ว: "${task.text}" → ${task.deadline}`,
      });
    }

    case 'toggleCarry': {
      const task = findByLastList(action.index);
      if (!task) return notFoundReply();
      task.carryOver = !task.carryOver;
      saveData(data);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: task.carryOver
          ? `ตั้งค่าแล้ว: "${task.text}" จะเลื่อนไปเดือนหน้าอัตโนมัติถ้ายังไม่เสร็จตอนสิ้นเดือน`
          : `ยกเลิกแล้ว: "${task.text}" จะไม่เลื่อนเดือนอัตโนมัติอีก`,
      });
    }

    case 'toggleRecurring': {
      const task = findByLastList(action.index);
      if (!task) return notFoundReply();
      task.recurring = !task.recurring;
      if (task.recurring && !task.recurringId) task.recurringId = task.id;
      saveData(data);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: task.recurring
          ? `ตั้งเป็นงานประจำแล้ว: "${task.text}" จะถูกสร้างใหม่ให้อัตโนมัติทุกต้นเดือน`
          : `ยกเลิกงานประจำแล้ว: "${task.text}"`,
      });
    }

    case 'taskNote': {
      const task = findByLastList(action.index);
      if (!task) return notFoundReply();
      task.note = action.text;
      saveData(data);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `📝 เพิ่มโน้ตให้งาน "${task.text}" แล้ว: ${task.note}`,
      });
    }

    case 'clearTaskNote': {
      const task = findByLastList(action.index);
      if (!task) return notFoundReply();
      task.note = null;
      saveData(data);
      return client.replyMessage(event.replyToken, { type: 'text', text: `ลบโน้ตของงาน "${task.text}" แล้ว` });
    }

    case 'addNote': {
      const note = { id: newId(), text: action.text, createdAt: Date.now(), order: Date.now() };
      data.notes.push(note);
      saveData(data);
      return client.replyMessage(event.replyToken, { type: 'text', text: `📝 จดแล้ว: "${note.text}"` });
    }

    case 'listNotes': {
      const sortedNotes = sortNotes(data.notes);
      data.lastNoteList = sortedNotes.map((n) => n.id);
      saveData(data);
      return client.replyMessage(event.replyToken, { type: 'text', text: formatNoteList(sortedNotes) });
    }

    case 'deleteNote': {
      const note = findNoteByLastList(action.index);
      if (!note) return noteNotFoundReply();
      data.notes = data.notes.filter((n) => n.id !== note.id);
      saveData(data);
      return client.replyMessage(event.replyToken, { type: 'text', text: `ลบบันทึกแล้ว: "${note.text}"` });
    }

    case 'editNote': {
      const note = findNoteByLastList(action.index);
      if (!note) return noteNotFoundReply();
      const oldText = note.text;
      note.text = action.text;
      saveData(data);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `แก้ไขบันทึกแล้ว: "${oldText}" → "${note.text}"`,
      });
    }

    case 'monthError': {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'ไม่เข้าใจชื่อเดือนครับ ลองพิมพ์เป็นเลข 1-12 เช่น "เดือน 8 ซื้อของขวัญ" หรือชื่อเดือนเต็ม เช่น "เดือน สิงหาคม ซื้อของขวัญ"',
      });
    }

    case 'addToMonth': {
      const task = { id: newId(), text: action.text, status: action.status, monthKey: action.monthKey, order: Date.now() };
      data.tasks.push(task);
      saveData(data);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `✅ เพิ่มงานแล้ว: "${task.text}"\nหมวด: ${STATUS_LABEL[task.status]} (${monthLabel(task.monthKey)})`,
      });
    }

    case 'addDefault':
    default: {
      const task = { id: newId(), text: action.text, status: 'pending', monthKey: curKey, order: Date.now() };
      data.tasks.push(task);
      saveData(data);
      let replyText = `✅ เพิ่มงานแล้ว: "${task.text}"\nหมวด: ค้าง (${monthLabel(curKey)})`;
      if (action.debugHex) {
        replyText += `\n\n🔧 ข้อความนี้ขึ้นต้นคล้ายคำสั่งแต่จับไม่ได้ รหัสตัวอักษร (ส่งภาพนี้ให้ผู้ดูแลดูได้):\n${action.debugHex}`;
      }
      return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
    }
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/tasks', (req, res) => {
  res.json(loadData().tasks);
});

app.post('/api/tasks', (req, res) => {
  const { text, status, monthKey } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });
  const data = loadData();
  const task = {
    id: newId(),
    text: text.trim(),
    status: status || 'pending',
    monthKey: monthKey || currentMonthKey(),
    order: Date.now(),
  };
  data.tasks.push(task);
  saveData(data);
  res.json(task);
});

app.patch('/api/tasks/:id', (req, res) => {
  const data = loadData();
  const task = data.tasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  if (req.body.status) task.status = req.body.status;
  if (req.body.text) task.text = req.body.text;
  if ('deadline' in req.body) task.deadline = req.body.deadline || null;
  if ('note' in req.body) task.note = req.body.note || null;
  if ('carryOver' in req.body) task.carryOver = !!req.body.carryOver;
  if ('recurring' in req.body) {
    task.recurring = !!req.body.recurring;
    if (task.recurring && !task.recurringId) task.recurringId = task.id;
  }
  saveData(data);
  res.json(task);
});

app.delete('/api/tasks/:id', (req, res) => {
  const data = loadData();
  data.tasks = data.tasks.filter((t) => t.id !== req.params.id);
  saveData(data);
  res.json({ ok: true });
});

app.post('/api/tasks/reorder', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  const data = loadData();
  ids.forEach((id, idx) => {
    const t = data.tasks.find((t) => t.id === id);
    if (t) t.order = idx;
  });
  saveData(data);
  res.json({ ok: true });
});

app.get('/api/export', (req, res) => {
  const mKey = req.query.month || currentMonthKey();
  const data = loadData();
  const monthTasks = data.tasks.filter((t) => t.monthKey === mKey);
  const escapeCsv = (s) => `"${String(s || '').replace(/"/g, '""')}"`;
  const header = ['ลำดับ', 'ชื่องาน', 'สถานะ', 'วันครบกำหนด'].map(escapeCsv).join(',');
  const rows = monthTasks.map((t, i) =>
    [i + 1, t.text, STATUS_LABEL[t.status], t.deadline || ''].map(escapeCsv).join(',')
  );
  const csv = '\uFEFF' + [header, ...rows].join('\r\n'); // BOM ช่วยให้ Excel อ่านภาษาไทยถูกต้อง
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="tasks-${mKey}.csv"`);
  res.send(csv);
});

app.get('/api/notes', (req, res) => {
  res.json(sortNotes(loadData().notes));
});

app.post('/api/notes', (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });
  const data = loadData();
  const note = { id: newId(), text: text.trim(), createdAt: Date.now(), order: Date.now() };
  data.notes.push(note);
  saveData(data);
  res.json(note);
});

app.post('/api/notes/reorder', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  const data = loadData();
  ids.forEach((id, idx) => {
    const n = data.notes.find((n) => n.id === id);
    if (n) n.order = idx;
  });
  saveData(data);
  res.json({ ok: true });
});

app.delete('/api/notes/:id', (req, res) => {
  const data = loadData();
  data.notes = data.notes.filter((n) => n.id !== req.params.id);
  saveData(data);
  res.json({ ok: true });
});

app.patch('/api/notes/:id', (req, res) => {
  const data = loadData();
  const note = data.notes.find((n) => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: 'not found' });
  if (req.body.text) note.text = req.body.text;
  saveData(data);
  res.json(note);
});

app.get('/api/version', (req, res) => {
  res.json({ version: BUILD_VERSION });
});

app.get('/api/status', (req, res) => {
  res.json({ lineConnected: !!loadData().lineUserId });
});

// ทดสอบส่งแจ้งเตือนด้วยมือ (เรียกจากหน้าเว็บหรือ curl)
app.post('/api/notify-test', async (req, res) => {
  try {
    await sendReminder();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------- แจ้งเตือนประจำวัน ----------------
async function sendReminder() {
  const data = loadData();
  if (!data.lineUserId) return;
  const mKey = currentMonthKey();
  const pending = data.tasks.filter((t) => t.monthKey === mKey && t.status === 'pending');
  const doing = data.tasks.filter((t) => t.monthKey === mKey && t.status === 'doing');

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const tomorrowStr = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const dueSoon = data.tasks.filter(
    (t) => t.status !== 'done' && t.deadline && (t.deadline === todayStr || t.deadline === tomorrowStr)
  );

  const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeftInMonth = lastDayOfMonth - now.getDate();
  const isNearMonthEnd = daysLeftInMonth <= 3;
  const unfinishedThisMonth = pending.length + doing.length;

  if (pending.length === 0 && doing.length === 0 && dueSoon.length === 0 && !(isNearMonthEnd && unfinishedThisMonth > 0)) {
    return;
  }

  let text = `📋 สรุปงาน — ${monthLabel(mKey)}\nค้าง ${pending.length} | กำลังทำ ${doing.length}\n\n`;
  pending.slice(0, 10).forEach((t, i) => {
    text += `${i + 1}. ${t.text}\n`;
  });
  if (pending.length > 10) text += `...และอีก ${pending.length - 10} งาน\n`;

  if (dueSoon.length > 0) {
    text += `\n⏰ ใกล้ครบกำหนด:\n`;
    dueSoon.forEach((t) => {
      const label = t.deadline === todayStr ? 'วันนี้' : 'พรุ่งนี้';
      text += `• ${t.text} (${label})\n`;
    });
  }

  if (isNearMonthEnd && unfinishedThisMonth > 0) {
    text += `\n⚠️ อีก ${daysLeftInMonth} วันจะขึ้นเดือนใหม่ ยังมีงานค้าง+กำลังทำรวม ${unfinishedThisMonth} ชิ้นในเดือนนี้\n`;
  }

  await client.pushMessage(data.lineUserId, { type: 'text', text: text.trim() });
}

// ---------------- เลื่อนงานไม่เสร็จข้ามเดือน + สร้างงานประจำใหม่ ----------------
function runMonthCarryOver() {
  const data = loadData();
  const curKey = currentMonthKey();
  const prevKey = shiftMonthKey(curKey, -1);
  let movedCount = 0;
  data.tasks.forEach((t) => {
    if (t.monthKey === prevKey && t.status !== 'done' && t.carryOver) {
      t.monthKey = curKey;
      t.order = Date.now();
      movedCount++;
    }
  });
  if (movedCount > 0) saveData(data);
  return movedCount;
}

function runRecurringGeneration() {
  const data = loadData();
  const curKey = currentMonthKey();
  const groups = {};
  data.tasks.forEach((t) => {
    if (t.recurring) {
      const rid = t.recurringId || t.id;
      if (!groups[rid]) groups[rid] = [];
      groups[rid].push(t);
    }
  });
  let createdCount = 0;
  Object.keys(groups).forEach((rid) => {
    const group = groups[rid];
    const alreadyThisMonth = group.some((t) => t.monthKey === curKey);
    if (!alreadyThisMonth) {
      const template = group.slice().sort((a, b) => (a.monthKey || '').localeCompare(b.monthKey || ''))[group.length - 1] || group[0];
      data.tasks.push({
        id: newId(),
        text: template.text,
        status: 'pending',
        monthKey: curKey,
        order: Date.now(),
        recurring: true,
        recurringId: rid,
      });
      createdCount++;
    }
  });
  if (createdCount > 0) saveData(data);
  return createdCount;
}

app.post('/api/carryover-test', (req, res) => {
  const moved = runMonthCarryOver();
  const created = runRecurringGeneration();
  res.json({ moved, created });
});

// วันที่ 1 ของทุกเดือน เวลา 00:05 เวลาไทย: เลื่อนงานค้าง + สร้างงานประจำใหม่
cron.schedule('5 0 1 * *', async () => {
  try {
    const moved = runMonthCarryOver();
    const created = runRecurringGeneration();
    if (moved > 0 || created > 0) {
      const data = loadData();
      if (data.lineUserId) {
        const parts = [];
        if (moved > 0) parts.push(`เลื่อนงานที่ยังไม่เสร็จมาเดือนนี้ ${moved} ชิ้น`);
        if (created > 0) parts.push(`สร้างงานประจำใหม่ ${created} ชิ้น`);
        await client.pushMessage(data.lineUserId, {
          type: 'text',
          text: `🔁 อัปเดตต้นเดือนอัตโนมัติ: ${parts.join(' และ ')}`,
        });
      }
    }
  } catch (err) {
    console.error(err);
  }
}, { timezone: 'Asia/Bangkok' });

// ---------------- สำรองข้อมูล ----------------
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

function runDailyBackup() {
  if (!fs.existsSync(DATA_FILE)) return;
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);
  const dateStr = new Date().toISOString().slice(0, 10);
  fs.copyFileSync(DATA_FILE, path.join(BACKUP_DIR, `data-${dateStr}.json`));
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('data-')).sort();
  while (files.length > 14) {
    fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  }
}

app.get('/api/backup/download', (req, res) => {
  if (!fs.existsSync(DATA_FILE)) return res.status(404).json({ error: 'no data yet' });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="backup-${new Date().toISOString().slice(0, 10)}.json"`);
  fs.createReadStream(DATA_FILE).pipe(res);
});

// ทุกวันตี 00:30 เวลาไทย: สำรองข้อมูลไว้ 14 วันล่าสุด
cron.schedule('30 0 * * *', () => {
  try { runDailyBackup(); } catch (err) { console.error(err); }
}, { timezone: 'Asia/Bangkok' });

// ทุกวัน 08:00 เวลาไทย
cron.schedule('0 8 * * *', () => {
  sendReminder().catch(console.error);
}, { timezone: 'Asia/Bangkok' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
