(() => {
  'use strict';

  const COLUMNS = Object.freeze([
    'id', 'clinic_id', 'hn', 'prefix', 'first_name', 'last_name', 'gender',
    'date_of_birth', 'phone', 'email', 'active', 'created_at', 'updated_at'
  ]);
  const FORMULA_PREFIX = /^[=+\-@]/;

  function valueOf(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  function csvCell(value) {
    let valueText = valueOf(value);
    if (FORMULA_PREFIX.test(valueText)) valueText = `'${valueText}`;
    return /[",\r\n]/.test(valueText)
      ? `"${valueText.replaceAll('"', '""')}"`
      : valueText;
  }

  function csv(rows) {
    const body = rows.map(row => COLUMNS.map(column => csvCell(row[column])).join(','));
    return `${[COLUMNS.map(csvCell).join(','), ...body].join('\r\n')}\r\n`;
  }

  function project(row) {
    return Object.fromEntries(COLUMNS.map(column => [column, row?.[column] ?? null]));
  }

  window.CnyosSelectedExport = Object.freeze({
    patientColumns: COLUMNS,
    projectPatient: project,
    patientCsv: csv
  });
})();
