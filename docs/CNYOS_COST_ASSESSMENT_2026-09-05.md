# CNYOS — ต้นทุนสำหรับเจ้าของธุรกิจ

ตรวจราคา: 5 กันยายน 2026 • ตัวเลขสำหรับวางแผน ไม่ใช่ยอดใบแจ้งหนี้

## ค่าใช้จ่ายสามส่วน

| ส่วน | จ่ายเพื่ออะไร | สถานะที่ตรวจได้ |
|---|---|---|
| Astra ใน ChatGPT/Codex | ช่วยพัฒนา ทดสอบ และทำงานให้เจ้าของ | ค่าแพ็กเกจ/เครดิตของบัญชี แยกจากค่า AI ในแอป; ยังไม่มีข้อมูลใบแจ้งหนี้เพื่อปันส่วนให้ CNYOS |
| Supabase + Netlify | ฐานข้อมูล Login เว็บไซต์ และงานเซิร์ฟเวอร์ | Netlify connector ยืนยัน Pro; ยังไม่ได้ยืนยันยอดใช้งาน/ใบแจ้งหนี้ Supabase และ Netlify |
| Astra API ภายใน CNYOS | AI ตอบหรือสรุปให้ผู้ใช้แอป | ไม่พบการเรียก OpenAI/Astra ในโค้ดแอปที่ตรวจ; ส่วนค้นแหล่งอ้างอิงที่เพิ่มรอบนี้ไม่เรียก LLM |

การใช้ Astra ช่วยสร้างโปรแกรม ไม่ทำให้โปรแกรมต้องเรียก Astra ทุกครั้งที่คลินิกเปิดหน้าเว็บ ใช้ยอด ChatGPT/Codex จริงเป็นค่าใช้จ่ายพัฒนาและแบ่งตามโครงการ ส่วน API ในแอปคิดตามการใช้งานอีกบัญชีหนึ่ง [OpenAI authentication and billing](https://learn.chatgpt.com/docs/auth), [ChatGPT/Codex pricing](https://learn.chatgpt.com/docs/pricing)

## งบ cloud ต่อเดือน

สมมติ 1 Supabase Pro organization, 1 Netlify Pro team แบบ credit-based, แต่ละคลินิกมี production และ staging แยก project, เปิดครบเดือน และใช้ทรัพยากรไม่เกินโควตา อัตรา **35 บาท/USD เป็นสมมติฐานวางแผน ไม่ใช่อัตราแลกเปลี่ยนสด**

| รายการ | 1 คลินิก + staging (2 projects) | 2 คลินิก + staging แยก (4 projects) |
|---|---:|---:|
| Supabase Micro baseline | $35 | $55 |
| Netlify Pro team baseline | $20 | $20 |
| รวมฐาน | **$55 / ฿1,925** | **$75 / ฿2,625** |
| เพิ่ม PITR 7 วัน + Small เฉพาะ production | ประมาณ $105 | ประมาณ $210 |
| รวมเมื่อเพิ่ม PITR | **ประมาณ $160 / ฿5,600** | **ประมาณ $285 / ฿9,975** |
| ตัวอย่างเพิ่ม Astra 500 คำขอ/คลินิก/เดือน | $45 | $90 |
| รวมตัวอย่าง PITR + Astra | **ประมาณ $205 / ฿7,175** | **ประมาณ $375 / ฿13,125** |

Supabase baseline = $25 + ($10 × จำนวน Micro projects) − $10 compute credit ต่อ organization. PITR 7 วันประมาณ $100 ต่อ project/เดือน ต้องใช้ Small ขึ้นไป จึงเพิ่ม compute อีกประมาณ $5 เทียบ Micro. Daily database backup รวมใน Pro แต่ไม่ใช่การกู้ย้อนหลังทุกช่วงเวลา และไม่สำรองไฟล์ Storage objects แทนเรา [Supabase pricing](https://supabase.com/pricing), [PITR usage](https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery), [Backup scope](https://supabase.com/docs/guides/platform/backups)

Netlify ตัวอย่างใช้ $20/team/month และ 3,000 credits ร่วมกันทุกไซต์; overage เพิ่มได้ ราคาต้องเทียบแพ็กเกจจริง โดยเฉพาะบัญชี legacy ตารางนี้ไม่ได้เปลี่ยนแพ็กเกจหรือเปิด auto-recharge [Netlify credit-based pricing](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/)

## Astra API คิดอย่างไร

ราคามาตรฐาน GPT-6 Astra สำหรับ short context: input $10 และ output $50 ต่อหนึ่งล้าน tokens. ตัวอย่างหนึ่งคำขอใช้ input 4,000 และ **billable output รวม reasoning** 1,000 tokens:

`(4,000 × $10 + 1,000 × $50) / 1,000,000 = $0.09 = ฿3.15`

500 คำขอ = $45 หรือ ฿1,575. นี่เป็นตัวอย่างตามปริมาณข้อความ ไม่ใช่ราคาต่อผู้ป่วยหรือราคาคงที่ต่อคำตอบ หลายรอบ reasoning/คำตอบยาว/tool calls/ภาพ/long context/fast mode อาจเพิ่มราคา ไม่มี API call ที่เสียเงินถูกเพิ่มหรือรันในงานรอบนี้ [GPT-6 Astra pricing](https://developers.openai.com/api/docs/models/gpt-6-astra)

## สิ่งที่ยังต้องบวก

- ค่า ChatGPT/Codex ที่จัดสรรให้โครงการ และเครดิตเพิ่มจริง
- Domain, email, LINE, payment gateway, ภาษี และค่าเงิน
- สำรองไฟล์เข้ารหัสนอกระบบ, monitoring, ปริมาณใช้เกินโควตา
- ผู้รับผิดชอบดูแลเหตุขัดข้อง, ทดสอบกู้คืน, security review และ legal review
- ค่า onboarding, support และพัฒนาเพิ่มเติมต่อลูกค้า

ตัวเลขในตารางเป็นต้นทุน cloud ตามสมมติฐาน ไม่ใช่ต้นทุนธุรกิจทั้งหมด และไม่ใช่การรับรอง production readiness.

## แนวทางเชิงธุรกิจ

คง managed hosting/database ระหว่างปิด release gates ใช้ Astra ในงานพัฒนาได้ต่อ ส่วน AI ในแอปให้แยกโควตาและวัดต้นทุนก่อนเปิดขาย ไม่ควรเสนอ AI unlimited. กำหนดระดับการกู้คืนที่ต้องการก่อนตั้งราคาขาย เพราะ PITR, support และการรับผิดชอบระบบเปลี่ยนต้นทุนต่อคลินิกอย่างมีนัยสำคัญ

ต้นทุนต่อคลินิก = ค่าใช้จ่ายร่วมที่ปันส่วน + database/backup เฉพาะคลินิก + AI ตามใช้ + support + onboarding ที่เฉลี่ยตามอายุสัญญา. กำไรขั้นต้นต้องคำนวณจากรายการเหล่านี้ครบก่อนออกแพ็กเกจจริง
