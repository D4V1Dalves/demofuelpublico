/* Fuel Jobs — interações do shell e do board.
   Sem dependências: sidebar mobile, alternador de visão, grupos
   recolhíveis e drawer do item (carregado do servidor). */
document.addEventListener('DOMContentLoaded', () => {
  /* ---------- Tema claro/escuro ---------- */
  const themeToggles = Array.from(document.querySelectorAll('[data-theme-toggle]'));
  const themeChoices = Array.from(document.querySelectorAll('[data-theme-choice]'));
  const currentTheme = () => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
  const applyTheme = (theme, persist) => {
    const dark = theme === 'dark';
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    themeToggles.forEach((button) => {
      button.setAttribute('aria-pressed', String(dark));
      const label = button.querySelector('[data-theme-label]');
      if (label) {
        label.textContent = dark
          ? button.dataset.labelDark || 'Tema escuro'
          : button.dataset.labelLight || 'Tema claro';
      }
      const icon = button.querySelector('.theme-toggle-icon');
      if (icon) icon.textContent = dark ? '☾' : '☀';
    });
    themeChoices.forEach((choice) => {
      choice.setAttribute('aria-checked', String(choice.dataset.themeChoice === (dark ? 'dark' : 'light')));
    });
    if (persist) {
      try {
        window.localStorage.setItem('fuel-theme', dark ? 'dark' : 'light');
      } catch {
        /* modo privado: aplica só nesta sessão */
      }
    }
  };

  applyTheme(currentTheme(), false);

  // Transição de tema: uma onda na cor do tema escolhido sobe pela tela, cobre
  // tudo, o tema é trocado por baixo dela e a onda segue subindo, revelando o
  // novo tema. Com "reduzir movimento", a troca é imediata.
  const WAVE_MS = 1100;
  let waveBusy = false;
  const switchTheme = (next) => {
    if (next === currentTheme() || waveBusy) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      applyTheme(next, true);
      return;
    }
    waveBusy = true;
    const wave = document.createElement('div');
    wave.className = `theme-wave is-to-${next}`;
    wave.setAttribute('aria-hidden', 'true');
    wave.innerHTML =
      '<span class="theme-wave-crest"></span><span class="theme-wave-edge"></span>' +
      '<span class="theme-wave-body"></span><span class="theme-wave-edge is-bottom"></span>';
    document.body.appendChild(wave);
    window.setTimeout(() => applyTheme(next, true), WAVE_MS / 2);
    window.setTimeout(() => {
      wave.remove();
      waveBusy = false;
    }, WAVE_MS + 60);
  };

  themeToggles.forEach((button) => {
    button.addEventListener('click', () => switchTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
  });
  themeChoices.forEach((choice) => {
    choice.addEventListener('click', () => switchTheme(choice.dataset.themeChoice));
  });

  /* ---------- Confirmação de ações destrutivas ---------- */
  const confirmDialog = document.getElementById('confirm-dialog');
  let pendingForm = null;
  if (confirmDialog) {
    document.addEventListener('submit', (event) => {
      const form = event.target.closest('form[data-confirm]');
      if (!form || form.dataset.confirmed === 'true') return;
      event.preventDefault();
      pendingForm = form;
      const message = confirmDialog.querySelector('#confirm-message');
      if (message) message.textContent = form.dataset.confirm || 'Tem certeza?';
      confirmDialog.showModal();
    });

    confirmDialog.addEventListener('close', () => {
      if (confirmDialog.returnValue === 'confirm' && pendingForm) {
        const form = pendingForm;
        pendingForm = null;
        form.dataset.confirmed = 'true';
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      } else {
        pendingForm = null;
      }
    });
  }

  /* ---------- Copiar link de aprovação ---------- */
  const copyText = async (value) => {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(value);
        return;
      } catch {
        /* permissão negada: cai no fallback abaixo */
      }
    }
    // Fallback para http://localhost e navegadores sem Clipboard API.
    const helper = document.createElement('textarea');
    helper.value = value;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.top = '-1000px';
    document.body.append(helper);
    helper.select();
    const ok = document.execCommand('copy');
    helper.remove();
    if (!ok) throw new Error('copy failed');
  };

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy-target]');
    if (!button) return;
    const input = document.querySelector(button.dataset.copyTarget);
    if (!input) return;
    const original = button.textContent;
    try {
      input.focus();
      input.select();
      await copyText(input.value);
      button.textContent = 'Link copiado';
      button.classList.add('is-copied');
    } catch {
      button.textContent = 'Selecione e copie';
    }
    window.setTimeout(() => {
      button.textContent = original;
      button.classList.remove('is-copied');
    }, 2200);
  });

  /* ---------- Card de decisão: spotlight, elevação e confirmação inline ---------- */
  const decisionCard = document.querySelector('[data-decision-card]');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (decisionCard) {
    if (!reduceMotion) {
      let spotlightFrame = 0;
      decisionCard.addEventListener('pointermove', (event) => {
        if (event.pointerType === 'touch') return;
        const bounds = decisionCard.getBoundingClientRect();
        const x = (event.clientX - bounds.left) / bounds.width;
        const y = (event.clientY - bounds.top) / bounds.height;
        if (spotlightFrame) window.cancelAnimationFrame(spotlightFrame);
        spotlightFrame = window.requestAnimationFrame(() => {
          spotlightFrame = 0;
          decisionCard.style.setProperty('--pointer-x', `${(x * 100).toFixed(2)}%`);
          decisionCard.style.setProperty('--pointer-y', `${(y * 100).toFixed(2)}%`);
          decisionCard.style.setProperty('--tilt-x', `${((.5 - y) * 4).toFixed(2)}deg`);
          decisionCard.style.setProperty('--tilt-y', `${((x - .5) * 4).toFixed(2)}deg`);
        });
      });
      decisionCard.addEventListener('pointerenter', (event) => {
        if (event.pointerType !== 'touch') decisionCard.classList.add('is-hovered');
      });
      decisionCard.addEventListener('pointerleave', () => {
        decisionCard.classList.remove('is-hovered');
        ['--pointer-x', '--pointer-y', '--tilt-x', '--tilt-y'].forEach((prop) =>
          decisionCard.style.removeProperty(prop),
        );
      });
    }
    decisionCard.addEventListener('focusin', () => decisionCard.classList.add('is-hovered'));
    decisionCard.addEventListener('focusout', (event) => {
      if (!decisionCard.contains(event.relatedTarget)) decisionCard.classList.remove('is-hovered');
    });
  }

  let resetApprove = () => {};
  const approveForm = document.querySelector('[data-approve-form]');
  if (approveForm) {
    const askStep = approveForm.querySelector('[data-approve-step="ask"]');
    const confirmStep = approveForm.querySelector('[data-approve-step="confirm"]');
    const startButton = approveForm.querySelector('[data-approve-start]');
    const confirmButton = approveForm.querySelector('[data-approve-confirm]');
    const cancelButton = approveForm.querySelector('[data-approve-cancel]');
    const confirmLabel = approveForm.querySelector('.approval-confirm-label');

    resetApprove = (focus) => {
      if (!confirmStep || confirmStep.hidden) return;
      approveForm.classList.remove('is-submitting');
      if (confirmButton) confirmButton.disabled = false;
      if (confirmLabel) confirmLabel.textContent = approveForm.dataset.labelConfirm || 'Sim, aprovar job';
      confirmStep.hidden = true;
      if (askStep) askStep.hidden = false;
      if (focus && startButton) startButton.focus();
    };

    if (startButton && confirmStep) {
      startButton.addEventListener('click', () => {
        askStep.hidden = true;
        confirmStep.hidden = false;
        if (confirmButton) confirmButton.focus();
      });
    }
    if (cancelButton) cancelButton.addEventListener('click', () => resetApprove(true));
    approveForm.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') resetApprove(true);
    });
    approveForm.addEventListener('submit', () => {
      approveForm.classList.add('is-submitting');
      if (confirmButton) confirmButton.disabled = true;
      if (confirmLabel) confirmLabel.textContent = approveForm.dataset.labelBusy || 'Aprovando…';
    });
  }

  /* ---------- Revelar formulário de rejeição ---------- */
  document.addEventListener('click', (event) => {
    const reveal = event.target.closest('[data-reveal]');
    if (reveal) {
      const panel = document.getElementById(reveal.dataset.reveal);
      if (!panel) return;
      resetApprove(false);
      panel.hidden = false;
      reveal.setAttribute('aria-expanded', 'true');
      const field = panel.querySelector('textarea, input');
      if (field) field.focus();
      return;
    }
    const dismiss = event.target.closest('[data-dismiss-reveal]');
    if (!dismiss) return;
    const panel = document.getElementById(dismiss.dataset.dismissReveal);
    if (!panel) return;
    panel.hidden = true;
    const toggle = document.querySelector(`[data-reveal="${panel.id}"]`);
    if (toggle) {
      toggle.setAttribute('aria-expanded', 'false');
      toggle.focus();
    }
  });

  /* ---------- Concluir job sem o relato obrigatório ---------- */
  // Sem "O que está sendo feito?" registrado no ciclo atual, concluir só mostra o
  // aviso de campo obrigatório e leva o cursor ao campo. Antes de bloquear,
  // confere no servidor: o relato pode ter sido registrado em outra aba.
  const concludeRequired = document.getElementById('conclude-required');
  const progressField = document.getElementById('body');
  document.querySelectorAll('form[data-conclude-blocked]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      if (!concludeRequired || form.dataset.relatoChecked === 'ok') return;
      event.preventDefault();
      // Clique duplo: ignora enquanto a primeira checagem ainda está em andamento.
      if (form.dataset.relatoChecking === '1') return;
      form.dataset.relatoChecking = '1';
      try {
        const response = await fetch(form.dataset.relatoUrl, { headers: { Accept: 'application/json' } });
        const data = response.ok ? await response.json() : null;
        if (data && data.hasProgressNote) {
          form.dataset.relatoChecked = 'ok';
          form.requestSubmit ? form.requestSubmit() : form.submit();
          return;
        }
      } catch {
        // Sem conexão: mantém o aviso; o servidor valida de novo no envio.
      } finally {
        delete form.dataset.relatoChecking;
      }
      concludeRequired.hidden = false;
      if (progressField) {
        progressField.focus({ preventScroll: true });
        progressField.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        concludeRequired.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  });

  /* ---------- Visualização de anexos ---------- */
  const previewDialog = document.getElementById('attachment-preview');
  if (previewDialog) {
    const previewBody = previewDialog.querySelector('[data-preview-body]');
    const previewTitle = previewDialog.querySelector('#preview-title');
    const closePreview = () => previewDialog.close();

    const openPreview = (trigger) => {
      if (!previewBody) return;
      const kind = trigger.dataset.previewKind;
      const name = trigger.dataset.previewName || 'Anexo';
      const url = trigger.dataset.previewUrl;
      if (!url) return;

      previewBody.replaceChildren();
      if (previewTitle) previewTitle.textContent = name;

      if (kind === 'image') {
        const image = document.createElement('img');
        image.className = 'preview-image';
        image.alt = name;
        image.src = url;
        previewBody.append(image);
      } else {
        const frame = document.createElement('iframe');
        frame.className = 'preview-frame';
        frame.title = name;
        frame.src = url;
        previewBody.append(frame);
      }
      if (!previewDialog.open) previewDialog.showModal();
    };

    document.addEventListener('click', (event) => {
      const trigger = event.target.closest('[data-preview-url]');
      if (trigger) {
        event.preventDefault();
        openPreview(trigger);
        return;
      }
      if (event.target.closest('[data-preview-close]')) closePreview();
    });
    previewDialog.addEventListener('click', (event) => {
      if (event.target === previewDialog) closePreview();
    });
    previewDialog.addEventListener('close', () => previewBody && previewBody.replaceChildren());
  }

  /* ---------- Upload de anexo por arrastar e soltar ---------- */
  document.querySelectorAll('[data-dropzone]').forEach((form) => {
    const input = form.querySelector('input[type="file"]');
    const fileLabel = form.querySelector('[data-dropzone-file]');
    if (!input) return;
    const showFile = () => {
      const file = input.files && input.files[0];
      if (!fileLabel) return;
      fileLabel.textContent = file ? file.name : '';
      fileLabel.hidden = !file;
    };
    input.addEventListener('change', showFile);

    ['dragenter', 'dragover'].forEach((type) => {
      form.addEventListener(type, (event) => {
        event.preventDefault();
        form.classList.add('is-dragging');
      });
    });
    form.addEventListener('dragleave', (event) => {
      if (!form.contains(event.relatedTarget)) form.classList.remove('is-dragging');
    });
    form.addEventListener('drop', (event) => {
      event.preventDefault();
      form.classList.remove('is-dragging');
      const dropped = event.dataTransfer && event.dataTransfer.files;
      if (!dropped || !dropped.length) return;
      const transfer = new DataTransfer();
      transfer.items.add(dropped[0]);
      input.files = transfer.files;
      showFile();
      // Soltar o arquivo já envia, sem precisar clicar em "Enviar anexo".
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
    });
  });

  /* ---------- Timers ao vivo (detail e drawer) ---------- */
  const pad = (value) => String(value).padStart(2, '0');
  const formatClock = (seconds) => {
    const safe = Math.max(0, Math.floor(seconds));
    return `${pad(Math.floor(safe / 3600))}:${pad(Math.floor((safe % 3600) / 60))}:${pad(safe % 60)}`;
  };
  window.setInterval(() => {
    document.querySelectorAll('[data-timer-seconds], [data-timer-total]').forEach((element) => {
      const key = element.dataset.timerSeconds !== undefined ? 'timerSeconds' : 'timerTotal';
      let seconds = Number(element.dataset[key] || 0);
      if (element.dataset.timerRunning === 'true') seconds += 1;
      element.dataset[key] = String(seconds);
      element.textContent = formatClock(seconds);
    });
  }, 1000);

  /* ---------- Sidebar mobile ---------- */
  const sidebar = document.getElementById('sidebar');
  const scrim = document.querySelector('.sidebar-scrim');
  const setSidebar = (open) => {
    if (!sidebar) return;
    sidebar.classList.toggle('is-open', open);
    if (scrim) scrim.classList.toggle('is-open', open);
  };

  document.querySelectorAll('[data-sidebar-toggle]').forEach((button) => {
    button.addEventListener('click', () => setSidebar(!sidebar.classList.contains('is-open')));
  });
  if (scrim) scrim.addEventListener('click', () => setSidebar(false));
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setSidebar(false);
  });

  /* ---------- Alternador Main table / Kanban ---------- */
  const viewButtons = Array.from(document.querySelectorAll('[data-view-toggle]'));
  const views = Array.from(document.querySelectorAll('[data-view]'));
  const VIEW_KEY = 'fuel.board.view';

  const applyView = (view) => {
    views.forEach((element) => {
      element.classList.toggle('is-hidden', element.dataset.view !== view);
    });
    viewButtons.forEach((button) => {
      const active = button.dataset.viewToggle === view;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  };

  if (viewButtons.length) {
    let stored = null;
    try {
      stored = window.localStorage.getItem(VIEW_KEY);
    } catch {
      stored = null;
    }
    applyView(stored === 'kanban' ? 'kanban' : 'table');

    viewButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const view = button.dataset.viewToggle;
        applyView(view);
        try {
          window.localStorage.setItem(VIEW_KEY, view);
        } catch {
          /* modo privado: segue sem persistir */
        }
      });
    });
  }

  /* ---------- Grupos recolhíveis ---------- */
  document.querySelectorAll('.board-table tbody.group').forEach((group) => {
    const button = group.querySelector('.group-inner');
    if (!button) return;
    button.addEventListener('click', () => {
      const collapsed = group.classList.toggle('is-collapsed');
      button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
  });

  /* ---------- Abas de papel no login (só apresentação) ---------- */
  const roleTabs = Array.from(document.querySelectorAll('[data-role-tab]'));
  const roleHint = document.querySelector('[data-role-hint]');
  const ROLE_HINTS = {
    admin: 'Cria e edita jobs, move etapas, gerencia clientes, agendamentos e usuários.',
    user: 'Acompanha os jobs dos clientes, comenta e anexa arquivos.',
  };
  roleTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      roleTabs.forEach((item) => {
        const active = item === tab;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      if (roleHint) roleHint.textContent = ROLE_HINTS[tab.dataset.roleTab] || roleHint.textContent;
    });
  });

  /* ---------- Drawer do item ---------- */
  const drawer = document.getElementById('item-drawer');
  const backdrop = document.querySelector('.drawer-backdrop');
  if (!drawer || !backdrop) return;

  let lastTrigger = null;
  let requestId = 0;

  const closeDrawer = () => {
    drawer.classList.remove('is-open');
    backdrop.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    if (lastTrigger) lastTrigger.focus();
    lastTrigger = null;
  };

  const openDrawer = async (id, trigger) => {
    const current = ++requestId;
    lastTrigger = trigger;
    drawer.hidden = false;
    backdrop.hidden = false;
    drawer.setAttribute('aria-hidden', 'false');
    drawer.classList.add('is-open');
    backdrop.classList.add('is-open');
    drawer.replaceChildren();

    const loading = document.createElement('div');
    loading.className = 'drawer';
    loading.innerHTML = '<div class="drawer-skeleton" role="status" aria-live="polite">Carregando item…</div>';
    drawer.append(loading);

    try {
      const response = await fetch(`/requisicoes/${encodeURIComponent(id)}/drawer`, {
        headers: { 'X-Requested-With': 'fetch' },
      });
      if (!response.ok) throw new Error('Falha ao carregar');
      const html = await response.text();
      if (current !== requestId) return;

      // HTML vem do próprio servidor (EJS com escape). Ainda assim, é
      // montado num documento inerte e importado como nó, sem executar script.
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      const node = parsed.body.firstElementChild;
      if (!node) throw new Error('Resposta vazia');
      drawer.replaceChildren(document.importNode(node, true));

      const closeButton = drawer.querySelector('[data-drawer-close]');
      if (closeButton) closeButton.focus();
    } catch {
      if (current !== requestId) return;
      const failure = document.createElement('div');
      failure.className = 'drawer';
      failure.innerHTML = '<p class="alert" role="alert">Não foi possível carregar o item.</p>';
      drawer.replaceChildren(failure);
      if (trigger) trigger.focus();
    }
  };

  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-drawer]');
    if (trigger) {
      // Ctrl/Cmd/Shift + clique continua abrindo o item completo em nova aba.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      openDrawer(trigger.dataset.drawer, trigger);
      return;
    }
    if (event.target.closest('[data-drawer-close]')) closeDrawer();
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drawer.classList.contains('is-open')) closeDrawer();
  });
});
