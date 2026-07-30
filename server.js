require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const DATA_FILE = path.join(__dirname, 'data.json');

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(lineConfig);
const app = express();

const THAI_MONTHS_FULL = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];
const THAI_MONTHS_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const STATUS_LABEL = { pending: "ค้าง", doing: "กำลังทำ", done: "เสร็จแล้ว" };
const STATUS_ORDER = ["pending", "doing", "done"];

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { tasks: [], lineUserId: null, lastList: [] };
  }
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!d.lastList) d.lastList = [];
    return d;
  } catch (e) {
    return { tasks: [], lineUserId: null, lastList: [] };
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

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// พยายามแปลงคำที่พิมพ์มา (ตัวเลข 1-12 หรือชื่อเดือนไทย) ให้เป็น monthKey ของปีปัจจุบัน
function parseMonthToken(token) {
  const now = new Date();
  const year = now.getFullYear();
  const n = parseInt(token, 10);
  if (!isNaN(n) && n >= 1 && n <= 12) {
    return year + "-" + String(n).padStart(2, "0");
  }
  const idxFull = THAI_MONTHS_FULL.findIndex((m) => token.startsWith(m) || m.startsWith(token));
  if (idxFull !== -1) return year + "-" + String(idxFull + 1).padStart(2, "0");
  const idxShort = THAI_MONTHS_SHORT.findIndex((m) => token.replace(/\./g, "") === m.replace(/\./g, ""));
  if (idxShort !== -1) return year + "-" + String(idxShort + 1).padStart(2, "0");
  return null;
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

// ---------------- LINE webhook ----------------
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  Promise.all(req.body.events.map(handleLineEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

async function handleLineEvent(event) {
  const data = loadData();

  if (event.source && event.source.userId && !data.lineUserId) {
    data.lineUserId = event.source.userId;
    saveData(data);
  }

  if (event.type === 'follow') {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text:
        'สวัสดีครับ 👋 นี่คือคำสั่งที่ใช้ได้:\n\n' +
        '• พิมพ์ข้อความอะไรก็ได้ → เพิ่มเป็นงาน "ค้าง" ของเดือนนี้\n' +
        '• "เดือน 8 ซื้อของขวัญ" → เพิ่มงานค้างลงเดือนสิงหาคม (ใช้เลข 1-12 หรือชื่อเดือนก็ได้)\n' +
        '• "เดือน 8 กำลังทำ ซื้อของขวัญ" → เพิ่มงานลงเดือนสิงหาคม พร้อมระบุหมวดเลย (ค้าง / กำลังทำ / เสร็จแล้ว)\n' +
        '• "รายการ" → ดูรายการงานของเดือนนี้ พร้อมเลขกำกับ\n' +
        '• "ทำ 2" → ขยับสถานะงานหมายเลข 2 ไปข้างหน้า\n' +
        '• "ย้อน 2" → ขยับสถานะงานหมายเลข 2 ย้อนกลับ\n' +
        '• "ลบ 2" → ลบงานหมายเลข 2\n\n' +
        '(เลขที่ใช้อ้างอิงจะยึดตามรายการล่าสุดที่พิมพ์ "รายการ" ออกมาดูก่อนเสมอ)',
    });
  }

  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const text = event.message.text.trim();
  const curKey = currentMonthKey();

  // ----- "รายการ" : แสดงรายการงานของเดือนนี้ พร้อมจำลำดับไว้ใช้อ้างอิง -----
  if (text === 'รายการ' || text.toLowerCase() === 'list') {
    const monthTasks = data.tasks.filter((t) => t.monthKey === curKey);
    data.lastList = monthTasks.map((t) => t.id);
    saveData(data);
    return client.replyMessage(event.replyToken, { type: 'text', text: formatTaskList(monthTasks, curKey) });
  }

  // ----- "ทำ N" / "ย้อน N" : ขยับสถานะ -----
  let m = text.match(/^(ทำ|ย้อน)\s+(\d+)$/);
  if (m) {
    const dir = m[1] === 'ทำ' ? 1 : -1;
    const idx = parseInt(m[2], 10) - 1;
    const taskId = data.lastList[idx];
    const task = data.tasks.find((t) => t.id === taskId);
    if (!task) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'ไม่พบงานหมายเลขนี้ครับ ลองพิมพ์ "รายการ" เพื่อดูเลขล่าสุดก่อนนะครับ',
      });
    }
    const newIdx = STATUS_ORDER.indexOf(task.status) + dir;
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

  // ----- "ลบ N" : ลบงาน -----
  m = text.match(/^ลบ\s+(\d+)$/);
  if (m) {
    const idx = parseInt(m[1], 10) - 1;
    const taskId = data.lastList[idx];
    const task = data.tasks.find((t) => t.id === taskId);
    if (!task) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'ไม่พบงานหมายเลขนี้ครับ ลองพิมพ์ "รายการ" เพื่อดูเลขล่าสุดก่อนนะครับ',
      });
    }
    data.tasks = data.tasks.filter((t) => t.id !== taskId);
    saveData(data);
    return client.replyMessage(event.replyToken, { type: 'text', text: `ลบแล้ว: "${task.text}"` });
  }

  // ----- "เดือน X ข้อความ" หรือ "เดือน X สถานะ ข้อความ" : เพิ่มงานลงเดือนอื่น -----
  m = text.match(/^เดือน\s+(\S+)\s+(.+)$/s);
  if (m) {
    const mKey = parseMonthToken(m[1]);
    let rest = m[2].trim();
    if (!mKey) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'ไม่เข้าใจชื่อเดือนครับ ลองพิมพ์เป็นเลข 1-12 เช่น "เดือน 8 ซื้อของขวัญ" หรือชื่อเดือนเต็ม เช่น "เดือน สิงหาคม ซื้อของขวัญ"',
      });
    }
    let status = 'pending';
    const statusMatch = rest.match(/^["']?(ค้าง|กำลังทำ|เสร็จแล้ว|เสร็จ)["']?\s+(.+)$/s);
    if (statusMatch) {
      const word = statusMatch[1];
      status = word === 'ค้าง' ? 'pending' : word === 'กำลังทำ' ? 'doing' : 'done';
      rest = statusMatch[2].trim();
    }
    const task = { id: newId(), text: rest, status, monthKey: mKey };
    data.tasks.push(task);
    saveData(data);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `✅ เพิ่มงานแล้ว: "${rest}"\nหมวด: ${STATUS_LABEL[status]} (${monthLabel(mKey)})`,
    });
  }

  // ----- ข้อความอื่นๆ ทั้งหมด: เพิ่มเป็นงานค้างใหม่ของเดือนปัจจุบัน -----
  const task = { id: newId(), text, status: 'pending', monthKey: curKey };
  data.tasks.push(task);
  saveData(data);

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `✅ เพิ่มงานแล้ว: "${text}"\nหมวด: ค้าง (${monthLabel(curKey)})`,
  });
}

// ---------------- REST API for the web dashboard ----------------
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
  saveData(data);
  res.json(task);
});

app.delete('/api/tasks/:id', (req, res) => {
  const data = loadData();
  data.tasks = data.tasks.filter((t) => t.id !== req.params.id);
  saveData(data);
  res.json({ ok: true });
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
  if (pending.length === 0 && doing.length === 0) return;

  let text = `📋 สรุปงาน — ${monthLabel(mKey)}\nค้าง ${pending.length} | กำลังทำ ${doing.length}\n\n`;
  pending.slice(0, 10).forEach((t, i) => {
    text += `${i + 1}. ${t.text}\n`;
  });
  if (pending.length > 10) text += `...และอีก ${pending.length - 10} งาน\n`;

  await client.pushMessage(data.lineUserId, { type: 'text', text: text.trim() });
}

// ทุกวัน 08:00 เวลาไทย
cron.schedule('0 8 * * *', () => {
  sendReminder().catch(console.error);
}, { timezone: 'Asia/Bangkok' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
