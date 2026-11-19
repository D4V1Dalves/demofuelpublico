document.addEventListener('DOMContentLoaded', () => {
  const mine = new URLSearchParams(window.location.search).get('mine') === '1';
  const refreshKpis = async () => {
    const response = await fetch(`/dashboard/stats${mine ? '?mine=1' : ''}`);
    if (!response.ok) return;
    const stats = await response.json();
    const values = [stats.total, stats.abertas, stats.atrasadas, stats.concluidas];
    document.querySelectorAll('.kpis .kpi-number').forEach((element, index) => {
      if (values[index] !== undefined) element.textContent = String(values[index]);
    });
  };

  const countRows = (body) => body.querySelectorAll('.item-row:not(.is-empty)').length;

  const syncGroup = (body) => {
    if (!body) return;
    const count = body.querySelector('.group-count');
    if (count) count.textContent = String(countRows(body));

    const empty = body.querySelector('.item-row.is-empty');
    if (countRows(body) === 0 && !empty) {
      const row = document.createElement('tr');
      row.className = 'item-row is-empty';
      const cell = document.createElement('td');
      cell.className = 'col-item';
      cell.colSpan = 8;
      const text = document.createElement('span');
      text.className = 'cell-empty';
      text.textContent = 'Nenhum job nesta etapa';
      cell.appendChild(text);
      row.appendChild(cell);
      body.appendChild(row);
    } else if (countRows(body) > 0 && empty) {
      empty.remove();
    }
  };

  // Status editável direto na Main table, sem recarregar a página.
  document.querySelectorAll('[data-status-select]').forEach((select) => {
    select.addEventListener('change', async () => {
      const previous = select.dataset.currentStatus;
      const next = select.value;
      if (next === previous) return;

      const option = select.options[select.selectedIndex];
      const slug = option && option.dataset.slug;
      const row = select.closest('tr.item-row');
      const source = row && row.closest('tbody.group');
      const target = slug ? document.getElementById(`group-${slug}`) : null;

      select.disabled = true;
      try {
        const response = await fetch(`/requisicoes/${select.dataset.requestId}/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: next }),
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          select.value = previous;
          window.alert(data.error || 'Não foi possível alterar o status.');
          return;
        }

        select.className = `status-select status-${slug}`;
        select.dataset.currentStatus = next;

        if (row && source && target && source !== target) {
          target.appendChild(row);
          const empty = target.querySelector('.item-row.is-empty');
          if (empty) empty.remove();
          syncGroup(source);
          syncGroup(target);
          row.classList.add('is-updated');
          setTimeout(() => row.classList.remove('is-updated'), 900);
        }

        await refreshKpis();
      } catch (error) {
        select.value = previous;
        window.alert('Não foi possível alterar o status.');
      } finally {
        select.disabled = false;
      }
    });
  });

  const board = document.getElementById('board');
  if (!board) return;

  let draggedCard = null;

  const clearDropStyles = () => {
    board.querySelectorAll('.drop-target').forEach((column) => column.classList.remove('drop-target'));
    if (draggedCard) draggedCard.classList.remove('dragging');
  };

  const syncColumn = (body) => {
    if (!body) return;
    const column = body.closest('.column');
    const count = column && column.querySelector('.count');
    const cards = body.querySelectorAll('.req-card').length;
    if (count) count.textContent = String(cards);

    const empty = body.querySelector('.empty-column');
    if (cards === 0 && !empty) {
      const placeholder = document.createElement('p');
      placeholder.className = 'muted small empty-column';
      placeholder.textContent = 'Nenhum job';
      body.appendChild(placeholder);
    } else if (cards > 0 && empty) {
      empty.remove();
    }
  };

  board.querySelectorAll('.req-card.draggable').forEach((card) => {
    card.addEventListener('dragstart', (event) => {
      draggedCard = card;
      card.classList.add('dragging');
      event.dataTransfer.setData('text/plain', card.dataset.id);
      event.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      clearDropStyles();
      draggedCard = null;
    });
  });

  board.querySelectorAll('.column').forEach((column) => {
    column.addEventListener('dragover', (event) => {
      event.preventDefault();
      column.classList.add('drop-target');
      event.dataTransfer.dropEffect = 'move';
    });
    column.addEventListener('dragleave', (event) => {
      if (!column.contains(event.relatedTarget)) column.classList.remove('drop-target');
    });
    column.addEventListener('drop', async (event) => {
      event.preventDefault();
      column.classList.remove('drop-target');

      const id = event.dataTransfer.getData('text/plain') || (draggedCard && draggedCard.dataset.id);
      const status = column.dataset.status;
      if (!id || !status) return;

      const card = Array.from(board.querySelectorAll('.req-card')).find(
        (item) => item.dataset.id === String(id),
      );
      const sourceBody = card && card.closest('.column-body');
      const targetBody = column.querySelector('.column-body');

      const response = await fetch(`/requisicoes/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });

      if (!response.ok) {
        clearDropStyles();
        const data = await response.json().catch(() => ({}));
        window.alert(data.error || 'Não foi possível mover o job.');
        return;
      }

      if (card && targetBody && sourceBody !== targetBody) {
        targetBody.appendChild(card);
        card.dataset.status = status;
        const pill = card.querySelector('.status-pill');
        if (pill) {
          pill.className = `status-pill status-${column.dataset.slug || ''}`;
          pill.textContent = status;
        }
        syncColumn(sourceBody);
        syncColumn(targetBody);
      }
      clearDropStyles();
      draggedCard = null;
      await refreshKpis();
    });
  });
});
