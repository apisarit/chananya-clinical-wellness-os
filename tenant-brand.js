(() => {
  'use strict';
  if (window.ClinicalOSBrand) return;

  const config = window.CLINICAL_OS_CONFIG || {};
  const brand = config.brand || {};
  const colors = brand.colors || {};
  const cssVariables = {
    primary950: '--forest-950', primary900: '--forest-900', primary800: '--forest-800',
    primary700: '--forest-700', primary100: '--forest-100', primary50: '--forest-50',
    accent: '--gold', accentSoft: '--gold-soft', surface: '--paper', background: '--cream'
  };

  function text(selector, value) {
    if (!value) return;
    document.querySelectorAll(selector).forEach(element => { element.textContent = value; });
  }

  function value(selector, nextValue) {
    if (!nextValue) return;
    document.querySelectorAll(selector).forEach(element => { element.value = nextValue; });
  }

  function applyMark(element) {
    if (brand.logoUrl) {
      const image = document.createElement('img');
      image.src = brand.logoUrl;
      image.alt = brand.shortName || brand.nameEn || 'Clinic';
      image.decoding = 'async';
      image.style.width = '100%';
      image.style.height = '100%';
      image.style.objectFit = 'contain';
      element.replaceChildren(image);
      element.classList.add('has-brand-logo');
      return;
    }
    element.textContent = brand.mark || 'C';
  }

  function apply() {
    Object.entries(cssVariables).forEach(([key, variable]) => {
      if (colors[key]) document.documentElement.style.setProperty(variable, colors[key]);
    });
    document.querySelectorAll('meta[name="theme-color"]').forEach(meta => { meta.content = colors.primary950 || '#0d2d24'; });
    document.querySelectorAll('.brand-mark,.logo').forEach(applyMark);
    text('.brand strong,.patient-card-brand strong,[data-brand-short-name]', brand.shortName);
    text('.brand small', brand.descriptor);
    text('.patient-card-brand small,[data-brand-card-label]', brand.productName);
    text('[data-brand-name-th]', brand.nameTh);
    text('[data-brand-name-en]', brand.nameEn);
    text('[data-brand-product]', brand.productName);
    const appName = brand.browserTitle || [brand.shortName, brand.productName].filter(Boolean).join(' ');
    text('[data-brand-app-name]', appName);
    const demoHn = `${config.tenant?.expectedClinicCode || 'CLINIC'}-00001234`;
    text('[data-brand-demo-hn]', demoHn);
    value('[data-brand-demo-hn-value]', demoHn);
    text('[data-brand-demo-result]', `${demoHn} • ผู้รับบริการตัวอย่าง`);
    text('[data-brand-demo-queue]', `Q-${config.tenant?.expectedClinicCode || 'CLINIC'}-000042 • HN-DEMO-001 ผู้รับบริการตัวอย่าง`);
    text('[data-brand-demo-request]', `PR-${config.tenant?.expectedClinicCode || 'CLINIC'}-00000042 • ยาสมุนไพรตัวอย่าง`);
    document.querySelectorAll('.hero').forEach(hero => { hero.dataset.brandWatermark = brand.nameTh || brand.shortName || ''; });

    const oldTitle = document.title;
    if (brand.browserTitle) {
      document.title = brand.browserTitle;
    } else if (brand.shortName && oldTitle) {
      document.title = oldTitle
        .replace(/Chananya Clinical OS/gi, `${brand.shortName} ${brand.productName || 'Clinical OS'}`)
        .replace(/Chananya/gi, brand.shortName);
    }
    document.documentElement.dataset.deploymentId = config.deploymentId || '';
    window.dispatchEvent(new CustomEvent('clinicalos:brand-ready', { detail: { deploymentId: config.deploymentId, brand } }));
  }

  window.ClinicalOSBrand = Object.freeze({ config, brand, apply });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true });
  else apply();
})();
