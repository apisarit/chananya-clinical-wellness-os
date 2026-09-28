import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectKnowledgeCandidate, readKnowledgeCandidateFile } from './inspect-knowledge-candidate.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const domainNames = {
  constitution: 'ธาตุเจ้าเรือน', conception_month: 'เดือนปฏิสนธิ', birth_weekday: 'วันเกิด',
  coordinate: 'พิกัด', age_samutthan: 'อายุสมุฏฐาน', kala_samutthan: 'กาลสมุฏฐาน',
  kala_ekadot: 'กาลเอกโทษ', kala_duvandot: 'กาลทุวันโทษ', kala_tridot: 'กาลตรีโทษ',
  season_4: 'ฤดู 4', season_6: 'ฤดู 6', season_pitsadan: 'ฤดูพิสดาร',
  zodiac_samutthan: 'ราศีสมุฏฐาน', pradesa_samutthan: 'ประเทศสมุฏฐาน', food_taste: 'รสอาหาร',
};
const field = (label, value) => `<div><dt>${escape(label)}</dt><dd>${escape(value ?? 'ไม่ได้ระบุในต้นทาง')}</dd></div>`;

export function renderKnowledgeReview(packet) {
  // Recompute from the verified packet, never trust an edited summary report.
  const report = inspectKnowledgeCandidate(packet);
  const groups = new Map();
  for (const row of report.structurallyValidRows) {
    const domain = row.content.domain;
    groups.set(domain, [...(groups.get(domain) || []), row]);
  }
  const navigation = [...groups].map(([domain, rows], index) =>
    `<a href="#domain-${index}">${escape(domainNames[domain] || domain)} <span>${rows.length}</span></a>`).join('');
  const sections = [...groups].map(([domain, rows], index) => `<section id="domain-${index}" class="domain">
    <h2>${escape(domainNames[domain] || domain)} <small>${rows.length} แถว</small></h2>
    ${rows.map(entry => {
      const row = entry.content;
      return `<details class="knowledge-row" id="row-${entry.index}"><summary>
        <span>${escape(row.input_key)}</span><small>${escape(entry.sheet)} · แถว ${entry.row}</small></summary>
        <div class="row-content"><p class="status">ยังไม่ผ่านการทบทวน • ไม่อนุญาตใช้ทางคลินิก</p>
        <h3>ข้อความจากต้นทาง</h3><p class="source-text">${escape(row.output_value)}</p>
        <dl>${field('คำอธิบาย', row.description)}${field('ธาตุ', row.element)}${field('สมุฏฐาน', row.samutthan)}
        ${field('พิกัด', row.coordinate)}${field('แหล่งอ้างอิงที่ต้นทางระบุ — ยังไม่ได้ตรวจต้นฉบับ', row.source_ref)}
        ${field('ประเภทแหล่งข้อมูล', row.source_class)}${field('เวอร์ชันแถว', row.version)}
        ${field('สถานะ active ในต้นทาง — ไม่ใช่การอนุมัติ', row.active ? 'true' : 'false')}</dl>
        <details class="raw"><summary>รายละเอียดครบทุกช่องและรหัสตรวจสอบ</summary>
        <p class="hash">Row SHA256: ${escape(entry.rowSHA256)}</p><pre>${escape(JSON.stringify(row, null, 2))}</pre></details>
        </div></details>`;
    }).join('')}</section>`).join('');
  const problems = report.sourceIssues.length || report.rejectedRows.length
    ? `<section id="problems" class="problems"><h2>รายการที่ต้องแก้ก่อนเสนอ</h2>
      ${report.sourceIssues.length ? `<h3>ปัญหาระดับชุดข้อมูล</h3><ul>${report.sourceIssues.map(issue => `<li>${escape(issue)}</li>`).join('')}</ul>` : ''}
      ${report.rejectedRows.map(row => `<article><h3>${escape(row.sheet || 'ไม่ทราบชีต')} · แถว ${escape(row.row ?? 'ไม่ทราบ')} <small>(ลำดับข้อมูล ${row.index + 1})</small></h3>
        <ul>${row.reasons.map(reason => `<li>${escape(reason)}</li>`).join('')}</ul></article>`).join('')}</section>`
    : '<section id="problems"><h2>ผลตรวจโครงสร้าง</h2><p>ไม่พบแถวที่ถูกปฏิเสธในขอบเขตตัวตรวจนี้ ผลนี้ไม่ยืนยันความถูกต้องของตำราหรือเนื้อหาทางคลินิก</p></section>';
  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer"><title>CNYOS — ชุดข้อมูลเสนอทบทวน</title>
<style>
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#f4f6f3;color:#18382e;font:16px/1.65 system-ui,sans-serif}main{max-width:1060px;margin:auto;padding:32px 24px 64px}h1{font-size:clamp(1.7rem,4vw,2.5rem);line-height:1.3;margin:8px 0 20px}h2{font-size:1.35rem}h3{font-size:1rem}p{margin:8px 0 16px}small,.muted{font-size:.85rem;color:#52675e}.eyebrow{letter-spacing:.12em;font-weight:700;color:#56756a}.notice{border-left:5px solid #a56809;background:#fff2d9;padding:16px 20px;border-radius:8px;color:#664308}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:24px 0}.stat,section,.identity{background:#fff;border:1px solid #d7e1d9;border-radius:12px;padding:20px;margin-bottom:18px}.stat{margin:0}.stat strong{display:block;font-size:1.8rem}.hash,pre,dd{overflow-wrap:anywhere;word-break:break-word}.hash{font:12px/1.7 ui-monospace,monospace;color:#52675e}dl{margin:12px 0}dl>div{margin:12px 0}dt{font-size:.85rem;color:#52675e}dd{margin:2px 0}nav{display:flex;flex-wrap:wrap;gap:8px;margin:20px 0}a{color:#174d3d;min-height:44px;padding:9px 12px;border:1px solid #c6d5ca;border-radius:8px;text-decoration:none;background:white}a span{color:#67776e}summary{cursor:pointer;padding:14px 4px;min-height:44px}summary>span{font-weight:650}summary small{display:block;margin-left:20px}.knowledge-row{border-top:1px solid #e0e7e1}.row-content{padding:0 8px 20px}.status{font-size:.85rem;color:#835b16}.source-text{font-size:1.1rem;white-space:pre-wrap}.raw{background:#f4f6f3;border-radius:8px;padding:0 12px}pre{white-space:pre-wrap;font-size:12px;padding-bottom:16px}.problems{border-color:#d39a83;background:#fff8f4}.problems article{border-top:1px solid #edd7cc;padding-top:8px}.domain{scroll-margin-top:16px}:focus-visible{outline:3px solid #287765;outline-offset:3px}footer{color:#52675e}.file{border-top:1px solid #e0e7e1;padding-top:8px}.skip{position:absolute;left:-9999px}.skip:focus{left:12px;top:12px}ul{padding-left:22px}li{overflow-wrap:anywhere}
@media(max-width:520px){main{padding:22px 14px 40px}.stats{gap:6px}.stat{padding:12px 8px}.stat strong{font-size:1.5rem}section,.identity{padding:16px}nav a{flex:1 1 auto}}
@media print{body{background:white}main{max-width:none;padding:0}nav,.skip{display:none}section,.identity,.stat{break-inside:avoid;border-radius:0}details::details-content{content-visibility:visible}details>div{display:block!important}summary{list-style:none}.notice{border:2px solid #a56809}.raw pre{font-size:10px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
</style></head><body><a class="skip" href="#contents">ข้ามไปเนื้อหา</a><main>
<header><p class="eyebrow">CNYOS / KNOWLEDGE SOURCE REVIEW</p><h1>ชุดข้อมูลเสนอทบทวน</h1>
<div class="notice"><strong>เอกสารอ่านอย่างเดียว — ยังไม่อนุมัติให้เผยแพร่หรือใช้ทางคลินิก</strong>
<p>การตรวจโครงสร้างไม่ใช่คำรับรองจากผู้ตรวจ เอกสารนี้ไม่มีปุ่มอนุมัติ ไม่ส่งข้อมูลออก และไม่เปลี่ยนฐานข้อมูล</p></div></header>
<div class="stats" aria-label="จำนวนข้อมูล"><div class="stat"><strong>${report.structurallyValidRows.length}</strong>แถวโครงสร้างครบ</div>
<div class="stat"><strong>${report.rejectedRows.length}</strong>แถวต้องแก้</div><div class="stat"><strong>${report.sourceIssues.length}</strong>ปัญหาระดับชุด</div></div>
<section class="identity"><h2>${report.readiness === 'blocked' ? 'พบปัญหา — ต้องแก้ก่อนเสนอ' : 'โครงสร้างครบ — รอผู้ตรวจต้นทาง'}</h2>
<dl>${field('ชุดข้อมูล', report.datasetVersion)}${field('เอกสารที่ต้นทางอ้าง', report.citation)}
${field('ตรงกับแฟ้มเก่าที่ตรึงไว้หรือไม่', report.matchesArchivedBaseline ? 'ตรง — แต่ไม่ได้แปลว่ารับรองแล้ว' : 'ไม่ตรง — เป็นชุดที่เปลี่ยนจากแฟ้มเดิม')}</dl>
<p>อ้างรหัสชุดนี้เมื่อส่งข้อสังเกต เพื่อไม่ปะปนกับเวอร์ชันอื่น:</p><p class="hash" id="candidate-id">${escape(report.candidateId)}</p>
<details><summary>ที่มาของไฟล์และขอบเขตการตรวจ</summary><p class="hash">Parser: ${escape(report.parserVersion)}<br>Archive SHA256: ${escape(report.archiveSHA256)}</p>
<p>ค่าแฮชของ workbook ที่ไฟล์ระบุไว้ ยังไม่ได้เทียบกับ workbook ต้นฉบับ:</p><p class="hash">${escape(report.claimedWorkbookSHA256 ?? 'ไม่พบค่าที่ใช้ได้')}</p>
<ul><li>ยังไม่ได้ยืนยัน revision จาก Google Drive</li><li>ยังไม่ได้ตรวจใบอนุญาต ต้นฉบับเลขหน้า หรือความถูกต้องทางคลินิก</li><li>U Synthesize เก็บไฟล์ต้นทางไว้ แต่ไม่ได้รันหรือตรวจความหมายของ JavaScript ในรายงานนี้</li></ul>
${packet.files.map(file => `<div class="file"><p>${escape(file.path)} · ${file.bytes} bytes</p><p class="hash">${escape(file.sha256)}</p></div>`).join('')}</details></section>
<nav aria-label="หมวดข้อมูล"><a href="#problems">ผลตรวจ / ปัญหา</a>${navigation}</nav>
${problems}<div id="contents" tabindex="-1">${sections || '<section><h2>ยังไม่มีแถวที่ตรวจโครงสร้างผ่าน</h2><p>ดูปัญหาด้านบน และกลับไปตรวจชุดต้นทางก่อนเสนอใหม่</p></section>'}</div>
<footer><h2>ขั้นต่อไปของผู้ตรวจ</h2><p>อ่านเนื้อหาและเทียบเอกสารต้นฉบับ บันทึกข้อสังเกตโดยระบุรหัสชุด ชีต และแถว การรับรองต้องทำผ่านผู้มีอำนาจและช่องทางที่กำหนดแยกต่างหาก ไม่ใช่การแก้ไฟล์ HTML นี้</p></footer>
</main></body></html>`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 6 || process.argv[2] !== '--input' || process.argv[4] !== '--output') {
    throw new Error('Usage: node scripts/render-knowledge-review.mjs --input <packet.json> --output <new-review.html>');
  }
  const packet = await readKnowledgeCandidateFile(process.argv[3]);
  const html = renderKnowledgeReview(packet);
  await fs.writeFile(path.resolve(process.argv[5]), html, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ candidateId: packet.candidateId, artifact: 'read_only_source_review', publicationAuthorized: false }));
}
