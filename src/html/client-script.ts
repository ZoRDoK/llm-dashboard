/**
 * Client-side dashboard script, served inline as the last <script> tag.
 *
 * Server-injected values arrive as parameters — the script itself reads
 * everything else from data attributes at runtime (data-updated,
 * data-max-usage, data-provider-updated).
 */
interface ClientScriptOptions {
  themeNames: readonly string[];
  refreshCircumference: number;
}

export function clientScript(opts: ClientScriptOptions): string {
  const { themeNames, refreshCircumference } = opts;

  return `    // ── Theme Manager ────────────────────────────────────────
    const ThemeManager = {
      themes: ${JSON.stringify(themeNames)},
      current: 0,

      init() {
        const saved = localStorage.getItem('ai-creds-theme');
        const idx = saved ? this.themes.indexOf(saved) : 0;
        this.setTheme(idx >= 0 ? idx : 0);
      },

      setTheme(index) {
        this.current = ((index % this.themes.length) + this.themes.length) % this.themes.length;
        const name = this.themes[this.current];
        document.documentElement.setAttribute('data-theme', name);
        localStorage.setItem('ai-creds-theme', name);
        this.updateStatus();
      },

      rotate() {
        this.setTheme(this.current + 1);
      },

      updateStatus() {
        const el = document.getElementById('status');
        if (el) {
          el.textContent = 'Theme: ' + this.themes[this.current].replace(/-/g, ' ');
          el.classList.add('opacity-100');
          setTimeout(() => el.classList.remove('opacity-100'), 1500);
        }
      }
    };

    // Hotkey: Ctrl+T / Cmd+T
    document.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 't') {
        e.preventDefault();
        ThemeManager.rotate();
      }
    });

    ThemeManager.init();

    // ── Tabs ───────────────────────────────────────────────
    function showTab(tabName) {
      const panels = document.querySelectorAll('.tab-panel');
      const buttons = document.querySelectorAll('.tab-btn');

      if (!panels.length || !buttons.length) return;

      for (const panel of panels) {
        panel.classList.toggle('hidden', panel.id !== 'tab-' + tabName);
      }

      for (const btn of buttons) {
        const isActive = btn.id === 'tab-' + tabName + '-btn';

        if (isActive) {
          btn.classList.add('bg-theme-accent', 'text-theme-accent-text');
          btn.classList.remove('text-theme-text-secondary');
        } else {
          btn.classList.remove('bg-theme-accent', 'text-theme-accent-text');
          btn.classList.add('text-theme-text-secondary');
        }
      }
    }

    function markBillingDirty(providerId) {
      const row = document.querySelector('[data-provider-id="' + providerId + '"]');
      if (row) row.dataset.dirty = 'true';
    }

    function clearBillingDate(providerId) {
      const row = document.querySelector('[data-provider-id="' + providerId + '"]');
      if (!row) return;
      const input = row.querySelector('.billing-date-input');
      if (input) {
        input.value = '';
        row.dataset.dirty = 'true';
      }
    }

    async function saveBillingSettings() {
      const status = document.getElementById('settings-status');
      const saveBtn = document.getElementById('save-settings-btn');
      const rows = document.querySelectorAll('[data-provider-id]');

      const billingOverrides = {};
      for (const row of rows) {
        const providerId = row.getAttribute('data-provider-id');
        const input = row.querySelector('.billing-date-input');
        if (!providerId || !input) continue;

        // Only include providers the user actually modified
        if (row.dataset.dirty !== 'true') continue;

        const raw = String(input.value || '').trim();
        if (!raw) {
          continue;
        }

        // Accept both YYYY-MM-DD and YYYY-MM-DDTHH:mm:ss.sssZ
        const match = /^(\\d{4}-\\d{2}-\\d{2})/.exec(raw);
        if (!match) {
          if (status) status.textContent = 'Invalid date format. Got: ' + raw;
          return;
        }

        billingOverrides[providerId] = match[1] + 'T00:00:00.000Z';
      }

      if (status) status.textContent = 'saving...';
      if (saveBtn) saveBtn.disabled = true;

      try {
        const response = await fetch('/api/settings/billing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ billingOverrides }),
        });

        if (!response.ok) {
          if (status) status.textContent = 'save error';
          return;
        }

        if (status) status.textContent = 'saved';
        window.location.reload();
      } catch {
        if (status) status.textContent = 'save error';
      } finally {
        if (saveBtn) saveBtn.disabled = false;
      }
    }

    showTab('dashboard');

    // ── Refresh progress circle ─────────────────────────────
    const REFRESH_INTERVAL_MS = 30_000;
    const CIRCUMFERENCE = ${refreshCircumference};

    const progressCircle = document.getElementById('refresh-circle');
    const progressEl = progressCircle?.querySelector('.progress');

    function updateRefreshCircle() {
      if (!progressCircle || !progressEl) return;

      const ts = parseInt(progressCircle.dataset.updated, 10);
      if (!ts) {
        progressEl.style.strokeDashoffset = CIRCUMFERENCE;
        progressCircle.className = 'refresh-circle normal';
        return;
      }

      const elapsed = Date.now() - ts;
      const fraction = Math.min(1, elapsed / REFRESH_INTERVAL_MS);
      const offset = CIRCUMFERENCE * (1 - fraction);
      progressEl.style.strokeDashoffset = offset;

      // Color logic:
      // - fresh (< 30% of interval): positive (success color)
      // - mid (30-70%): neutral (accent color)
      // - stale (> 70%): depends on max usage
      //   - high usage (> 50%): negative (warning color)
      //   - low usage: neutral (accent color)
      const maxUsage = parseFloat(progressCircle.dataset.maxUsage) || 0;

      let colorClass;
      if (fraction < 0.3) {
        colorClass = 'fresh';
      } else if (fraction < 0.7) {
        colorClass = 'normal';
      } else {
        colorClass = maxUsage > 50 ? 'stale' : 'normal';
      }

      progressCircle.className = 'refresh-circle ' + colorClass;
    }

    // ── Last-updated time ────────────────────────────────────
    const MS_MINUTE = 60_000;
    const MS_HOUR = 3_600_000;
    const MS_DAY = 86_400_000;

    function formatElapsedMs(elapsed) {
      if (elapsed >= MS_DAY) {
        return Math.floor(elapsed / MS_DAY) + 'd';
      } else if (elapsed >= MS_HOUR) {
        return Math.floor(elapsed / MS_HOUR) + 'h';
      } else if (elapsed >= MS_MINUTE) {
        return Math.floor(elapsed / MS_MINUTE) + 'm';
      } else {
        return 'now';
      }
    }

    const timeDisplay = document.getElementById('last-updated-time');

    function updateLastUpdatedTime() {
      if (!timeDisplay) return;

      const ts = parseInt(timeDisplay.dataset.updated, 10);
      if (!ts) {
        timeDisplay.textContent = '';
        return;
      }

      timeDisplay.textContent = formatElapsedMs(Date.now() - ts);
    }

    setInterval(updateRefreshCircle, 1000);
    setInterval(updateLastUpdatedTime, 10_000);
    updateRefreshCircle();
    updateLastUpdatedTime();

    // ── Per-provider update labels ────────────────────────────
    function updateProviderUpdatedLabels() {
      const labels = document.querySelectorAll('.provider-updated[data-provider-updated]');

      for (const el of labels) {
        const ts = parseInt(el.getAttribute('data-provider-updated'), 10);

        if (!ts) {
          continue;
        }

        const text = formatElapsedMs(Date.now() - ts);

        el.textContent = 'Updated ' + text;
      }
    }

    setInterval(updateProviderUpdatedLabels, 10_000);
    updateProviderUpdatedLabels();

    // ── Refresh ──────────────────────────────────────────────
    async function refresh() {
      const status = document.getElementById('status');
      const btn = document.getElementById('refresh-btn');
      const spinner = document.getElementById('refresh-spinner');
      status.textContent = 'updating...';
      btn.disabled = true;
      if (spinner) spinner.classList.remove('hidden');
      try {
        const r = await fetch('/api/refresh', { method: 'POST' });
        if (r.ok) window.location.reload();
        else status.textContent = 'update error';
      } catch (e) {
        status.textContent = 'update error';
      } finally {
        btn.disabled = false;
        if (spinner) spinner.classList.add('hidden');
      }
    }

    // ── Archive toggle ────────────────────────────────────
    async function toggleArchive(providerId) {
      const cb = document.querySelector('input.archive-toggle[data-provider-id="' + providerId + '"]');
      const archived = cb ? cb.checked : true;

      await fetch('/api/settings/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId, archived }),
      });

      window.location.reload();
    }

    // ── Metrics poll ──────────────────────────────────────
    const METRICS_POLL_MS = 15_000;

    setInterval(async () => {
      const metricsTab = document.getElementById('tab-metrics');

      if (!metricsTab || metricsTab.classList.contains('hidden')) return;

      try {
        const [m, l] = await Promise.all([
          fetch('/api/metrics'),
          fetch('/api/logs'),
        ]);

        const mp = document.getElementById('metrics-panel');
        const lp = document.getElementById('logs-panel');

        if (mp && m.ok) mp.innerHTML = await m.text();
        if (lp && l.ok) lp.innerHTML = await l.text();
      } catch {}
    }, METRICS_POLL_MS);

    // ── History poll ──────────────────────────────────────
    setInterval(async () => {
      const historyTab = document.getElementById('tab-history');
      if (!historyTab || historyTab.classList.contains('hidden')) return;
      try {
        const h = await fetch('/api/history');
        const hp = document.getElementById('history-panel');
        if (hp && h.ok) hp.innerHTML = await h.text();
      } catch {}
    }, METRICS_POLL_MS);`;
}
