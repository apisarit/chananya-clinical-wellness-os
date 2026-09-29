/* Presentation quotes only. The database must independently resolve/validate every charge. */
(() => {
  'use strict';
  function checkedPrice(row, unit) {
    if (!row || !Number.isFinite(Number(row.unit_price)) || Number(row.unit_price) <= 0) return null;
    if (String(row.unit_code || '').trim().toLowerCase() !== String(unit || '').trim().toLowerCase()) return null;
    return row;
  }
  async function productQuotes(db, products) {
    const unique = [...new Map(products.map(product => [product.id, product])).values()];
    const result = new Map();
    let next = 0;
    async function worker() {
      while (next < unique.length) {
        const product = unique[next++];
        const response = await db.rpc('resolve_price_master_item', { p_item_type: 'product', p_product_id: product.id });
        if (response.error) throw response.error;
        const rows = Array.isArray(response.data) ? response.data : [];
        result.set(product.id, rows.length === 1 ? checkedPrice(rows[0], product.dispense_unit) : null);
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, unique.length) }, worker));
    return result;
  }
  window.CnyosPriceMaster = Object.freeze({ checkedPrice, productQuotes });
})();
