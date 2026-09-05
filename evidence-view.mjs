export const sources = Object.freeze({
  pubmed: Object.freeze({ label: 'PubMed', description: 'บทความวิจัยและรายการอ้างอิงทางชีวการแพทย์', example: 'Curcuma longa' }),
  clinicaltrials: Object.freeze({ label: 'ClinicalTrials.gov', description: 'ทะเบียนการศึกษาทางคลินิก สถานะทะเบียนไม่ใช่ข้อสรุปว่าการรักษาได้ผล', example: 'curcumin' }),
  dailymed: Object.freeze({ label: 'DailyMed', description: 'ฉลากยาในสหรัฐฯ ต้องตรวจสอบการขึ้นทะเบียนและแนวทางใช้ยาในประเทศไทยเพิ่มเติม', example: 'acetaminophen' })
});

export function referenceUrl(source, id) {
  if (typeof id !== 'string') return null;
  if (source === 'pubmed' && /^[1-9]\d{0,9}$/.test(id)) return `https://pubmed.ncbi.nlm.nih.gov/${id}/`;
  if (source === 'clinicaltrials' && /^NCT\d{8}$/.test(id)) return `https://clinicaltrials.gov/study/${id}`;
  if (source === 'dailymed' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${id}`;
  return null;
}

export function normalizeResults(payload, source) {
  if (!Object.hasOwn(sources, source) || payload?.ok !== true || payload.source !== source || !Array.isArray(payload.results)) throw new Error('INVALID_RESULTS');
  return payload.results.slice(0, 5).flatMap(row => {
    const url = referenceUrl(source, row?.id);
    if (!url || typeof row.title !== 'string' || !row.title.trim()) return [];
    return [{ id: row.id, url, title: row.title.slice(0, 1000), date: typeof row.date === 'string' ? row.date.slice(0, 80) : '', detail: typeof row.detail === 'string' ? row.detail.slice(0, 1200) : '' }];
  });
}

export function publicMessage(status, code) {
  if (code === 'EVIDENCE_PUBMED_DISABLED') return 'การค้น PubMed ในระบบยังไม่เปิด กรุณาใช้ลิงก์ค้นที่เว็บไซต์ PubMed ด้านล่าง';
  if (status === 401) return 'กรุณาเข้าสู่ระบบใหม่ แล้วลองค้นอีกครั้ง';
  if (status === 403) return 'บัญชีหรือคลินิกนี้ไม่มีสิทธิ์ค้นในขณะนี้ กรุณาติดต่อผู้ดูแล';
  if (status === 429) return 'มีการค้นถี่เกินไป กรุณารอสักครู่แล้วลองใหม่';
  if (status === 400 || status === 413) return 'กรุณาใช้คำค้นทั่วไป 2–160 ตัวอักษร และไม่ใส่ข้อมูลระบุตัวผู้ป่วย';
  if (status === 503 || /DISABLED|CONFIG|ENVIRONMENT/.test(String(code || ''))) return 'บริการค้นแหล่งอ้างอิงยังไม่เปิดสำหรับระบบนี้';
  return 'ไม่สามารถอ่านแหล่งอ้างอิงได้ในขณะนี้ กรุณาลองใหม่ภายหลัง';
}
