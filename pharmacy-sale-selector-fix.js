(()=>{'use strict';
const $=s=>document.querySelector(s);
const KEY='chananya.walkin.selectedSaleId';
function getSaleSelect(){return $('#item-sale')}
function validOption(sel,id){return !!id&&[...sel.options].some(o=>o.value===id)}
function choose(id,{scroll=false}={}){const sel=getSaleSelect();if(!sel||!validOption(sel,id))return false;sel.value=id;sessionStorage.setItem(KEY,id);sel.dispatchEvent(new Event('change',{bubbles:true}));const banner=$('#selected-sale-banner');if(banner){const opt=sel.options[sel.selectedIndex];banner.textContent=`กำลังเพิ่มยาเข้า: ${opt?.textContent||id}`;banner.hidden=false}if(scroll){$('#item-form')?.scrollIntoView({behavior:'smooth',block:'start'});setTimeout(()=>document.querySelector('[data-search-select-for="item-product"] .search-select-input')?.focus(),350)}return true}
function ensureSelection(){const sel=getSaleSelect();if(!sel)return;const saved=sessionStorage.getItem(KEY);if(validOption(sel,saved)){choose(saved);return}if(sel.value){choose(sel.value);return}const first=[...sel.options].find(o=>o.value);if(first)choose(first.value);else{sessionStorage.removeItem(KEY);const banner=$('#selected-sale-banner');if(banner){banner.textContent='ยังไม่มีรายการขายสถานะ Draft — กรุณาสร้างรายการ Walk-in ก่อน';banner.hidden=false}}}
function addButtons(){document.querySelectorAll('#walkin-list [data-sale-id]').forEach(card=>{if(card.querySelector('[data-select-sale]'))return;const badge=card.querySelector('.badge')?.textContent?.trim().toLowerCase();if(badge!=='draft')return;const id=card.dataset.saleId;if(!id)return;const actions=card.querySelector('.right')||card;const btn=document.createElement('button');btn.type='button';btn.className='btn ghost';btn.dataset.selectSale=id;btn.textContent='เลือกรายการนี้เพื่อเพิ่มยา';btn.addEventListener('click',()=>choose(id,{scroll:true}));actions.prepend(btn)})}
function sync(){ensureSelection();addButtons()}
document.addEventListener('DOMContentLoaded',()=>{const sel=getSaleSelect();sel?.addEventListener('change',()=>{if(sel.value)choose(sel.value);else sessionStorage.removeItem(KEY)});sync()});
window.addEventListener('chananya:pharmacy-rendered',sync);
})();
