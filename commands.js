// commands.js — ตีความข้อความ LINE เป็น "action" ล้วนๆ ไม่มีผลข้างเคียง (ไม่แตะไฟล์/เครือข่าย)
// แยกออกมาต่างหากเพื่อให้เขียนชุดทดสอบอัตโนมัติได้ตรงไปตรงมา

const THAI_MONTHS_FULL = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];
const THAI_MONTHS_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const STATUS_LABEL = { pending: "ค้าง", doing: "กำลังทำ", done: "เสร็จแล้ว" };
const STATUS_ORDER = ["pending", "doing", "done"];
const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";

// คำขึ้นต้นคำสั่งทั้งหมด — ใช้เช็คว่าข้อความที่ตกไป addDefault "ดูคล้าย" คำสั่งไหม (เผื่อพิมพ์เกือบถูกแต่มีจุดต่างที่มองไม่เห็น)
const COMMAND_KEYWORDS = ['รายการ', 'ทำ', 'ย้อน', 'ลบ', 'แก้ไข', 'กำหนด', 'เลื่อน', 'ประจำ', 'โน้ต', 'ดู', 'จด', 'เดือน'];

// แปลงข้อความเป็นรหัส Unicode (hex) ทีละตัวอักษร — ใช้ตอนดีบักเทียบว่าตัวอักษรที่พิมพ์มาจริงๆ ตรงกับที่คาดไว้ไหม
function toHexDump(str) {
  return [...str].map((ch) => ch.codePointAt(0).toString(16).toUpperCase()).join(' ');
}

// ปรับข้อความภาษาไทยให้เป็นรูปแบบมาตรฐานเดียวกัน ก่อนนำไปเทียบ/แยกคำสั่ง
// - .normalize('NFC') มาตรฐาน Unicode (ไม่ครอบคลุมสระอำภาษาไทย)
// - แปลงนิคหิต+สระอา (โค้ดคนละตัวที่บางคีย์บอร์ดพิมพ์) ให้เป็นสระอำตัวเดียว
// - แปลงสระเอซ้ำ 2 ตัว (เ+เ) ให้เป็นสระแอตัวเดียว (แ) — มองเหมือนกันทุกฟอนต์แต่คนละรหัส สาเหตุจริงที่ทำให้ "แก้ไข" จับไม่ได้
// - แปลงเลขไทย ๐-๙ เป็นเลขอารบิก
// - แปลง "โน๊ต" (ไม้ตรี) ให้เป็น "โน้ต" (ไม้โท) — คนละรหัสแต่คนไทยใช้สะกดคำว่า note สลับกันทั้งคู่
// - ลบอักขระควบคุมที่มองไม่เห็นทั้งหมด (Unicode category Cf: zero-width space/joiner, ตัวกำหนดทิศทางเขียน LRM/RLM,
//   BOM ฯลฯ) ที่คอมพิวเตอร์/เบราว์เซอร์/คีย์บอร์ดบางตัวแอบแทรกมาโดยมองไม่เห็นด้วยตาเปล่า
// - แปลงช่องว่างชนิดพิเศษ (non-breaking space ฯลฯ) ให้เป็นช่องว่างปกติ แล้ว trim อีกรอบ
function normalizeThai(str) {
  let s = String(str).normalize('NFC').replace(/\u0E4D\u0E32/g, '\u0E33');
  s = s.replace(/\u0E40\u0E40/g, '\u0E41');
  s = s.replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)));
  s = s.replace(/โน๊ต/g, 'โน้ต');
  s = s.replace(/\p{Cf}/gu, '');
  s = s.replace(/[\u00A0\u202F]/g, ' ');
  return s.trim();
}

