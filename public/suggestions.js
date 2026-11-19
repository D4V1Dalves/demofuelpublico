document.addEventListener('DOMContentLoaded', () => {
  const button = document.getElementById('generate-suggestions');
  const list = document.getElementById('suggestions-list');
  if (!button || !list) return;

  button.addEventListener('click', async () => {
    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = 'Gerando...';

    try {
      const response = await fetch(`/requisicoes/${button.dataset.jobId}/sugestoes`, { method: 'POST' });
      const data = await response.json();
      list.textContent = '';

      if (data.source === 'ai') {
        const badge = document.createElement('p');
        badge.className = 'muted small';
        badge.textContent = 'Sugestões geradas por IA';
        list.appendChild(badge);
      }

      const suggestions = data.suggestions || [];
      if (suggestions.length === 0) {
        list.textContent = 'Nenhuma sugestão encontrada.';
      }

      suggestions.forEach((suggestion) => {
        const item = document.createElement('div');
        item.className = 'suggestion';

        const text = document.createElement('p');
        text.textContent = suggestion.text;

        const origin = document.createElement('div');
        origin.className = 'muted small';
        origin.textContent = suggestion.jobTitle ? `Job similar: ${suggestion.jobTitle}` : 'IA';

        const insert = document.createElement('button');
        insert.type = 'button';
        insert.className = 'button secondary';
        insert.textContent = 'Inserir';
        insert.addEventListener('click', () => {
          const field = document.getElementById('body');
          if (!field) return;
          field.value = `${field.value ? `${field.value}\n` : ''}${suggestion.text}`;
          field.focus();
        });

        item.append(text, origin, insert);
        list.appendChild(item);
      });

      if (data.fallback) {
        const notice = document.createElement('p');
        notice.className = 'muted small';
        notice.textContent = data.fallback;
        list.appendChild(notice);
      }
    } catch {
      list.textContent = 'Não foi possível gerar sugestões.';
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  });
});
