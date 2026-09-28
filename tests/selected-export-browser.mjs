// Actual registry markup/controller; synthetic in-memory rows, no backend access.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
import {buildCsv,selectedExportHeaders} from '../netlify/functions/_shared/selected-export.mjs';
const read=name=>fs.readFile(new URL(`../${name}`,import.meta.url),'utf8');
const browser=await chromium.launch({headless:true,...(process.env.CNYOS_TEST_BROWSER_PATH?{executablePath:process.env.CNYOS_TEST_BROWSER_PATH}:{})});
try {
  const page=await browser.newPage({acceptDownloads:true,viewport:{width:390,height:844}});
  await page.route('**/*',route=>route.abort());
  const alerts=[],errors=[],downloads=[];
  page.on('dialog',async dialog=>{alerts.push(dialog.message());await dialog.dismiss();});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('download',download=>downloads.push(download));
  await page.setContent((await read('index.html')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,''));
  await page.addStyleTag({content:await read('app.css')});
  await page.evaluate(()=>{
    document.querySelector('#boot').remove();document.querySelector('#app').classList.remove('hidden');
    document.querySelectorAll('.view').forEach(view=>view.classList.remove('active'));
    document.querySelector('#patients').classList.add('active');
    window.ChananyaRuntime={can:()=>false};
  });
  await page.addScriptTag({content:await read('selected-export-browser.js')});
  const source=await read('app.js');
  assert.ok(source.includes('  init();\n})();'));
  await page.addScriptTag({content:source.replace('  init();\n})();',`
    role='admin';profile={role:'admin',clinic_id:'synthetic-clinic-a'};
    data.patients=[{id:'synthetic-a',clinic_id:'synthetic-clinic-a',hn:'SYN-A',first_name:'\\t=2+2',national_id:'excluded-secret'},
      {id:'synthetic-b',clinic_id:'synthetic-clinic-a',hn:'SYN-B',first_name:'Unselected'}];
    window.setSyntheticExportRows=rows=>{data.patients=rows;};
    window.removeSyntheticSelected=()=>{data.patients=data.patients.filter(row=>row.id!=='synthetic-a');};
    renderPatients();
  })();`)});
  await page.locator('[data-export-patient="synthetic-a"]').check();
  for(const format of ['json','csv']) {
    await page.locator('#patient-export-format').selectOption(format);
    const waiting=page.waitForEvent('download');
    await page.locator('#patient-export-download').click();
    const download=await waiting;
    const body=await fs.readFile(await download.path(),'utf8');
    assert.ok(download.suggestedFilename().endsWith(`.${format}`));
    assert.ok(!body.includes('excluded-secret')&&!body.includes('Unselected'));
    if(format==='json') {
      const rows=JSON.parse(body);assert.equal(rows.length,1);assert.equal(rows[0].first_name,'\t=2+2');
      assert.deepEqual(Object.keys(rows[0]),selectedExportHeaders('patients'));
    } else assert.equal(body,buildCsv([{id:'synthetic-a',clinic_id:'synthetic-clinic-a',hn:'SYN-A',first_name:'\t=2+2'}],selectedExportHeaders('patients')));
  }
  for(const rows of [
    [{id:'synthetic-a',clinic_id:'synthetic-clinic-b'}],
    [{id:'synthetic-a'}],
    [{id:'synthetic-a',clinic_id:'synthetic-clinic-a'},{id:'synthetic-a',clinic_id:'synthetic-clinic-a'}],
  ]) {
    await page.evaluate(rows=>window.setSyntheticExportRows(rows),rows);
    const rejected=page.waitForEvent('dialog');
    await page.locator('#patient-export-download').click();await rejected;
    assert.match(alerts.at(-1),/คลินิก|ซ้ำ/);
    assert.equal(downloads.length,2);
  }
  await page.evaluate(()=>window.removeSyntheticSelected());
  const rejected=page.waitForEvent('dialog');
  await page.locator('#patient-export-download').click();await rejected;
  assert.match(alerts.at(-1),/รายการที่เลือกไม่ครบ/);
  assert.equal(downloads.length,2);
  assert.deepEqual(errors,[]);
  console.log('Selected export browser passed: real checkbox/download, exact selected JSON/CSV, excluded fields, formula encoding and missing/foreign/ambiguous selection refusal; synthetic rows only.');
} finally {await browser.close();}
