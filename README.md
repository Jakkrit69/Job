# สมุดงานรายเดือน + เชื่อมต่อ LINE

แอปนี้ทำ 2 อย่างตามที่ต้องการ:
1. **พิมพ์ข้อความใน LINE → เพิ่มงานเข้าสมุดอัตโนมัติ** (เป็นสถานะ "ค้าง" ของเดือนปัจจุบัน)
2. **แจ้งเตือนสรุปงานค้างเข้า LINE ทุกวัน 08:00 น.** (เวลาไทย)

เว็บ dashboard (`public/index.html`) กับ LINE bot ใช้ข้อมูลชุดเดียวกัน (ไฟล์ `data.json` บนเซิร์ฟเวอร์) — เพิ่ม/ย้าย/ลบงานจากฝั่งไหนก็เห็นเหมือนกันทั้งคู่

⚠️ **ทำไมต้องมีเซิร์ฟเวอร์แยก**: LINE ต้องส่ง webhook มาหาที่อยู่ที่เปิดรับตลอดเวลาได้ และต้องเก็บ Channel Access Token ที่เป็นความลับไว้ฝั่งเซิร์ฟเวอร์เท่านั้น หน้าเว็บที่รันในเบราว์เซอร์อย่างเดียวทำแบบนี้ไม่ได้ครับ

---

## ขั้นตอนที่ 1 — สร้าง LINE Official Account (Messaging API)

1. ไปที่ https://developers.line.biz/console/ แล้วล็อกอินด้วยบัญชี LINE
2. สร้าง **Provider** ใหม่ (ตั้งชื่ออะไรก็ได้)
3. ในนั้นสร้าง **Channel** ประเภท **Messaging API**
4. เข้าไปที่แท็บ **Basic settings** → คัดลอกค่า **Channel secret**
5. เข้าไปที่แท็บ **Messaging API** → กด **Issue** เพื่อสร้าง **Channel access token (long-lived)** แล้วคัดลอกไว้
6. ในหน้าเดียวกัน ปิด **Auto-reply messages** และ **Greeting messages** (ในเมนู LINE Official Account Manager → Response settings) เพื่อไม่ให้ชนกับบอทของเรา ส่วน **Webhook** ให้เปิด (Use webhook = On) — ยังใส่ URL ไม่ได้จนกว่าจะ deploy เสร็จ (ขั้นตอนที่ 3)

## ขั้นตอนที่ 2 — ติดตั้งและรันในเครื่องก่อน (ทดสอบ)

```bash
cd line-task-tracker
npm install
cp .env.example .env
# เปิด .env แล้วใส่ LINE_CHANNEL_ACCESS_TOKEN กับ LINE_CHANNEL_SECRET ที่คัดลอกมา
npm start
```

เปิด `http://localhost:3000` จะเห็นหน้าสมุดงาน (ตอนนี้ webhook ยังเชื่อมไม่ได้เพราะ LINE ต้องยิงเข้า URL ที่เข้าถึงจากอินเทอร์เน็ตได้จริง)

## ขั้นตอนที่ 3 — Deploy ขึ้นเซิร์ฟเวอร์จริง

เลือกอันใดอันหนึ่ง (มี free tier ทั้งคู่):

**Railway** (https://railway.app) — แนะนำเพราะมี persistent disk ให้ `data.json` ไม่หายเวลา deploy ใหม่
1. สร้างโปรเจกต์ใหม่ → Deploy from GitHub repo (หรือ Empty project แล้วอัปโหลดโค้ด)
2. ใส่ Environment Variables: `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`
3. Railway จะให้ URL แบบ `https://your-app.up.railway.app`

**Render** (https://render.com)
1. New → Web Service → เชื่อม repo
2. Build command: `npm install` / Start command: `npm start`
3. ใส่ Environment Variables เหมือนด้านบน
4. ถ้าต้องการให้ `data.json` ไม่หายตอน redeploy ให้เพิ่ม **Persistent Disk** mount ที่ path เดียวกับโปรเจกต์ (มีค่าใช้จ่ายเพิ่มเล็กน้อย) — ถ้าไม่เพิ่ม ข้อมูลจะรีเซ็ตทุกครั้งที่ deploy ใหม่

## ขั้นตอนที่ 4 — ผูก Webhook

1. กลับไปที่ LINE Developers Console → แท็บ Messaging API
2. ใส่ **Webhook URL** เป็น `https://<โดเมนที่ deploy ได้>/webhook`
3. กด **Verify** ให้ขึ้นสถานะ Success
4. สแกน QR code เพิ่มบอทเป็นเพื่อนในแอป LINE ของคุณ
5. พิมพ์ข้อความอะไรก็ได้ 1 ครั้ง — ระบบจะจำ userId ของคุณไว้อัตโนมัติ (ใช้สำหรับส่งแจ้งเตือน) และเพิ่มข้อความนั้นเป็นงานค้างทันที

## วิธีใช้ผ่าน LINE

- พิมพ์ข้อความอะไรก็ได้ → เพิ่มเป็นงาน "ค้าง" ของเดือนปัจจุบัน พร้อมข้อความยืนยัน
- พิมพ์ **"รายการ"** → บอทตอบกลับรายการงานค้าง/กำลังทำของเดือนนี้
- ทุกวัน 08:00 น. บอทจะส่งสรุปงานค้าง+กำลังทำของเดือนนี้มาให้อัตโนมัติ

## ทดสอบการแจ้งเตือนโดยไม่ต้องรอถึง 08:00

```bash
curl -X POST https://<โดเมนของคุณ>/api/notify-test
```

## ปรับแต่งเพิ่มเติม

- เปลี่ยนเวลาแจ้งเตือน: แก้บรรทัด `cron.schedule('0 8 * * *', ...)` ใน `server.js` (รูปแบบ cron: นาที ชั่วโมง วัน เดือน วันในสัปดาห์)
- ย้ายสถานะงาน (ค้าง → กำลังทำ → เสร็จแล้ว) หรือลบงาน ให้ทำผ่านหน้าเว็บ dashboard — ฝั่ง LINE รองรับแค่เพิ่มงานกับดูรายการ
