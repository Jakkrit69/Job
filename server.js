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
const STATUS_LABEL = { pending: "ค้าง", doing: "กำลังทำ", done: "เสร็จแล้ว" };

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { tasks: [], lineUserId: null };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return { tasks: [], lineUserId: null };
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

// ---------------- LINE webhook ----------------
// NOTE: must come before express.json() because line.middleware needs the raw body
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
        'สวัสดีครับ 👋 พิมพ์ข้อความอะไรก็ได้ ผมจะเพิ่มเป็นงาน "ค้าง" ให้ในสมุดงานเดือนนี้ทันที\n' +
        'พิมพ์ "รายการ" เพื่อดูงานค้างของเดือนนี้',
    });
  }

  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const text = event.message.text.trim();

  if (text === 'รายการ' || text.toLowerCase() === 'list') {
    const mKey = currentMonthKey();
    const pending = data.tasks.filter((t) => t.monthKey === mKey && t.status !== 'done');
    if (pending.length === 0) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `ไม่มีงานค้างในเดือน${monthLabel(mKey)}แล้วครับ 🎉`,
      });
    }
    const lines = pending
      .map((t, i) => `${i + 1}. [${STATUS_LABEL[t.status]}] ${t.text}`)
      .join('\n');
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `งานค้าง — ${monthLabel(mKey)}\n${lines}`,
    });
  }

  // ข้อความอื่นๆ ทั้งหมด: เพิ่มเป็นงานค้างใหม่ของเดือนปัจจุบัน
  const mKey = currentMonthKey();
  const task = { id: newId(), text, status: 'pending', monthKey: mKey };
  data.tasks.push(task);
  saveData(data);

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `✅ เพิ่มงานแล้ว: "${text}"\nหมวด: ค้าง (${monthLabel(mKey)})`,
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
