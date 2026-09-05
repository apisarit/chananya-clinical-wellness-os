(() => {
  'use strict';

  if (window.ChananyaSearchSelect) return;

  const instances = new WeakMap();
  const liveInstances = new Set();
  let instanceSequence = 0;
  const thaiCollator = new Intl.Collator(['th', 'en'], {
    sensitivity: 'base',
    numeric: true,
    usage: 'sort'
  });

  const normalize = value => String(value || '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('th-TH');

  function fieldLabel(select) {
    const explicit = select.getAttribute('aria-label');
    if (explicit) return explicit;
    const label = select.closest('label');
    if (!label) return 'รายการ';
    const text = [...label.childNodes]
      .filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => node.textContent.trim())
      .filter(Boolean)
      .join(' ');
    return text || 'รายการ';
  }

  class SearchSelect {
    constructor(select) {
      this.select = select;
      this.open = false;
      this.activeIndex = -1;
      this.matches = [];
      this.label = fieldLabel(select);
      this.instanceId = select.id || `chananya-select-${++instanceSequence}`;

      const wrapper = document.createElement('span');
      wrapper.className = 'search-select';
      wrapper.dataset.searchSelectFor = select.id || '';

      const input = document.createElement('input');
      input.type = 'search';
      input.className = 'search-select-input';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.placeholder = `พิมพ์เพื่อค้นหา ${this.label}`;
      input.setAttribute('role', 'combobox');
      input.setAttribute('aria-autocomplete', 'list');
      input.setAttribute('aria-expanded', 'false');
      input.setAttribute('aria-label', `${this.label} — พิมพ์เพื่อค้นหา`);
      input.setAttribute('aria-required', String(select.required));

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'search-select-toggle';
      toggle.setAttribute('aria-label', `เปิดรายการ ${this.label}`);
      toggle.textContent = '⌄';

      const list = document.createElement('span');
      list.className = 'search-select-list';
      list.setAttribute('role', 'listbox');
      list.hidden = true;
      list.id = `${this.instanceId}-search-list`;
      input.setAttribute('aria-controls', list.id);

      select.before(wrapper);
      wrapper.append(select, input, toggle, list);
      select.classList.add('search-select-native');
      select.tabIndex = -1;
      select.setAttribute('aria-hidden', 'true');
      select.dataset.searchableEnhanced = 'true';

      this.wrapper = wrapper;
      this.input = input;
      this.toggle = toggle;
      this.list = list;

      input.addEventListener('input', () => {
        this.activeIndex = 0;
        this.renderMatches(input.value);
        this.show();
      });
      input.addEventListener('focus', () => {
        this.renderMatches('');
        this.show();
      });
      input.addEventListener('keydown', event => this.onKeydown(event));
      input.addEventListener('blur', () => {
        window.setTimeout(() => {
          if (this.wrapper.contains(document.activeElement)) return;
          this.acceptExactOrReset(false);
          this.hide();
        }, 0);
      });
      toggle.addEventListener('click', () => {
        if (this.open) {
          this.hide();
          return;
        }
        input.focus();
        this.renderMatches('');
        this.show();
      });
      select.addEventListener('change', () => this.syncFromNative());
      select.addEventListener('invalid', event => {
        event.preventDefault();
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        this.renderMatches(input.value);
        this.show();
      });
      select.form?.addEventListener('reset', () => window.setTimeout(() => {
        input.removeAttribute('aria-invalid');
        this.refresh();
      }, 0));
      select.closest('label')?.addEventListener('click', event => {
        if (wrapper.contains(event.target)) return;
        event.preventDefault();
        input.focus();
      });

      this.refresh();
    }

    options() {
      return [...this.select.options].map((option, index) => ({
        index,
        value: option.value,
        text: option.textContent.trim(),
        disabled: option.disabled,
        placeholder: option.value === ''
      }));
    }

    rankedOptions(query) {
      const term = normalize(query);
      return this.options()
        .filter(option => !option.disabled)
        .filter(option => !term || normalize(`${option.text} ${option.value}`).includes(term))
        .sort((left, right) => {
          if (!term) {
            if (left.placeholder !== right.placeholder) return left.placeholder ? -1 : 1;
            return left.index - right.index;
          }
          const leftText = normalize(left.text);
          const rightText = normalize(right.text);
          const leftPrefix = leftText.startsWith(term);
          const rightPrefix = rightText.startsWith(term);
          if (leftPrefix !== rightPrefix) return leftPrefix ? -1 : 1;
          return thaiCollator.compare(left.text, right.text) || left.index - right.index;
        });
    }

    renderMatches(query) {
      this.matches = this.rankedOptions(query).slice(0, 100);
      this.activeIndex = Math.min(Math.max(this.activeIndex, 0), Math.max(0, this.matches.length - 1));
      this.list.replaceChildren();

      if (!this.matches.length) {
        this.input.removeAttribute('aria-activedescendant');
        const empty = document.createElement('span');
        empty.className = 'search-select-empty';
        empty.textContent = 'ไม่พบรายการที่ค้นหา';
        this.list.append(empty);
        return;
      }

      this.matches.forEach((option, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.id = `${this.instanceId}-search-option-${option.index}`;
        button.className = 'search-select-option';
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', String(option.value === this.select.value));
        button.classList.toggle('active', index === this.activeIndex);
        button.textContent = option.text || '—';
        button.addEventListener('pointerdown', event => event.preventDefault());
        button.addEventListener('click', () => this.choose(index));
        this.list.append(button);
      });
      const active = this.list.querySelector('.search-select-option.active');
      if (active) this.input.setAttribute('aria-activedescendant', active.id);
      else this.input.removeAttribute('aria-activedescendant');
    }

    choose(index, { refocus = true } = {}) {
      const option = this.matches[index];
      if (!option) return;
      const changed = this.select.value !== option.value;
      this.select.value = option.value;
      this.input.value = option.placeholder ? '' : option.text;
      this.input.removeAttribute('aria-invalid');
      if (changed) {
        this.select.dispatchEvent(new Event('input', { bubbles: true }));
        this.select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      this.hide();
      if (refocus) this.input.focus({ preventScroll: true });
    }

    acceptExactOrReset(refocus = true) {
      const term = normalize(this.input.value);
      if (term) {
        const exact = this.options().find(option =>
          !option.disabled
          && (normalize(option.text) === term || normalize(option.value) === term)
        );
        if (exact) {
          this.matches = [exact];
          this.choose(0, { refocus });
          return;
        }
      }
      this.syncFromNative();
    }

    onKeydown(event) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!this.open) {
          this.renderMatches(this.input.value);
          this.show();
        }
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        this.activeIndex = (this.activeIndex + direction + this.matches.length) % Math.max(1, this.matches.length);
        this.renderMatches(this.input.value);
        this.list.querySelector('.search-select-option.active')?.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (event.key === 'Enter' && this.open) {
        event.preventDefault();
        this.choose(this.activeIndex);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        this.syncFromNative();
        this.hide();
      }
    }

    syncFromNative() {
      const selected = this.select.selectedOptions[0];
      this.input.value = selected && selected.value !== '' ? selected.textContent.trim() : '';
    }

    show() {
      if (this.input.disabled) return;
      document.querySelectorAll('.search-select.open').forEach(element => {
        if (element !== this.wrapper) element._searchSelectInstance?.hide();
      });
      this.open = true;
      this.wrapper.classList.add('open');
      this.wrapper._searchSelectInstance = this;
      this.list.hidden = false;
      this.input.setAttribute('aria-expanded', 'true');
    }

    hide() {
      this.open = false;
      this.wrapper.classList.remove('open');
      this.list.hidden = true;
      this.input.setAttribute('aria-expanded', 'false');
      this.input.removeAttribute('aria-activedescendant');
    }

    refresh() {
      this.input.disabled = this.select.disabled;
      this.toggle.disabled = this.select.disabled;
      this.input.setAttribute('aria-required', String(this.select.required));
      this.wrapper.classList.toggle('disabled', this.select.disabled);
      this.syncFromNative();
      if (this.open) this.renderMatches(this.input.value);
    }
  }

  function enhance(root = document) {
    root.querySelectorAll('select:not([multiple]):not([data-searchable="false"])').forEach(select => {
      if (instances.has(select)) return;
      const instance = new SearchSelect(select);
      instances.set(select, instance);
      liveInstances.add(instance);
    });
  }

  function refreshAll(root = document) {
    enhance(root);
    liveInstances.forEach(instance => {
      if (!instance.select.isConnected) {
        liveInstances.delete(instance);
        return;
      }
      if (root === document || root.contains(instance.select)) instance.refresh();
    });
  }

  document.addEventListener('pointerdown', event => {
    liveInstances.forEach(instance => {
      if (!instance.wrapper.contains(event.target)) instance.hide();
    });
  });

  [
    'chananya:shell-ready',
    'chananya:operations-rendered',
    'chananya:appointments-rendered',
    'chananya:clinical-references-rendered',
    'chananya:encounter-changed',
    'chananya:pharmacy-rendered',
    'chananya:production-rendered',
    'chananya:admin-rendered',
    'chananya:foundation-rendered',
    'chananya:patient-card-rendered',
    'chananya:bodymap-rendered'
  ].forEach(name => window.addEventListener(name, () => refreshAll()));

  window.ChananyaSearchSelect = Object.freeze({ enhance, refreshAll });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => refreshAll(), { once: true });
  } else {
    refreshAll();
  }
})();