// token: ตัวเลข 1-12 หรือชื่อเดือนไทย (เต็ม/ย่อ) → คืนค่า "YYYY-MM" ของปีอ้างอิง (default ปีปัจจุบัน)
function parseMonthToken(token, refDate) {
  const year = (refDate || new Date()).getFullYear();
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

// ตีความข้อความดิบจาก LINE ให้เป็น action object ล้วนๆ
// refDate: ใช้กำหนด "ปีปัจจุบัน" ตอนแปลงชื่อเดือน (ส่งเข้ามาเพื่อให้ทดสอบ deterministic ได้)
function parseCommand(rawText, refDate) {
  const text = normalizeThai(String(rawText).trim());

  if (text === 'คำสั่ง' || text === 'เมนู' || text.toLowerCase() === 'help') {
    return { type: 'help' };
  }

  if (text === 'รายการ' || text.toLowerCase() === 'list') {
    return { type: 'list', monthKey: null }; // null = ใช้เดือนปัจจุบัน
  }

  let m = text.match(/^รายการ\s*(\d{1,2})$/) || text.match(/^รายการ\s+(\S+)$/);
  if (m) {
    const mKey = parseMonthToken(m[1], refDate);
    if (!mKey) return { type: 'listMonthError' };
    return { type: 'list', monthKey: mKey };
  }

  m = text.match(/^(ทำ|ย้อน)\s+(\d+)$/);
  if (m) {
    return { type: 'move', dir: m[1] === 'ทำ' ? 1 : -1, index: parseInt(m[2], 10) - 1 };
  }

  m = text.match(/^ลบ\s+(\d+)$/);
  if (m) {
    return { type: 'delete', index: parseInt(m[1], 10) - 1 };
  }

  m = text.match(/^แก้ไข\s+(\d+)\s+(.+)$/s);
  if (m) {
    return { type: 'edit', index: parseInt(m[1], 10) - 1, text: m[2].trim() };
  }

  m = text.match(/^กำหนด\s+(\d+)\s+(\d{4}-\d{2}-\d{2})$/);
  if (m) {
    return { type: 'deadline', index: parseInt(m[1], 10) - 1, date: m[2] };
  }

  m = text.match(/^เลื่อน\s+(\d+)$/);
  if (m) {
    return { type: 'toggleCarry', index: parseInt(m[1], 10) - 1 };
  }

  m = text.match(/^ประจำ\s+(\d+)$/);
  if (m) {
    return { type: 'toggleRecurring', index: parseInt(m[1], 10) - 1 };
  }

  // ----- โน้ตแนบในงาน (ผูกกับงานที่มีเลขจากรายการล่าสุด) -----
  // \s* ระหว่างคำ เผื่อคีย์บอร์ดมือถือแทรกช่องว่างให้เองตอน autocomplete เช่น "โน้ต งาน"
  m = text.match(/^โน้ต\s*งาน\s+(\d+)\s+(.+)$/s);
  if (m) {
    return { type: 'taskNote', index: parseInt(m[1], 10) - 1, text: m[2].trim() };
  }
  m = text.match(/^ลบ\s*โน้ต\s*งาน\s+(\d+)$/);
  if (m) {
    return { type: 'clearTaskNote', index: parseInt(m[1], 10) - 1 };
  }

  // ----- สมุดบันทึกทั่วไป (ไม่ผูกกับงานไหน) -----
  if (/^ดู\s*โน้ต$/.test(text)) {
    return { type: 'listNotes' };
  }
  m = text.match(/^ลบ\s*โน้ต\s+(\d+)$/);
  if (m) {
    return { type: 'deleteNote', index: parseInt(m[1], 10) - 1 };
  }
  m = text.match(/^แก้ไข\s*โน้ต\s+(\d+)\s+(.+)$/s);
  if (m) {
    return { type: 'editNote', index: parseInt(m[1], 10) - 1, text: m[2].trim() };
  }
  m = text.match(/^จด\s+(.+)$/s);
  if (m) {
    return { type: 'addNote', text: m[1].trim() };
  }

  // "เดือน X ข้อความ" หรือ "เดือน X สถานะ ข้อความ" — X = เลข 1-12 (เว้นวรรคหรือไม่ก็ได้) หรือชื่อเดือน (ต้องเว้นวรรค)
  m = text.match(/^เดือน\s*(\d{1,2})\s+(.+)$/s) || text.match(/^เดือน\s+(\S+)\s+(.+)$/s);
  if (m) {
    const mKey = parseMonthToken(m[1], refDate);
    if (!mKey) return { type: 'monthError' };
    let rest = m[2].trim();
    let status = 'pending';
    const statusMatch = rest.match(/^["']?(ค้าง|กำลังทำ|เสร็จแล้ว|เสร็จ)["']?\s+(.+)$/s);
    if (statusMatch) {
      const word = statusMatch[1];
      status = word === 'ค้าง' ? 'pending' : word === 'กำลังทำ' ? 'doing' : 'done';
      rest = statusMatch[2].trim();
    }
    return { type: 'addToMonth', monthKey: mKey, status, text: rest };
  }

  const looksLikeCommand = COMMAND_KEYWORDS.some((kw) => text.startsWith(kw));
  return {
    type: 'addDefault',
    text,
    debugHex: looksLikeCommand ? toHexDump(text.slice(0, 24)) : null,
  };
}

module.exports = {
  THAI_MONTHS_FULL,
  THAI_MONTHS_SHORT,
  STATUS_LABEL,
  STATUS_ORDER,
  normalizeThai,
  parseMonthToken,
  parseCommand,
};
